import { describe, expect, it } from "vitest";
import { createTestHost } from "cli-for-agents/testing";
import { ccErrors } from "./family";
import { observeJob, waitDurationMs } from "./observe-job";

function advancingClock() {
  const host = createTestHost();
  return {
    now: host.now,
    sleep: ((duration, signal) => {
      const pending = host.sleep(duration, signal);
      host.advance(duration);
      return pending;
    }) satisfies typeof host.sleep,
  };
}

describe("structured job observation", () => {
  it("charges the polling cadence to the injected clock and returns the actual terminal value", async () => {
    const clock = advancingClock();
    let polls = 0;
    const budgets: number[] = [];
    const observed = await observeJob({
      clock,
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      async poll({ remainingMs }) {
        budgets.push(remainingMs);
        polls++;
        return polls === 3
          ? { kind: "done", value: { status: "completed" } }
          : { kind: "pending" };
      },
    });
    expect(observed).toEqual({ kind: "done", value: { status: "completed" } });
    expect(budgets).toEqual([5_000, 4_000, 3_000]);
  });

  it("fails only after consecutive invalid bodies and resets after a readable poll", async () => {
    let polls = 0;
    const observed = await observeJob({
      clock: advancingClock(),
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      async poll() {
        polls++;
        return { kind: polls === 3 ? "pending" : "invalid" };
      },
    });
    expect(observed).toEqual({ kind: "invalid" });
    expect(polls).toBe(6);
  });

  it("ends observation at its deadline without implicitly cancelling a job", async () => {
    let cancelled = 0;
    let polls = 0;
    const observed = await observeJob({
      clock: advancingClock(),
      signal: new AbortController().signal,
      timeoutMs: 1_500,
      async poll() {
        polls++;
        return { kind: "pending" };
      },
      async onCancel() {
        cancelled++;
      },
    });
    expect(observed).toEqual({ kind: "timeout" });
    expect(polls).toBe(2);
    expect(cancelled).toBe(0);
  });

  it("runs owned cancellation once when interrupted and retains a cancellation refusal", async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const failure = {
      ok: false,
      error: ccErrors.error("CC_CONNECTION", { message: "cancel unreachable" }),
    } as const;
    const observed = await observeJob({
      clock: advancingClock(),
      signal: controller.signal,
      timeoutMs: 5_000,
      async poll() {
        controller.abort();
        return { kind: "pending" };
      },
      async onCancel() {
        cancelled++;
        return failure;
      },
    });
    expect(observed).toEqual({ kind: "cancelled", failure });
    expect(cancelled).toBe(1);
  });
  it("turns an unexpected polling exception into a typed observation failure", async () => {
    const observed = await observeJob({
      clock: advancingClock(),
      signal: new AbortController().signal,
      timeoutMs: 1000,
      async poll() {
        throw new Error("poll failed");
      },
    });
    expect(observed).toMatchObject({
      kind: "failure",
      failure: { ok: false, error: { code: "CC_OPERATION_FAILED" } },
    });
  });
  it("rejects durations outside the safe integer clock range", () => {
    expect(waitDurationMs("99999999999999999h")).toBeNull();
    expect(waitDurationMs("25m")).toBe(1_500_000);
  });
});
