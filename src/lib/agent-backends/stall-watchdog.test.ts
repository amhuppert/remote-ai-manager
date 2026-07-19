import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStallWatchdog } from "./stall-watchdog";

describe("createStallWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onStall after stallTimeoutMs with no activity", () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ stallTimeoutMs: 10_000, onStall });

    vi.advanceTimersByTime(9_999);
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.fired()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(watchdog.fired()).toBe(true);
  });

  it("touch() resets the deadline", () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ stallTimeoutMs: 10_000, onStall });

    vi.advanceTimersByTime(9_000);
    watchdog.touch();
    vi.advanceTimersByTime(9_000);
    watchdog.touch();
    vi.advanceTimersByTime(9_999);
    expect(onStall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("fires at most once even with later quiet periods", () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ stallTimeoutMs: 1_000, onStall });

    vi.advanceTimersByTime(1_000);
    expect(onStall).toHaveBeenCalledTimes(1);

    // touch after firing must not re-arm
    watchdog.touch();
    vi.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("cancel() disarms and prevents firing", () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog({ stallTimeoutMs: 1_000, onStall });

    watchdog.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.fired()).toBe(false);
  });

  it("a non-positive stallTimeoutMs disables the watchdog entirely", () => {
    const onStall = vi.fn();
    const disabled = createStallWatchdog({ stallTimeoutMs: 0, onStall });
    disabled.touch();
    vi.advanceTimersByTime(1_000_000);
    expect(onStall).not.toHaveBeenCalled();
    expect(disabled.fired()).toBe(false);
    disabled.cancel();
  });
});
