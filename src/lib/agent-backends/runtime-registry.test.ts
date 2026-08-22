import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRuntime,
  getRuntime,
  unregisterRuntime,
  closeAllRuntimes,
  _resetForTesting,
} from "./runtime-registry";
import type { ConversationBackendRuntime } from "./conversation";

function makeMockRuntime(
  overrides?: Partial<Pick<ConversationBackendRuntime, "close" | "backend">>,
): ConversationBackendRuntime {
  return {
    backend: "claude",
    status: "alive",
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    alignmentVersion: null,
    sendTurn: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  } as ConversationBackendRuntime;
}

/** Let pending timers and microtasks drain so a stalled await is observable. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  _resetForTesting();
  vi.clearAllMocks();
});

describe("registerRuntime / getRuntime", () => {
  it("returns the registered runtime", () => {
    const runtime = makeMockRuntime();
    registerRuntime("conv-1", runtime);
    expect(getRuntime("conv-1")).toBe(runtime);
  });
});

describe("unregisterRuntime", () => {
  it("removes the runtime from the registry", () => {
    const runtime = makeMockRuntime();
    registerRuntime("conv-1", runtime);
    unregisterRuntime("conv-1");
    expect(getRuntime("conv-1")).toBeUndefined();
  });
});

describe("getRuntime", () => {
  it("returns undefined for a missing key", () => {
    expect(getRuntime("nonexistent")).toBeUndefined();
  });
});

describe("closeAllRuntimes", () => {
  it("calls close() on all registered runtimes", async () => {
    const r1 = makeMockRuntime();
    const r2 = makeMockRuntime();
    registerRuntime("conv-1", r1);
    registerRuntime("conv-2", r2);
    await closeAllRuntimes();
    expect(r1.close).toHaveBeenCalledTimes(1);
    expect(r2.close).toHaveBeenCalledTimes(1);
  });

  it("clears the registry after closing", async () => {
    const runtime = makeMockRuntime();
    registerRuntime("conv-1", runtime);
    await closeAllRuntimes();
    expect(getRuntime("conv-1")).toBeUndefined();
  });

  it("resolves only after every runtime teardown settles", async () => {
    let releaseSlow: () => void = () => {};
    const slow = makeMockRuntime({
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSlow = resolve;
          }),
      ),
    });
    const fast = makeMockRuntime();
    registerRuntime("conv-slow", slow);
    registerRuntime("conv-fast", fast);

    let settled = false;
    const closing = closeAllRuntimes().then(() => {
      settled = true;
    });

    await flush();
    expect(settled).toBe(false);

    releaseSlow();
    await closing;
    expect(settled).toBe(true);
  });

  it("isolates a rejected teardown and still awaits the remaining runtimes", async () => {
    const failing = makeMockRuntime({
      close: vi.fn(() => Promise.reject(new Error("close failed"))),
    });
    let releaseOther: () => void = () => {};
    const other = makeMockRuntime({
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseOther = resolve;
          }),
      ),
    });
    registerRuntime("conv-1", failing);
    registerRuntime("conv-2", other);

    let settled = false;
    const closing = closeAllRuntimes().then(() => {
      settled = true;
    });

    await flush();
    expect(settled).toBe(false);

    releaseOther();
    await expect(closing).resolves.toBeUndefined();
    expect(other.close).toHaveBeenCalledTimes(1);
  });

  it("handles a synchronously thrown close and continues closing remaining runtimes", async () => {
    const r1 = makeMockRuntime({
      close: vi.fn().mockImplementation(() => {
        throw new Error("close failed");
      }),
    });
    const r2 = makeMockRuntime();
    registerRuntime("conv-1", r1);
    registerRuntime("conv-2", r2);
    await expect(closeAllRuntimes()).resolves.toBeUndefined();
    expect(r2.close).toHaveBeenCalledTimes(1);
  });
});
