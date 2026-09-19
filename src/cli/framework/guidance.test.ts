import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../testing/framework";

const laneEnv = {
  CC_WORKFLOW_EXECUTION_ID: "execution-one",
  CC_WORKFLOW_CONTEXT_ID: "context-one",
};
const laneReminderState = {
  verb: "task-complete",
  iterationCount: 2,
  circuitBreakerThreshold: 3,
  remainingTaskCount: 0,
  halted: null,
  allowAgentCollaboration: true,
};
const completeTask = [
  "workflow",
  "task",
  "complete",
  "task-one",
  "--summary",
  "Implemented",
];

describe("workflow guidance from server state", () => {
  it.each([
    {
      name: "invalid iteration count",
      state: { ...laneReminderState, iterationCount: "2" },
    },
    {
      name: "a different lane verb",
      state: { ...laneReminderState, verb: "task-add" },
    },
  ])(
    "rejects $name without losing the acknowledged task receipt",
    async ({ state }) => {
      const fixture = createCcRuntimeFixture({
        env: laneEnv,
        respond: () =>
          jsonReply({
            ok: true,
            remainingTaskCount: 0,
            laneReminderState: state,
          }),
      });
      const result = await fixture.run(completeTask);
      expect(result.exitCode).toBe(1);
      expect(result.envelope).toMatchObject({
        effect: "applied",
        reminders: [],
        recovery: {
          references: expect.arrayContaining([
            { kind: "workflow-task", id: "task-one" },
          ]),
        },
      });
    },
  );

  it("evaluates the completed lane's budget and final-task reminders alongside the acknowledged receipt", async () => {
    const fixture = createCcRuntimeFixture({
      env: laneEnv,
      respond: () =>
        jsonReply({ ok: true, remainingTaskCount: 0, laneReminderState }),
    });
    const result = await fixture.run(completeTask);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.envelope).toMatchObject({
      effect: "applied",
      reminders: [
        expect.stringContaining("used 2 of 3 iterations"),
        expect.stringContaining("acceptance criterion"),
      ],
      recovery: {
        references: expect.arrayContaining([
          { kind: "workflow-task", id: "task-one" },
        ]),
      },
    });
  });

  it("combines the local prose-file reminder with the lane's iteration rule", async () => {
    const fixture = createCcRuntimeFixture({
      env: laneEnv,
      files: { "summary.txt": "Completed the implementation" },
      respond: () =>
        jsonReply({
          ok: true,
          remainingTaskCount: 1,
          laneReminderState: {
            ...laneReminderState,
            remainingTaskCount: 1,
            allowAgentCollaboration: false,
          },
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
    expect(result.envelope?.reminders).toEqual([
      expect.stringContaining("used 2 of 3 iterations"),
      expect.stringContaining('"summary.txt" is outside .cc/'),
    ]);
  });

  it("retains halt guidance when the server refuses a lane mutation", async () => {
    const fixture = createCcRuntimeFixture({
      env: laneEnv,
      respond: () =>
        jsonReply(
          {
            error: "Workflow halted",
            halt: true,
            laneReminderState: {
              ...laneReminderState,
              halted: "circuit breaker",
            },
          },
          409,
        ),
    });
    const result = await fixture.run(completeTask);
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      effect: "not_applied",
      reminders: [
        expect.stringContaining("used 2 of 3 iterations"),
        expect.stringContaining("This workflow is halted: circuit breaker"),
      ],
    });
  });
});
