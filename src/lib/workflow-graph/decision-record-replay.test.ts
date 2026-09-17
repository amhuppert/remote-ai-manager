import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
/**
 * The closeout replay proof for D4 R13.3.
 *
 * Every CONDITIONAL D4 decision — a guarded-edge resolution, a skip, an
 * expansion acceptance, an expansion refusal, a loop decision — has to stay
 * readable after the server that made it is gone, and the read surfaces have to
 * answer from those durable records ALONE. The individual slices each proved
 * their own half: routing settles (route-runtime), receipts commit
 * (expansion-service), loops re-derive across a crash (loop-crash-safety), and
 * the surfaces render (derive-graph, live-outline, loop-ledger). What none of
 * them proves is the join — that a surface handed nothing but a restarted
 * server's view still reports the decision.
 *
 * So every assertion here reads through {@link PersistenceFixture.recreateStore}
 * — a brand-new state store over the same SQLite database, which is what a
 * restarted process comes up with. The original store, its parsed-row cache and
 * every in-memory projection are deliberately out of reach: if a record only
 * lived in the writer's heap, the surface fed from this reader reports nothing
 * and the test fails.
 *
 * The last case is R13.3's other half: a pre-D4 execution's persisted log must
 * contain none of the D4 event kinds, so an upgraded server replaying an old
 * execution reads exactly the sequence the old one wrote.
 */

import { describe, expect, it } from "vitest";

import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  deriveContextProvenanceDisplay,
  deriveContextRouteRows,
  deriveContextSkipDisplay,
} from "@/components/workflow-graph/derive-graph";
import { runEngineScenario } from "@/lib/workflow-graph/compat/engine-harness";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import { EXPANSION_CAPS } from "./expansion-caps";
import {
  createGraphWorkflowExpansionService,
  graphExpansionRequestSchema,
  type GraphExpansionRequest,
} from "./expansion-service";
import { projectLiveOutline } from "./live-outline";
import { deriveLoopLedger, resolveLoopPassMembership } from "./loop-ledger";
import {
  NOW,
  P1_JUDGE,
  P1_WORKER,
  P2_WORKER,
  completeContext,
  executionFor,
  makeLiveEditDeps,
  runPass,
  workerJudgeDefinition,
} from "./loop-test-fixtures";
import {
  createWorkflowExecution,
  makeImplementerAssignment,
} from "./test-fixtures";
import type { GraphWorkflowExecution } from "./schemas";
import type { WorkflowSemanticDefinition } from "./definition-schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { StateStore } from "@/lib/state-store/store";

const PROJECT_PATH = "/projects/demo";
const SESSION_NAME = "session-1";
const EXECUTION_ID = "execution-1";
const INVOKER = "context-plan";
const CONVERSATION_ID = "conversation-7";

/** Deep enough to cover every decision the log can carry in these fixtures. */
const EVENT_TAIL_LIMIT = 500;

/** The four kinds D4 added. A pre-D4 execution must emit none of them. */
const D4_EVENT_KINDS = [
  "graph-workflow-route-resolved",
  "graph-workflow-context-skipped",
  "graph-workflow-graph-expanded",
  "graph-workflow-loop-decision",
] as const;

async function persistedEventKinds(
  store: StateStore,
  projectPath: string,
  sessionName: string,
  executionId: string,
): Promise<string[]> {
  const rows = await store.getGraphWorkflowEventsTail(
    projectPath,
    sessionName,
    executionId,
    EVENT_TAIL_LIMIT,
  );
  return rows.map((row) => row.event.type);
}

// ---------------------------------------------------------------------------
// Routing and skips, through the real engine
// ---------------------------------------------------------------------------

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

function classifyDefinition(): WorkflowSemanticDefinition {
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
          description: "The route algebra under replay",
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
    ],
    tasks: ["ctx-classify", "ctx-fix", "ctx-ship"].map((id) => ({
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
    ],
  });
}

