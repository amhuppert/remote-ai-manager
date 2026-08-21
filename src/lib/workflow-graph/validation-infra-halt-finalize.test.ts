/**
 * What the finalizer may do to a context an infrastructure halt just stopped.
 *
 * The answer is nothing, and the reason is the same one
 * `validation-plan-defect-halt.test.ts` pins for a refused contract: production
 * signal-halt records a PENDING reason and leaves `execution.status` on
 * "running", so the iteration keeps going after the halt. In that window the
 * finalizer finds no remaining tasks — validation only ever runs once they are
 * all done — and would write `completed` over the context. `completed` is
 * terminal, it releases the lane to land and merge, and here it would certify
 * work that NO validator ever judged.
 *
 * The sibling infra tests in `validation-cohort-engine.test.ts` cannot see this:
 * they use the harness's one-write halt fake, which sets `status: "halted"`
 * immediately, and the finalizer's mid-flight guard fires on that. Production
 * does not, which is why this file drives the real handler (#86 F1).
 */

import { describe, expect, it } from "vitest";
import {
  createCohortExecution,
  createHarness,
  INFRA_RESULT,
  metadata,
  passResult,
  type Harness,
} from "@/lib/workflow-graph/testing/cohort-engine-harness";
import { isResumableHalt } from "@/lib/workflow-graph/lifecycle-classifier";

/**
 * Two seats certify the candidate and the third never renders a verdict at all,
 * spending its three attempts on infrastructure failures. The two passes matter:
 * they are what makes the round look finishable to everything except the rule
 * that a required lane must be HEARD.
 */
function infraExhaustionHarness(): Harness {
  return createHarness({
    execution: createCohortExecution(),
    productionSignalHalt: true,
    runContextValidator: async (input) => ({
      result:
        input.validator.id === "perf-reviewer"
          ? INFRA_RESULT
          : passResult(input.validator.id),
      metadata: metadata(),
      roundToken: input.roundToken ?? null,
    }),
  });
}

describe("an infrastructure halt is not a certification", () => {
  it("leaves the halted context halted rather than finishing it", async () => {
    const harness = infraExhaustionHarness();

    await harness.run();

    // The failure this pins: `completed` here would release the lane to land
    // and merge on the strength of a round that reached no verdict.
    expect(harness.contextState()?.status).toBe("halted");
    expect(harness.repository.read().activeContextIds).not.toContain(
      "context-plan",
    );
  });

  it("records the halt as a pending, resumable validator_infra_error", async () => {
    const harness = infraExhaustionHarness();

    await harness.run();

    const halted = harness.repository.read();
    expect(halted.pendingHaltReason).toMatchObject({
      type: "validator_infra_error",
      contextId: "context-plan",
      assignmentId: "perf-reviewer",
      attempts: 3,
      roundSeq: 1,
    });
    expect(isResumableHalt(halted.pendingHaltReason!)).toBe(true);
    // The whole point of the window: the execution is still running when the
    // finalizer gets its turn, so the guard cannot be the mid-flight one.
    expect(halted.status).toBe("running");
  });

  it("keeps the round open with its verdicts intact so a resume can rerun only the unheard lane", async () => {
    const harness = infraExhaustionHarness();

    await harness.run();

    const round = harness.contextState()?.validationRound;
    expect(round?.phase).toBe("specialists");
    expect(round?.outcome).toBeNull();
    expect(round?.specialists["general"]).toMatchObject({
      state: "verdict_pass",
    });
    expect(round?.specialists["perf-reviewer"]).toMatchObject({
      state: "infra_failed",
      attempts: 3,
    });
  });

  it("still completes a context whose round actually passed", async () => {
    // The other side of the guard: withholding on `halted` must not withhold on
    // the ordinary path, or nothing would ever finish.
    const harness = createHarness({
      execution: createCohortExecution(),
      productionSignalHalt: true,
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
        roundToken: input.roundToken ?? null,
      }),
    });

    await harness.run();

    expect(harness.contextState()?.status).toBe("completed");
    expect(harness.repository.read().pendingHaltReason).toBeNull();
  });
});
