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

function makeDeps() {
  return {
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
  };
}

function makeInput(overrides: { timeoutMs?: number } = {}) {
  const runtimeState: {
    abortController: AbortController;
    timeoutHandle?: ReturnType<typeof setTimeout>;
  } = { abortController: new AbortController() };
  const closeRuntime = vi.fn();
  return {
    runtimeState,
    conversationId: "conv-1",
    sessionName: "s",
    backend: "claude",
    timeoutMs: overrides.timeoutMs ?? 0,
    closeRuntime,
  };
}

describe("wireTurnAbort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the runtime-state controller for the turn", () => {
    const deps = makeDeps();
    const input = makeInput();

    const wiring = wireTurnAbort(deps, input);

    expect(wiring.abortController).toBe(input.runtimeState.abortController);
    expect(deps.registerAbortController).toHaveBeenCalledWith(
      "conv-1",
      wiring.abortController,
    );
  });

  it("refreshes a controller left aborted by a previous turn", () => {
    const deps = makeDeps();
    const input = makeInput();
    const staleController = input.runtimeState.abortController;
    staleController.abort();

    const wiring = wireTurnAbort(deps, input);

    expect(wiring.abortController).not.toBe(staleController);
    expect(wiring.abortController.signal.aborted).toBe(false);
    expect(input.runtimeState.abortController).toBe(wiring.abortController);
  });

  it("arms no timeout when timeoutMs is 0", () => {
    const input = makeInput({ timeoutMs: 0 });

    wireTurnAbort(makeDeps(), input);

    expect(input.runtimeState.timeoutHandle).toBeUndefined();
  });

  it("on timeout, aborts BEFORE closing the runtime so the failure classifies as aborted", () => {
    const input = makeInput({ timeoutMs: 1_000 });
    let abortedWhenClosed: boolean | undefined;
    input.closeRuntime.mockImplementation(() => {
      abortedWhenClosed = input.runtimeState.abortController.signal.aborted;
    });

    const wiring = wireTurnAbort(makeDeps(), input);
    expect(wiring.timeoutFired()).toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(wiring.timeoutFired()).toBe(true);
    expect(input.closeRuntime).toHaveBeenCalledTimes(1);
    expect(abortedWhenClosed).toBe(true);
  });

  it("cleanup clears the armed timeout and unregisters the controller", () => {
    const deps = makeDeps();
    const input = makeInput({ timeoutMs: 1_000 });

    const wiring = wireTurnAbort(deps, input);
    expect(input.runtimeState.timeoutHandle).toBeDefined();

    wiring.cleanup();
    vi.advanceTimersByTime(10_000);

    expect(input.runtimeState.timeoutHandle).toBeUndefined();
    expect(wiring.timeoutFired()).toBe(false);
    expect(input.closeRuntime).not.toHaveBeenCalled();
    expect(deps.unregisterAbortController).toHaveBeenCalledWith(
      "conv-1",
      wiring.abortController,
    );
  });
});
