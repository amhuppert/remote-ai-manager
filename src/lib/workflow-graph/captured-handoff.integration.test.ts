import { describe, expect, it } from "vitest";
import { runEngineScenario } from "./compat/engine-harness";
import { context, edge, task } from "./loop-test-fixtures";
import {
  createWorkflowDefinition,
  makeValidatorAssignment,
} from "./test-fixtures";

describe("semantic validation of the downstream handoff", () => {
  it("rejects an incomplete capture and publishes precisely the replacement the reviewer accepted", async () => {
    const reviewed: unknown[] = [];
    const publishedDuringReview: unknown[] = [];
    const consumed: unknown[] = [];
    let captures = 0;
    const accepted = {
      issueIds: ["issue-1"],
      instructions:
        "Recheck issue-1 against the approved revision before changing the route",
    };
    await runEngineScenario(
      {
        name: "captured-handoff",
        sessionLaneEnabled: false,
        definition: createWorkflowDefinition({
          executionContexts: [
            context("review", {
              outputSchema: {
                type: "object",
                properties: {
                  issueIds: { type: "array", items: { type: "string" } },
                  instructions: { type: "string" },
                },
                required: ["issueIds", "instructions"],
              },
              contextValidator: {
                enabled: true,
                assignments: [
                  makeValidatorAssignment({
                    id: "handoff-reviewer",
                    authority: "blocking",
                  }),
                ],
              },
            }),
            context("consume"),
          ],
          tasks: [
            task("review-task", "review"),
            task("consume-task", "consume"),
          ],
          edges: [edge("handoff", "review", "consume")],
        }),
        agent: () => "complete-next-task",
        outputCapture: () =>
          ++captures === 1
            ? { issueIds: [], instructions: "Recheck" }
            : accepted,
        validator: ({ contextId, execution, attempt }) => {
          if (contextId !== "review") return { verdict: "pass" };
          reviewed.push(
            execution.contextStates.review?.validationRound?.outputCandidate
              ?.value,
          );
          publishedDuringReview.push(execution.contextOutputs.review);
          return attempt === 1
            ? { verdict: "fail", reopenTaskIds: ["review-task"] }
            : { verdict: "pass" };
        },
        onAgentTurn: async ({
          contextId,
          repository,
          projectPath,
          sessionName,
        }) => {
          if (contextId === "consume")
            consumed.push(
              (await repository.getActive(projectPath, sessionName))
                ?.contextOutputs.review?.value,
            );
        },
      },
      async ({ settled }) => {
        expect(settled.status).toBe("completed");
        expect(reviewed).toEqual([
          { issueIds: [], instructions: "Recheck" },
          accepted,
        ]);
        expect(publishedDuringReview).toEqual([undefined, undefined]);
        expect(captures).toBe(2);
        expect(consumed).toEqual([accepted]);
        expect(settled.contextOutputs.review?.value).toEqual(accepted);
        expect(settled.contextOutputs.review?.reviewedCandidate).toEqual(
          settled.contextStates.review?.validationRound?.candidate,
        );
      },
    );
  });
});
