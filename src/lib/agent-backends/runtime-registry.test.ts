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
    capabilities: {
      queueWhileRunning: true,
      askUserQuestion: true,
      preciseFork: true,
      portableMcpAtStart: true,
      portableMcpBetweenTurns: true,
      contextWindowMetrics: true,
    },
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    sendTurn: vi.fn(),
    close: vi.fn(),
    ...overrides,
  } as ConversationBackendRuntime;
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
  it("calls close() on all registered runtimes", () => {
    const r1 = makeMockRuntime();
    const r2 = makeMockRuntime();
    registerRuntime("conv-1", r1);
    registerRuntime("conv-2", r2);
    closeAllRuntimes();
    expect(r1.close).toHaveBeenCalledTimes(1);
    expect(r2.close).toHaveBeenCalledTimes(1);
  });

  it("clears the registry after closing", () => {
    const runtime = makeMockRuntime();
    registerRuntime("conv-1", runtime);
    closeAllRuntimes();
    expect(getRuntime("conv-1")).toBeUndefined();
  });

  it("handles close() errors gracefully and continues closing remaining runtimes", () => {
    const r1 = makeMockRuntime({
      close: vi.fn().mockImplementation(() => {
        throw new Error("close failed");
      }),
    });
    const r2 = makeMockRuntime();
    registerRuntime("conv-1", r1);
    registerRuntime("conv-2", r2);
    expect(() => closeAllRuntimes()).not.toThrow();
    expect(r2.close).toHaveBeenCalledTimes(1);
  });
});
