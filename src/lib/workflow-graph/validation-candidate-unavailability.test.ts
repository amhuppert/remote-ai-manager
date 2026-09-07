import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
} from "./testing/cohort-engine-harness";

describe("initial candidate unavailability accounting", () => {
  it("preserves the semantic failure streak while the pending halt drains", async () => {
    const harness = createHarness({
      execution: createCohortExecution({
        assignmentIds: ["general"],
        consecutiveFailureCount: 2,
      }),
      productionSignalHalt: true,
      resolveCandidateTree: () => ({
        kind: "unavailable",
        reason: "candidate index is unreadable",
      }),
      runContextValidator: async () => {
        throw new Error("No reviewer can inspect an unavailable candidate");
      },
    });
    const result = await harness.run();
    expect(result.execution.status).toBe("running");
    expect(result.execution.pendingHaltReason).toMatchObject({
      type: "validation_candidate_unavailable",
      attempts: 2,
    });
    expect(harness.contextState()?.consecutiveFailureCount).toBe(2);
    await harness.drainAndHalt();
    expect(harness.repository.read().status).toBe("halted");
    expect(harness.repository.read().haltReason?.type).toBe(
      "validation_candidate_unavailable",
    );
    expect(harness.contextState()?.consecutiveFailureCount).toBe(2);
    expect(harness.results()).toHaveLength(0);
  });
});
