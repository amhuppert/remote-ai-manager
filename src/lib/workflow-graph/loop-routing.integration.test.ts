import { describe, expect, it } from "vitest";
import { runEngineScenario } from "./compat/engine-harness";
import { loopInstanceId } from "./loop-resolver";
import { context, edge, task, UNTIL_PASS } from "./loop-test-fixtures";
import { createWorkflowDefinition } from "./test-fixtures";

const judgeId = loopInstanceId("refine", 1, "judge");

function definition() {
  const ids = ["worker", "judge", "optional", "publish"];
  return createWorkflowDefinition({
    executionContexts: ids.map((id) =>
      context(
        id,
        id === "judge"
          ? {
              outputSchema: {
                type: "object",
                properties: {
                  verdict: { type: "string" },
                  optional: { type: "boolean" },
                },
                required: ["verdict", "optional"],
              },
            }
          : {},
      ),
    ),
    tasks: ids.map((id) => task(`task-${id}`, id)),
    edges: [
      edge("worker-judge", "worker", "judge"),
      edge("judge-optional", "judge", "optional", {
        schema: {
          properties: { optional: { const: true } },
          required: ["optional"],
        },
      }),
      edge("judge-publish", "judge", "publish"),
      edge("optional-publish", "optional", "publish"),
    ],
    loopGroups: [
      {
        id: "refine",
        bodyContextIds: ["worker", "judge"],
        entryContextId: "worker",
        exitContextId: "judge",
        until: UNTIL_PASS,
        maxPasses: 2,
      },
    ],
  });
}

describe("loop exit routing before downstream dispatch", () => {
  it.each([false, true])(
    "persists the concluding capture and optional=%s route before dispatch",
    async (optional) => {
      await runEngineScenario(
        {
          name: `loop-optional-${optional}`,
          definition: definition(),
          sessionLaneEnabled: false,
          agent: () => "complete-next-task",
          capture: ({ contextId }) =>
            contextId === judgeId ? { verdict: "pass", optional } : null,
        },
        async ({ settled, events, repository, projectPath, sessionName }) => {
          expect(settled.status).toBe("completed");
          const decision = events.findIndex(
            (event) => event.kind === "graph-workflow-loop-decision",
          );
          const route = events.findIndex(
            (event) =>
              event.kind === "graph-workflow-route-resolved" &&
              event.subject === "judge",
          );
          const dispatch = events.findIndex(
            (event) =>
              event.kind === "graph-workflow-context-status" &&
              event.subject === (optional ? "optional" : "publish") &&
              event.detail === "running",
          );
          expect(decision).toBeGreaterThanOrEqual(0);
          expect(route).toBeGreaterThan(decision);
          expect(dispatch).toBeGreaterThan(route);
          if (!optional) {
            const skip = events.findIndex(
              (event) =>
                event.kind === "graph-workflow-context-skipped" &&
                event.subject === "optional",
            );
            expect(skip).toBeGreaterThan(decision);
            expect(dispatch).toBeGreaterThan(skip);
          }
          expect(settled.routeSettlements.judge).toMatchObject({
            sourceContextId: "judge",
            effectiveSourceContextId: judgeId,
            captureIteration: 1,
            routeControlRevision: 0,
            edgeEvaluations: [
              {
                edgeId: "judge-optional",
                verdict: optional ? "active" : "inactive",
              },
              { edgeId: "judge-publish", verdict: "active" },
            ],
          });
          const reloaded = await repository.getActive(projectPath, sessionName);
          expect(reloaded?.routeSettlements.judge).toEqual(
            settled.routeSettlements.judge,
          );
        },
      );
    },
  );
});
