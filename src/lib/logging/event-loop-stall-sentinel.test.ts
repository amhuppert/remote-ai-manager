import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createEventLoopStallSentinel,
  getEventLoopSentinelIntervalMs,
  getEventLoopStallThresholdMs,
  startEventLoopStallSentinel,
  _eventLoopStallSentinelHostForTesting,
  _resetEventLoopStallSentinelForTesting,
} from "./event-loop-stall-sentinel";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { getTraceContext } from "./context";
import type { Logger } from "./logger";

interface FakeTimerHandle {
  unref(): void;
}

/**
 * Drives the sentinel with a fake clock and a fake scheduler: a real timer
 * would make the assertions depend on the very event-loop health the sentinel
 * is built to measure.
 */
function createHarness(options?: {
  intervalMs?: number;
  thresholdMs?: number;
}) {
  const intervalMs = options?.intervalMs ?? 1000;
  const thresholdMs = options?.thresholdMs ?? 250;

  const captured = createCapturingLogger();
  const emitActions: (string | undefined)[] = [];
  const emitTraceIds: (string | undefined)[] = [];
  const logger: Logger = {
    debug: (message, fields) => captured.debug(message, fields),
    info: (message, fields) => {
      const trace = getTraceContext();
      emitActions.push(trace?.action);
      emitTraceIds.push(trace?.traceId);
      captured.info(message, fields);
    },
    warn: (message, fields) => captured.warn(message, fields),
    error: (message, fields) => captured.error(message, fields),
  };

  const timers: { callback: () => void; handle: FakeTimerHandle }[] = [];
  const scheduledIntervals: number[] = [];
  let unrefCount = 0;
  let currentMs = 5_000;

  const sentinel = createEventLoopStallSentinel<FakeTimerHandle>({
    logger,
    setInterval(callback, ms) {
      scheduledIntervals.push(ms);
      const handle: FakeTimerHandle = {
        unref: () => {
          unrefCount += 1;
        },
      };
      timers.push({ callback, handle });
      return handle;
    },
    clearInterval(handle) {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    now: () => currentMs,
    intervalMs,
    thresholdMs,
  });

  return {
    sentinel,
    entries: captured.entries,
    stalls: () =>
      captured.entries.filter(
        (entry) => entry.message === "runtime.event_loop.stall",
      ),
    /** Advance the fake clock, then fire every registered timer callback. */
    tick(advanceMs: number) {
      currentMs += advanceMs;
      for (const timer of [...timers]) timer.callback();
    },
    timerCount: () => timers.length,
    scheduledIntervals,
    unrefCount: () => unrefCount,
    emitActions,
    emitTraceIds,
  };
}

describe("createEventLoopStallSentinel", () => {
  it("emits one stall event carrying the overshoot past the scheduled fire time", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.tick(1400);

    const stalls = harness.stalls();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.level).toBe("info");
    expect(stalls[0]?.fields["lagMs"]).toBe(400);
    expect(stalls[0]?.fields["intervalMs"]).toBe(1000);
    expect(stalls[0]?.fields["thresholdMs"]).toBe(250);
    expect(stalls[0]?.fields["consecutiveTicks"]).toBe(1);
  });

  it("stays silent when the overshoot is below the threshold", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.tick(1001);
    harness.tick(1002);

    expect(harness.entries).toHaveLength(0);
  });

  it("emits inside a sentinel trace so the line can be joined against slow reads", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.tick(1400);

    expect(harness.emitActions).toEqual(["sentinel:event-loop"]);
    expect(harness.emitTraceIds[0]).toBeTypeOf("string");
  });

  it("coalesces a run of stalled ticks into an onset event and a closing count", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.tick(1400);
    harness.tick(1600);
    harness.tick(1400);

    expect(harness.stalls()).toHaveLength(1);

    harness.tick(1000);

    const stalls = harness.stalls();
    expect(stalls).toHaveLength(2);
    expect(stalls[1]?.fields["consecutiveTicks"]).toBe(3);
    expect(stalls[1]?.fields["lagMs"]).toBe(600);
  });

  it("registers one timer no matter how many times start is called", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.sentinel.start();

    expect(harness.timerCount()).toBe(1);
    expect(harness.scheduledIntervals).toEqual([1000]);
  });

  it("unrefs the interval handle so it never holds the process open", () => {
    const harness = createHarness();

    harness.sentinel.start();

    expect(harness.unrefCount()).toBe(1);
  });

  it("clears the interval on stop and stops sampling", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.sentinel.stop();

    expect(harness.timerCount()).toBe(0);

    harness.tick(9000);
    expect(harness.entries).toHaveLength(0);
  });

  it("restarts cleanly after stop", () => {
    const harness = createHarness();

    harness.sentinel.start();
    harness.sentinel.stop();
    harness.sentinel.start();

    expect(harness.timerCount()).toBe(1);
    harness.tick(1400);
    expect(harness.stalls()).toHaveLength(1);
  });
});

describe("event-loop sentinel configuration", () => {
  beforeEach(() => {
    _resetEventLoopStallSentinelForTesting();
    delete process.env["CC_EVENT_LOOP_SENTINEL_MS"];
    delete process.env["CC_EVENT_LOOP_STALL_MS"];
  });

  afterEach(() => {
    _resetEventLoopStallSentinelForTesting();
    delete process.env["CC_EVENT_LOOP_SENTINEL_MS"];
    delete process.env["CC_EVENT_LOOP_STALL_MS"];
  });

  it("defaults the sample interval and keeps the stall threshold well above jitter", () => {
    expect(getEventLoopSentinelIntervalMs()).toBe(1000);
    expect(getEventLoopStallThresholdMs()).toBeGreaterThanOrEqual(200);
  });

  it("reads both overrides from the environment and caches them", () => {
    process.env["CC_EVENT_LOOP_SENTINEL_MS"] = "2000";
    process.env["CC_EVENT_LOOP_STALL_MS"] = "750";

    expect(getEventLoopSentinelIntervalMs()).toBe(2000);
    expect(getEventLoopStallThresholdMs()).toBe(750);

    process.env["CC_EVENT_LOOP_SENTINEL_MS"] = "3000";
    expect(getEventLoopSentinelIntervalMs()).toBe(2000);
  });

  it("falls back to defaults for unusable overrides", () => {
    process.env["CC_EVENT_LOOP_SENTINEL_MS"] = "0";
    process.env["CC_EVENT_LOOP_STALL_MS"] = "not-a-number";

    expect(getEventLoopSentinelIntervalMs()).toBe(1000);
    expect(getEventLoopStallThresholdMs()).toBe(250);
  });
});

describe("startEventLoopStallSentinel", () => {
  afterEach(() => {
    _resetEventLoopStallSentinelForTesting();
  });

  it("hosts a single sentinel on globalThis and drops it on reset", () => {
    startEventLoopStallSentinel();
    const first = _eventLoopStallSentinelHostForTesting().sentinel;
    startEventLoopStallSentinel();

    expect(first).not.toBeNull();
    expect(_eventLoopStallSentinelHostForTesting().sentinel).toBe(first);

    _resetEventLoopStallSentinelForTesting();
    expect(_eventLoopStallSentinelHostForTesting().sentinel).toBeNull();
  });
});
