import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wireTurnAbort } from "./abort-wiring";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeInput(overrides: { timeoutMs?: number } = {}) {
  const runtimeState: {
    abortController: AbortController;
    timeoutHandle?: ReturnType<typeof setTimeout>;
  } = { abortController: new AbortController() };
  return {
    runtimeState,
    conversationId: "conv-1",
    sessionName: "s",
    backend: "claude",
    timeoutMs: overrides.timeoutMs ?? 0,
  };
}

describe("wireTurnAbort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the admitted controller for the turn", () => {
    const input = makeInput();

    const wiring = wireTurnAbort(input);

    expect(wiring.abortController).toBe(input.runtimeState.abortController);
  });

  it("preserves cancellation signalled before timeout wiring", () => {
    const input = makeInput();
    const staleController = input.runtimeState.abortController;
    staleController.abort();

    const wiring = wireTurnAbort(input);

    expect(wiring.abortController).toBe(staleController);
    expect(wiring.abortController.signal.aborted).toBe(true);
    expect(input.runtimeState.abortController).toBe(wiring.abortController);
  });

  it("arms no timeout when timeoutMs is 0", () => {
    const input = makeInput({ timeoutMs: 0 });

    wireTurnAbort(input);

    expect(input.runtimeState.timeoutHandle).toBeUndefined();
  });

  it("on timeout, signals the attempt controller with the timeout reason", () => {
    const input = makeInput({ timeoutMs: 1_000 });
    let abortedWhenClosed: boolean | undefined;
    input.runtimeState.abortController.signal.addEventListener("abort", () => {
      abortedWhenClosed = input.runtimeState.abortController.signal.aborted;
    });

    const wiring = wireTurnAbort(input);
    expect(wiring.timeoutFired()).toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(wiring.timeoutFired()).toBe(true);
    expect(input.runtimeState.abortController.signal.aborted).toBe(true);
    expect(abortedWhenClosed).toBe(true);
  });

  it("cleanup clears the armed timeout without cancelling the controller", () => {
    const input = makeInput({ timeoutMs: 1_000 });

    const wiring = wireTurnAbort(input);
    expect(input.runtimeState.timeoutHandle).toBeDefined();

    wiring.cleanup();
    vi.advanceTimersByTime(10_000);

    expect(input.runtimeState.timeoutHandle).toBeUndefined();
    expect(wiring.timeoutFired()).toBe(false);
    expect(input.runtimeState.abortController.signal.aborted).toBe(false);
  });
});

describe("wireTurnAbort stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStallInput(overrides: { stallTimeoutMs?: number } = {}) {
    return {
      ...makeInput(),
      stallTimeoutMs: overrides.stallTimeoutMs ?? 0,
    };
  }

  it("arms no stall watchdog when stallTimeoutMs is 0", () => {
    const input = makeStallInput({ stallTimeoutMs: 0 });

    const wiring = wireTurnAbort(input);
    vi.advanceTimersByTime(10_000_000);

    expect(wiring.stallFired()).toBe(false);
    expect(input.runtimeState.abortController.signal.aborted).toBe(false);
  });

  it("signals the attempt controller when no activity arrives within stallTimeoutMs", () => {
    const input = makeStallInput({ stallTimeoutMs: 5_000 });
    let abortedWhenClosed: boolean | undefined;
    input.runtimeState.abortController.signal.addEventListener("abort", () => {
      abortedWhenClosed = input.runtimeState.abortController.signal.aborted;
    });

    const wiring = wireTurnAbort(input);
    expect(wiring.stallFired()).toBe(false);

    vi.advanceTimersByTime(5_000);

    expect(wiring.stallFired()).toBe(true);
    expect(wiring.timeoutFired()).toBe(false);
    expect(input.runtimeState.abortController.signal.aborted).toBe(true);
    expect(abortedWhenClosed).toBe(true);
  });

  it("notifyActivity resets the stall deadline so an active turn never trips", () => {
    const input = makeStallInput({ stallTimeoutMs: 5_000 });

    const wiring = wireTurnAbort(input);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(4_000);
      wiring.notifyActivity();
    }
    expect(wiring.stallFired()).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(wiring.stallFired()).toBe(true);
  });

  it("cleanup disarms the stall watchdog", () => {
    const input = makeStallInput({ stallTimeoutMs: 5_000 });

    const wiring = wireTurnAbort(input);
    wiring.cleanup();
    vi.advanceTimersByTime(60_000);

    expect(wiring.stallFired()).toBe(false);
    expect(input.runtimeState.abortController.signal.aborted).toBe(false);
  });
});
