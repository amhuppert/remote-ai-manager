import { describe, expect, it } from "vitest";

import { runEngineScenario } from "@/lib/workflow-graph/compat/engine-harness";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { isResumableHalt } from "@/lib/workflow-graph/lifecycle-classifier";
import { makeImplementerAssignment } from "@/lib/workflow-graph/test-fixtures";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";

/**
 * The end-to-end proof R4.1 asks for, on the REAL engine: an execution that
 * skips a branch still completes, its final publish carries only the branch that
 * ran, and the skip survives the restart path.
 *
 * Everything that decides routing here is production code — the loop's
 * settlement pass, the scheduler, lane readiness, the joins, the completion
 * invariant, the typed-event publisher, and the execution repository over real
 * SQLite. Only the agent turn, the validator verdict and the git side effects
 * are faked, and none of them decides a route.
 */

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
} as const;

const AGENT = {
  backend: "claude",
  modelSelection: {
    modelId: "sonnet",
    parameters: { effort: "medium" },
  },
} as const;

/**
 * Classify-and-act: a classifier banks a verdict, two guarded branches read it,
 * and a fan-in converges. The fan-in is what makes this a RIPPLE test rather
 * than a single-skip one — it has to run on one omitted edge plus one active
 * edge, and its own descendant has to survive both branches being declined.
 */
function classifyAndActDefinition(): WorkflowSemanticDefinition {
  const context = (id: string, title: string, extra: object = {}) => ({
    id,
    title,
    description: title,
    acceptanceCriteria: `${title} is done`,
    placement: { lane: id, mode: "full" as const },
    implementer: makeImplementerAssignment(AGENT),
    mutability: { allowAgentTaskAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 4, continuity: { enabled: true } },
    ...extra,
  });

  return workflowSemanticDefinitionSchema.parse({
    schemaVersion: 1,
    workflowConfig: {},
    charter: {
      mission: "Route a classifier verdict to exactly one branch",
      sourcesOfTruth: [
        {
          rank: 1,
          id: "d4-routing",
          label: "D4 routing",
          type: "document",
          locator: "src/lib/workflow-graph/route-projection.ts",
          description: "The route algebra under test",
          accessPolicy: "worktree-relative",
        },
      ],
    },
    parameters: [],
    prerequisites: [],
    executionContexts: [
      context("ctx-classify", "Classify", { outputSchema: VERDICT_SCHEMA }),
      context("ctx-fix", "Fix branch"),
      context("ctx-ship", "Ship branch"),
      context("ctx-report", "Report"),
    ],
    tasks: ["ctx-classify", "ctx-fix", "ctx-ship", "ctx-report"].map((id) => ({
      id: `task-${id}`,
      contextId: id,
      order: 1,
      title: `Work for ${id}`,
      instructions: `Do the work for ${id}.`,
      source: "user",
    })),
    edges: [
      {
        id: "ctx-classify__ctx-fix",
        sourceContextId: "ctx-classify",
        targetContextId: "ctx-fix",
        when: {
          schema: {
            type: "object",
            properties: { verdict: { const: "fix" } },
            required: ["verdict"],
          },
        },
      },
      {
        id: "ctx-classify__ctx-ship",
        sourceContextId: "ctx-classify",
        targetContextId: "ctx-ship",
        when: {
          schema: {
            type: "object",
            properties: { verdict: { const: "ship" } },
            required: ["verdict"],
          },
        },
      },
      {
        id: "ctx-fix__ctx-report",
        sourceContextId: "ctx-fix",
        targetContextId: "ctx-report",
      },
      {
        id: "ctx-ship__ctx-report",
        sourceContextId: "ctx-ship",
        targetContextId: "ctx-report",
      },
    ],
  });
}

