import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRuntime,
  getRuntime,
  unregisterRuntime,
  _resetForTesting,
} from "./runtime-registry";
import type { ConversationBackendRuntime } from "./conversation";

function makeMockRuntime(
  overrides?: Partial<Pick<ConversationBackendRuntime, "close" | "backend">>,
): ConversationBackendRuntime {
  return {
    backend: "claude",
    status: "alive",
    modelSelection: { modelId: "opus", parameters: { effort: "high" } },

    sendTurn: vi.fn(),
    close: vi.fn(async () => {}),
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
    unregisterRuntime("conv-1", runtime);
    expect(getRuntime("conv-1")).toBeUndefined();
  });
});

describe("getRuntime", () => {
  it("returns undefined for a missing key", () => {
    expect(getRuntime("nonexistent")).toBeUndefined();
  });
});