describe("R13.3 — routing decisions replay from durable records", () => {
  it("re-reads the guarded resolution and the skip from a restarted server, and the surfaces derive from those alone", async () => {
    await runEngineScenario(
      {
        name: "replay-classify",
        definition: classifyDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        capture: ({ contextId }) =>
          contextId === "ctx-classify" ? { verdict: "fix" } : null,
      },
      async (run) => {
        expect(run.settled.status).toBe("completed");

        // The restart: a fresh store over the same database. Nothing the
        // writing process held in memory is reachable from here.
        const restarted = run.restartedStore();
        const reloaded = await restarted.getActiveGraphWorkflowExecution(
          run.projectPath,
          run.sessionName,
        );
        expect(reloaded).not.toBeNull();
        if (!reloaded) return;

        // The authoritative markers survived.
        expect(reloaded.routeSettlements["ctx-classify"]).toMatchObject({
          activatedEdgeIds: ["ctx-classify__ctx-fix"],
          inactiveEdgeIds: ["ctx-classify__ctx-ship"],
        });
        expect(reloaded.contextStates["ctx-ship"]?.status).toBe("skipped");

        // The UI derivation, fed nothing but the reloaded record.
        expect(deriveContextRouteRows(reloaded, "ctx-fix")).toEqual([
          {
            edgeId: "ctx-classify__ctx-fix",
            logicalSourceId: "ctx-classify",
            effectiveSourceId: "ctx-classify",
            guard: "schema",
            resolution: "active",
          },
        ]);
        expect(deriveContextRouteRows(reloaded, "ctx-ship")).toEqual([
          {
            edgeId: "ctx-classify__ctx-ship",
            logicalSourceId: "ctx-classify",
            effectiveSourceId: "ctx-classify",
            guard: "schema",
            resolution: "inactive",
          },
        ]);
        expect(deriveContextSkipDisplay(reloaded, "ctx-ship")).toMatchObject({
          decidingEdgeIds: ["ctx-classify__ctx-ship"],
        });

        // The CLI derivation, from the same reloaded record.
        const outline = projectLiveOutline(reloaded, { kind: "outline" });
        expect(outline.ok).toBe(true);
        if (!outline.ok || outline.section !== "outline") return;
        expect(outline.outline.routes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "ctx-classify__ctx-ship",
              guard: "schema",
              resolution: "inactive",
            }),
          ]),
        );
        expect(
          outline.outline.contexts.find((c) => c.id === "ctx-ship")?.skip
            ?.edgeEvaluations,
        ).toEqual([{ edgeId: "ctx-classify__ctx-ship", verdict: "inactive" }]);

        // And the decision ledger itself replays out of graph_workflow_events.
        const kinds = await persistedEventKinds(
          restarted,
          run.projectPath,
          run.sessionName,
          reloaded.id,
        );
        expect(kinds).toContain("graph-workflow-route-resolved");
        expect(kinds).toContain("graph-workflow-context-skipped");
      },
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Expansion acceptances and refusals, over real SQLite
// ---------------------------------------------------------------------------

function expansionRequest(
  overrides: Partial<GraphExpansionRequest> = {},
): GraphExpansionRequest {
  return graphExpansionRequestSchema.parse({
    requestId: "req-accepted",
    rationale: "Fan out one candidate so the filter has something to choose.",
    contexts: [
      {
        handle: "candidate-a",
        title: "Candidate A",
        acceptanceCriteria: "Candidate A is implemented and self-checked",
        placement: {
          lane: "candidate-a",
          mode: "owned",
          ownedPaths: ["src/candidate-a"],
        },
      },
    ],
    tasks: [
      {
        contextHandle: "candidate-a",
        title: "Build candidate A",
        instructions: "Implement approach A end to end and run its tests.",
      },
    ],
    edges: [{ from: INVOKER, to: "candidate-a" }],
    ...overrides,
  });
}

/** More contexts than one request may carry — a deterministic, durable refusal. */
function overCapRequest(): GraphExpansionRequest {
  const count = EXPANSION_CAPS.contextsPerRequest + 1;
  const handles = Array.from({ length: count }, (_, i) => `over-${i}`);
  return graphExpansionRequestSchema.parse({
    requestId: "req-refused",
    rationale: "Deliberately past the per-request context cap.",
    contexts: handles.map((handle) => ({
      handle,
      title: `Over ${handle}`,
      acceptanceCriteria: `${handle} is done`,
      placement: { lane: handle, mode: "full" },
    })),
    tasks: handles.map((handle) => ({
      contextHandle: handle,
      title: `Work ${handle}`,
      instructions: `Do the work for ${handle}.`,
    })),
    edges: handles.map((handle) => ({ from: INVOKER, to: handle })),
  });
}

function expandingExecution(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ status: "running" });
  const plan = execution.workingDefinition.executionContexts.find(
    (context) => context.id === INVOKER,
  );
  if (plan) {
    plan.mutability = { allowAgentTaskAdd: true, allowAgentContextAdd: true };
  }
  execution.activeContextIds = [INVOKER];
  const planState = execution.contextStates[INVOKER];
  if (planState) {
    planState.status = "running";
    planState.iterationCount = 1;
  }
  const planTask = execution.taskStates["task-plan-1"];
  if (planTask) {
    planTask.status = "running";
    planTask.lastConversationId = CONVERSATION_ID;
  }
  return execution;
}

