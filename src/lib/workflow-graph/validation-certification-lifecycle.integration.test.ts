import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  INFRA_RESULT,
  metadata,
  passResult,
} from "./testing/cohort-engine-harness";

describe("validation certification lifecycle", () => {
  it("recertifies task-complete work after an infrastructure halt and pause retirement", async () => {
    let infrastructureUnavailable = true;
    const harness = createHarness({
      execution: createCohortExecution(),
      productionSignalHalt: true,
      runContextValidator: async (input) => ({
        result:
          infrastructureUnavailable && input.validator.id === "perf-reviewer"
            ? INFRA_RESULT
            : passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.contextState()).toMatchObject({
      status: "halted",
      completedTaskCount: 1,
    });
    expect(harness.contextState()?.validationRound).toMatchObject({
      seq: 1,
      phase: "specialists",
      outcome: null,
      specialists: {
        "perf-reviewer": { state: "infra_failed", attempts: 3 },
      },
    });

    await harness.drainAndHalt();
    await harness.resumeHalt();

    expect(harness.repository.read().status).toBe("running");
    expect(harness.contextState()).toMatchObject({
      status: "ready",
      completedTaskCount: 1,
    });
    expect(
      harness.contextState()?.validationRound?.specialists["perf-reviewer"],
    ).toMatchObject({ state: "pending", attempts: 0 });

    await harness.pause();

    expect(harness.repository.read().status).toBe("paused");
    expect(harness.contextState()?.status).toBe("ready");
    expect(harness.contextState()?.validationRound).toMatchObject({
      seq: 1,
      phase: "concluded",
      outcome: null,
    });

    infrastructureUnavailable = false;
    await harness.resumeHalt();
    await harness.scheduleNextContext();
    expect(harness.contextState()?.status).toBe("running");
    await harness.run();

    expect(harness.contextState()).toMatchObject({
      status: "completed",
      completedTaskCount: 1,
    });
    expect(harness.contextState()?.validationRound).toMatchObject({
      seq: 2,
      phase: "concluded",
      outcome: "passed",
    });
    expect(
      harness.runContextValidator.mock.calls.map(
        (call) => call[0].validator.id,
      ),
    ).toEqual([
      "general",
      "security-reviewer",
      "perf-reviewer",
      "perf-reviewer",
      "perf-reviewer",
      "general",
      "security-reviewer",
      "perf-reviewer",
    ]);
  });
});
