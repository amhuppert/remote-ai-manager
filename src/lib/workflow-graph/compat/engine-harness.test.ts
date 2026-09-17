import { describe, expect, it } from "vitest";

import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import { runEngineScenario } from "./engine-harness";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";

const CONTEXT_ID = "context-collision";
const LEFT_SEAT = "left";
const RIGHT_SEAT = "right";

function collisionDefinition() {
  return workflowSemanticDefinitionSchema.parse({
    charter: {
      mission: "Exercise independent validator-attempt sequences.",
      sourcesOfTruth: [
        {
          rank: 1,
          id: "fixture",
          label: "Fixture",
          type: "other",
          locator: "engine-harness.test.ts",
          description: "The deterministic compatibility scenario.",
          accessPolicy: "worktree-relative",
        },
      ],
    },
    executionContexts: [
      {
        id: CONTEXT_ID,
        title: "Exercise both seats",
        acceptanceCriteria: "Both seats independently review two revisions.",
        placement: { lane: "collision", mode: "full" },
        contextValidator: {
          enabled: true,
          assignments: [LEFT_SEAT, RIGHT_SEAT].map((id) => ({
            id,
            profile: { tier: "builtin", id: "general-reviewer" },
            strategy: "conversation",
            authority: "blocking",
            agent: {
              backend: "claude",
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "high" },
              },
            },
          })),
        },
      },
    ],
    tasks: [
      {
        id: "task-collision",
        contextId: CONTEXT_ID,
        order: 1,
        title: "Produce the candidate",
        instructions: "Complete the candidate for both validator seats.",
      },
    ],
    edges: [],
  });
}

describe("engine harness validator-attempt accounting", () => {
  it("persists one task completion with its actual lane conversation and one matching event", async () => {
    let conversationId: string | undefined;
    await runEngineScenario(
      {
        name: "task-completion-evidence",
        definition: collisionDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        onAgentTurn: async (input) => {
          conversationId = input.conversationId;
        },
      },
      async (run) => {
        const store = run.restartedStore();
        const persisted = await store.getActiveGraphWorkflowExecution(
          run.projectPath,
          run.sessionName,
        );
        expect(conversationId).toBeDefined();
        expect(persisted?.taskStates["task-collision"]).toMatchObject({
          status: "completed",
          lastConversationId: conversationId,
          summary: "Completed task-collision",
        });
        const events = await store.getGraphWorkflowEventsTail(
          run.projectPath,
          run.sessionName,
          run.settled.id,
          100,
        );
        const completions = events.filter(
          (row) =>
            row.event.type === "graph-workflow-task-status" &&
            row.event.status === "completed",
        );
        expect(completions).toHaveLength(1);
        expect(completions[0]?.event).toMatchObject({
          taskId: "task-collision",
          lastConversationId: conversationId,
          completedAt: persisted?.taskStates["task-collision"]?.completedAt,
        });
      },
    );
  });

  it("enforces the production task-completion contract before persisting task or completion events", async () => {
    await runEngineScenario(
      {
        name: "task-completion-contract",
        definition: collisionDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
      },
      async (run) => {
        const store = run.restartedStore();
        const persisted = await store.getActiveGraphWorkflowExecution(
          run.projectPath,
          run.sessionName,
        );
        expect(persisted?.taskStates["task-collision"]?.status).not.toBe(
          "completed",
        );
        expect(persisted?.taskStates["task-collision"]?.completedAt).toBeNull();
        expect(run.settled.status).toBe("halted");
        expect(
          run.events.filter(
            (event) =>
              event.kind === "graph-workflow-task-status" &&
              event.detail === "completed",
          ),
        ).toEqual([]);
      },
      {
        executionContract: {
          ...createTestGraphExecutionContract(),
          validateTaskCompletion: () => ({
            ok: false,
            code: "task-evidence-required",
            issues: [
              {
                code: "task-evidence-required",
                message: "Persist task evidence before completion",
              },
            ],
            instruction: "Provide task evidence",
          }),
        },
      },
    );
  });

  it("keeps delimiter-colliding runtime identities independent through runEngineScenario", async () => {
    const attempts = new Map<string, number[]>();
    let mappedIdentities = 0;

    await runEngineScenario(
      {
        name: "validator-attempt-identity-collision",
        definition: collisionDefinition(),
        sessionLaneEnabled: false,
        agent: () => "complete-next-task",
        validator: (seat) => {
          const observed = attempts.get(seat.assignmentId) ?? [];
          observed.push(seat.attempt);
          attempts.set(seat.assignmentId, observed);

          if (seat.attempt > 1) return { verdict: "pass" };
          const task = Object.values(seat.execution.taskStates).find(
            (state) => state.contextId === seat.contextId,
          );
          expect(task).toBeDefined();
          return {
            verdict: "fail",
            reopenTaskIds: task === undefined ? [] : [task.taskId],
          };
        },
      },
      async (run) => {
        expect(run.settled.status).toBe("completed");
      },
      {
        validationAttemptIdentity: ({ assignmentId }) => {
          mappedIdentities += 1;
          return assignmentId === LEFT_SEAT
            ? ["context\u0000one", "validator"]
            : ["context", "one\u0000validator"];
        },
      },
    );

    expect(mappedIdentities).toBe(4);
    expect(attempts.get(LEFT_SEAT)).toEqual([1, 2]);
    expect(attempts.get(RIGHT_SEAT)).toEqual([1, 2]);
  }, 120_000);
});

describe("shared engine worktree preflight", () => {
  it("persists an IO halt without provisioning or dispatch when inspection fails", async () => {
    await runEngineScenario(
      {
        name: "inspection-failure",
        definition: collisionDefinition(),
        sessionLaneEnabled: false,
        agent: () => {
          throw new Error("Agent must not run before inspection");
        },
      },
      async (run) => {
        expect(run.settled.status).toBe("halted");
        expect(run.settled.haltReason).toMatchObject({
          type: "execution_loop_failed",
          cause: "io",
          message: "filesystem unavailable",
        });
        expect(
          Object.values(run.settled.contextStates).every(
            (state) =>
              state.consecutiveFailureCount === 0 &&
              state.worktreePath === null,
          ),
        ).toBe(true);
        const persisted = await run
          .restartedStore()
          .getActiveGraphWorkflowExecution("/compat-repo", "session-1");
        expect(persisted?.haltReason).toMatchObject({
          type: "execution_loop_failed",
          cause: "io",
        });
      },
      {
        getSessionWorktreeDirtyPaths: async () => {
          throw new Error("filesystem unavailable");
        },
      },
    );
  });
});