describe("R13.3 — expansion decisions replay from durable records", () => {
  it("re-reads both ledgers from a restarted server, with node provenance and the CLI block derived from them alone", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        now: () => NOW,
      });
      const repository = createGraphWorkflowExecutionRepository({
        getGraphWorkflowPendingArtifacts: async () => null,
        clearGraphWorkflowPendingArtifacts: async () => false,

        // No git worktree in this harness; the real exclusion would shell out.
        ensureCcArtifactsExcluded: async () => {},
        getSession: (projectPath, sessionName) =>
          fixture.store.getSession(projectPath, sessionName),
        getActiveGraphWorkflowExecution:
          fixture.store.getActiveGraphWorkflowExecution,
        mutateActiveGraphWorkflowExecution:
          fixture.store.mutateActiveGraphWorkflowExecution,
        reserveActiveGraphWorkflowExecution:
          fixture.store.reserveActiveGraphWorkflowExecution,
        archiveActiveGraphWorkflowExecution:
          fixture.store.archiveActiveGraphWorkflowExecution,

        eventPublisher,
      });

      // Install the running execution the way any writer does.
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "replay-seed",
        () => ({
          kind: "commit",
          value: undefined,
          ...{ execution: expandingExecution(), events: [] },
        }),
      );

      const service = createGraphWorkflowExpansionService({
        executionContract: createTestGraphExecutionContract(),
        getActiveExecution: fixture.store.getActiveGraphWorkflowExecution,
        mutateActive: repository.mutateActive,
        buildLiveEditDeps: () => Promise.resolve(makeLiveEditDeps()),
        publishLiveEditApplied: eventPublisher.publishLiveEditApplied,
        publishGraphExpansion: eventPublisher.publishGraphExpansion,
        deliver: eventPublisher.deliver,
        now: () => NOW,
      });

      const accepted = await service.expand({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: EXECUTION_ID,
        contextId: INVOKER,
        conversationId: CONVERSATION_ID,
        request: expansionRequest(),
      });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      const [candidateId] = accepted.createdContextIds;
      expect(candidateId).toBeDefined();

      const refused = await service.expand({
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        executionId: EXECUTION_ID,
        contextId: INVOKER,
        conversationId: CONVERSATION_ID,
        request: overCapRequest(),
      });
      expect(refused.ok).toBe(false);

      // Restart.
      const restarted = fixture.recreateStore();
      const reloaded = await restarted.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded).not.toBeNull();
      if (!reloaded || !candidateId) return;

      expect(reloaded.expansionReceipts.accepted).toMatchObject([
        {
          requestId: "req-accepted",
          invokerContextId: INVOKER,
          addedContextIds: [candidateId],
        },
      ]);
      expect(reloaded.expansionReceipts.refusals).toMatchObject([
        {
          requestId: "req-refused",
          invokerContextId: INVOKER,
          refusalCode: "expansion-cap-contexts-per-request",
        },
      ]);

      // Node provenance derives from the reloaded ledger, not from a live
      // in-memory index of what this process added.
      expect(
        deriveContextProvenanceDisplay(reloaded, candidateId),
      ).toMatchObject({ requestId: "req-accepted", invokerContextId: INVOKER });
      expect(deriveContextProvenanceDisplay(reloaded, INVOKER)).toBeNull();

      const outline = projectLiveOutline(reloaded, { kind: "outline" });
      expect(outline.ok).toBe(true);
      if (!outline.ok || outline.section !== "outline") return;
      expect(outline.outline.expansions.accepted).toMatchObject([
        { requestId: "req-accepted", addedContextIds: [candidateId] },
      ]);
      expect(outline.outline.expansions.refusals).toMatchObject([
        {
          requestId: "req-refused",
          refusalCode: "expansion-cap-contexts-per-request",
        },
      ]);

      // Both attempts are in the durable log, acceptance and refusal alike.
      const rows = await restarted.getGraphWorkflowEventsTail(
        PROJECT_PATH,
        SESSION_NAME,
        reloaded.id,
        EVENT_TAIL_LIMIT,
      );
      const expansions = rows
        .map((row) => row.event)
        .filter((event) => event.type === "graph-workflow-graph-expanded");
      expect(expansions.map((event) => event.outcome)).toEqual([
        "accepted",
        "refused",
      ]);
    } finally {
      fixture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Loop decisions, over real SQLite
// ---------------------------------------------------------------------------

describe("R13.3 — loop decisions replay from durable records", () => {
  it("re-reads the pass ledger from a restarted server, with membership and the CLI block derived from it alone", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject(PROJECT_PATH);
      fixture.seedSession(PROJECT_PATH, SESSION_NAME);

      const eventPublisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: () => {},
        now: () => NOW,
      });
      const repository = createGraphWorkflowExecutionRepository({
        getGraphWorkflowPendingArtifacts: async () => null,
        clearGraphWorkflowPendingArtifacts: async () => false,

        // No git worktree in this harness; the real exclusion would shell out.
        ensureCcArtifactsExcluded: async () => {},
        getSession: () =>
          Promise.resolve({ sessionName: SESSION_NAME } as SessionState),
        getActiveGraphWorkflowExecution:
          fixture.store.getActiveGraphWorkflowExecution,
        mutateActiveGraphWorkflowExecution:
          fixture.store.mutateActiveGraphWorkflowExecution,
        reserveActiveGraphWorkflowExecution:
          fixture.store.reserveActiveGraphWorkflowExecution,
        archiveActiveGraphWorkflowExecution:
          fixture.store.archiveActiveGraphWorkflowExecution,

        eventPublisher,
      });

      const definition = workerJudgeDefinition();
      const seeded = executionFor(definition);
      await fixture.store.mutateActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "replay-seed",
        () => ({
          kind: "commit",
          value: undefined,
          ...{ execution: seeded, events: [] },
        }),
      );

      // The seed activates the loop and materializes pass 1; pass 1's judge then
      // fails the exit predicate, so the second settlement decides "continue"
      // and unrolls pass 2 — the decision record the ledger is built from. The
      // commit goes through the production repository, so its loop-decision
      // event is derived from the marker diff and appended in the same write.
      await repository
        .mutateActive(PROJECT_PATH, SESSION_NAME, (execution) => {
          let working = structuredClone(execution);
          completeContext(working, "seed");
          working = runPass(working).execution;
          completeContext(working, P1_WORKER);
          completeContext(working, P1_JUDGE, { verdict: "fail" });
          return changed(runPass(working).execution);
        })
        .then((mutation) => mutation.execution);

      const restarted = fixture.recreateStore();
      const reloaded = await restarted.getActiveGraphWorkflowExecution(
        PROJECT_PATH,
        SESSION_NAME,
      );
      expect(reloaded).not.toBeNull();
      if (!reloaded) return;

      const loopState = reloaded.loopStates["refine"];
      expect(loopState).toBeDefined();
      expect(loopState?.decisions["1"]).toMatchObject({
        pass: 1,
        verdict: "unsatisfied",
        outcome: "materialized",
        nextPass: 2,
      });

      // Membership badging, derived from the reloaded markers alone.
      expect(
        resolveLoopPassMembership({
          contextId: P2_WORKER,
          loopGroups: (definition.loopGroups ?? []).map((group) => ({
            id: group.id,
            maxPasses: group.maxPasses,
          })),
          loopStates: reloaded.loopStates,
        }),
      ).toMatchObject({ loopGroupId: "refine", pass: 2 });

      // The ledger the inspector and the CLI share, over the restarted
      // server's event log plus its reloaded markers.
      const rows = await restarted.getGraphWorkflowEventsTail(
        PROJECT_PATH,
        SESSION_NAME,
        reloaded.id,
        EVENT_TAIL_LIMIT,
      );
      const ledger = deriveLoopLedger({
        loopStates: reloaded.loopStates,
        events: rows,
        loopGroups: (definition.loopGroups ?? []).map((group) => ({
          id: group.id,
          maxPasses: group.maxPasses,
        })),
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.loopGroupId).toBe("refine");
      expect(ledger[0]?.decisions).toMatchObject([
        { pass: 1, verdict: "unsatisfied", outcome: "materialized" },
      ]);

      const outline = projectLiveOutline(reloaded, { kind: "outline" });
      expect(outline.ok).toBe(true);
      if (!outline.ok || outline.section !== "outline") return;
      expect(outline.outline.loops).toMatchObject([
        { loopGroupId: "refine", passCount: 2 },
      ]);

      expect(rows.map((row) => row.event.type)).toContain(
        "graph-workflow-loop-decision",
      );
    } finally {
      fixture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The other half of R13.3: a pre-D4 execution emits no new event kinds
// ---------------------------------------------------------------------------

describe("R13.3 — a pre-D4 execution's durable log carries no D4 event kind", () => {
  it("persists none of the four D4 kinds for an unguarded, loop-free, expansion-disabled run", async () => {
    const definition = classifyDefinition();
    const preD4: WorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "ctx-classify"
          ? { ...context, outputSchema: undefined }
          : context,
      ),
      edges: definition.edges.map((edge) => ({
        id: edge.id,
        sourceContextId: edge.sourceContextId,
        targetContextId: edge.targetContextId,
      })),
    };

    await runEngineScenario(
      {
        name: "replay-pre-d4",
        definition: preD4,
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
      },
      async (run) => {
        expect(run.settled.status).toBe("completed");
        const restarted = run.restartedStore();
        const kinds = await persistedEventKinds(
          restarted,
          run.projectPath,
          run.sessionName,
          run.settled.id,
        );
        expect(kinds.length).toBeGreaterThan(0);
        for (const d4Kind of D4_EVENT_KINDS) {
          expect(kinds).not.toContain(d4Kind);
        }
      },
    );
  }, 60_000);
});