describe("skip ripple, end to end (D4 R4.1)", () => {
  it("completes an execution whose untaken branch was skipped, and publishes only the branch that ran", async () => {
    await runEngineScenario(
      {
        name: "classify-and-act",
        definition: classifyAndActDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        capture: ({ contextId }) =>
          contextId === "ctx-classify" ? { verdict: "fix" } : null,
      },
      async ({
        settled,
        events,
        manager,
        repository,
        projectPath,
        sessionName,
      }) => {
        expect(settled.status).toBe("completed");
        expect(settled.haltReason).toBeNull();

        // The guard picked `fix`; `ship` is terminal-skipped with the complete
        // verdict set of its incoming edges, not just the vetoing one.
        expect(settled.contextStates["ctx-fix"]?.status).toBe("completed");
        expect(settled.contextStates["ctx-ship"]?.status).toBe("skipped");
        expect(
          settled.contextStates["ctx-ship"]?.skipReason?.edgeEvaluations,
        ).toEqual([{ edgeId: "ctx-classify__ctx-ship", verdict: "inactive" }]);

        // The ripple stops at the fan-in: one edge omitted, one active, so the
        // report still runs. A conjunctive rule that treated the omitted edge
        // as unmet would strand it here forever.
        expect(settled.contextStates["ctx-report"]?.status).toBe("completed");

        // The routing decision is reconstructible from durable state alone.
        expect(settled.routeSettlements["ctx-classify"]).toMatchObject({
          sourceContextId: "ctx-classify",
          captureIteration: 1,
          routeControlRevision: 0,
          activatedEdgeIds: ["ctx-classify__ctx-fix"],
          inactiveEdgeIds: ["ctx-classify__ctx-ship"],
        });
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "graph-workflow-context-skipped",
            subject: "ctx-ship",
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "graph-workflow-route-resolved",
            subject: "ctx-classify",
          }),
        );

        // The final publish carries the lanes that ran and nothing else: a
        // skipped context contributes no merge input (R4).
        const finalPublish = Object.values(settled.joins).filter(
          (join) => join.kind === "final_publish",
        );
        expect(finalPublish).toHaveLength(1);
        expect(finalPublish[0]?.status).toBe("succeeded");
        expect(finalPublish[0]?.sourceLaneIds).not.toContain("ctx-ship");

        // And the completion invariant let the run finish while the skipped
        // context's single task sat forever incomplete.
        expect(settled.contextStates["ctx-ship"]?.completedTaskCount).toBe(0);
        expect(settled.contextStates["ctx-ship"]?.totalTaskCount).toBe(1);

        // Restart: the skip is durable, not an in-memory verdict recomputed on
        // every boot. Reloading through the repository — real SQLite, same
        // database — must return the same terminal state.
        const reloaded = await repository.getActive(projectPath, sessionName);
        expect(reloaded?.contextStates["ctx-ship"]?.status).toBe("skipped");
        expect(
          reloaded?.contextStates["ctx-ship"]?.skipReason?.edgeEvaluations,
        ).toEqual([{ edgeId: "ctx-classify__ctx-ship", verdict: "inactive" }]);
        expect(reloaded?.routeSettlements["ctx-classify"]).toBeDefined();

        const normalized = await manager.normalizeAfterRestart(
          projectPath,
          sessionName,
        );
        expect(normalized?.contextStates["ctx-ship"]?.status).toBe("skipped");
        expect(
          normalized?.contextStates["ctx-ship"]?.skipReason,
        ).not.toBeNull();
      },
    );
  }, 60_000);

  it("skips the whole downstream when no branch is taken", async () => {
    await runEngineScenario(
      {
        name: "classify-and-act-no-match",
        definition: classifyAndActDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        capture: ({ contextId }) =>
          contextId === "ctx-classify" ? { verdict: "neither" } : null,
      },
      async ({ settled }) => {
        expect(settled.status).toBe("completed");
        expect(settled.contextStates["ctx-fix"]?.status).toBe("skipped");
        expect(settled.contextStates["ctx-ship"]?.status).toBe("skipped");
        // Recursive: every predecessor path of the fan-in was skipped, so the
        // fan-in itself is skipped rather than left waiting forever.
        expect(settled.contextStates["ctx-report"]?.status).toBe("skipped");
        expect(
          settled.contextStates["ctx-report"]?.skipReason?.edgeEvaluations,
        ).toEqual([
          { edgeId: "ctx-fix__ctx-report", verdict: "omitted" },
          { edgeId: "ctx-ship__ctx-report", verdict: "omitted" },
        ]);
      },
    );
  }, 60_000);

  it("halts the execution with a typed resumable routing halt when the guard set under-selects (R3.1)", async () => {
    const definition = classifyAndActDefinition();
    const withPolicy: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx-classify"
          ? { ...context, routing: { cardinality: "exactlyOne" as const } }
          : context,
      ),
    };

    await runEngineScenario(
      {
        name: "classify-and-act-cardinality",
        definition: withPolicy,
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        capture: ({ contextId }) =>
          contextId === "ctx-classify" ? { verdict: "neither" } : null,
      },
      async ({ settled }) => {
        expect(settled.status).toBe("halted");
        expect(settled.haltReason).toMatchObject({
          type: "routing_cardinality",
          contextId: "ctx-classify",
          policy: "exactlyOne",
          outcome: "under-selection",
          activatedEdgeIds: [],
        });
        expect(isResumableHalt(settled.haltReason!)).toBe(true);

        // A halt applies nothing: neither branch was skipped on the way to it.
        expect(settled.contextStates["ctx-fix"]?.status).toBe("pending");
        expect(settled.contextStates["ctx-ship"]?.status).toBe("pending");
      },
    );
  }, 60_000);
});
