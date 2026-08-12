import { describe, expect, it } from "vitest";

import { workflowSemanticDefinitionSchema } from "../definition-schemas";
import { runEngineScenario } from "./engine-harness";

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
              model: "opus",
              reasoningEffort: "high",
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
