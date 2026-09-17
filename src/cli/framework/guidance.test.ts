import { describe, expect, it } from "vitest";
import { evaluateLaneReminders } from "@/lib/workflow-graph/lane-reminders";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

const laneEnv = {
  CC_WORKFLOW_EXECUTION_ID: "execution-one",
  CC_WORKFLOW_CONTEXT_ID: "context-one",
};
describe("native server guidance transport", () => {
  it("retains real server rule authority and selected reminders alongside an acknowledged task", async () => {
    const evaluation = evaluateLaneReminders({
      verb: "task-complete",
      iterationCount: 2,
      circuitBreakerThreshold: 3,
      remainingTaskCount: 0,
      halted: null,
      allowAgentCollaboration: true,
      contextLimitStopped: false,
    });
    const fixture = createCcRuntimeFixture({
      env: laneEnv,
      respond: () =>
        jsonReply({
          ok: true,
          remainingTaskCount: 0,
          guidance: evaluation.guidance,
        }),
    });
    const result = await fixture.run([
      "workflow",
      "task",
      "complete",
      "task-one",
      "--summary",
      "Implemented",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      reminders: evaluation.reminders,
    });
    expect(evaluation.guidance).toMatchObject({
      authority: "cc-server-lane",
      commandPath: "workflow task complete",
      firings: [
        { type: "guidance.rule_fired", ruleId: "iteration-budget" },
        { type: "guidance.rule_fired", ruleId: "final-task-self-check" },
      ],
    });
  });
});

it("combines an earned local prose-file reminder with the server's actual iteration rule", async () => {
  const evaluation = evaluateLaneReminders({
    verb: "task-complete",
    iterationCount: 2,
    circuitBreakerThreshold: 3,
    remainingTaskCount: 1,
    halted: null,
    allowAgentCollaboration: false,
    contextLimitStopped: false,
  });
  const fixture = createCcRuntimeFixture({
    env: laneEnv,
    files: { "summary.txt": "Completed the implementation" },
    respond: () =>
      jsonReply({
        ok: true,
        remainingTaskCount: 1,
        guidance: evaluation.guidance,
      }),
  });
  const result = await fixture.run([
    "workflow",
    "task",
    "complete",
    "task-one",
    "--summary-file",
    "summary.txt",
  ]);
  expect(result.exitCode, result.stdout).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.reminders).toContain(evaluation.reminders[0]);
  expect(envelope.reminders).toContainEqual(
    expect.stringContaining('"summary.txt" is outside .cc/'),
  );
});
