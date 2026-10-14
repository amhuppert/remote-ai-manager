import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerRuntime,
  getRuntime,
  unregisterRuntime,
  ownRuntimeInputReceipt,
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

  it("delegates live receipt ownership only to the exact current runtime's owner", () => {
    const original = makeMockRuntime();
    const replacement = makeMockRuntime();
    const receipt = async () => {};
    const owner = vi.fn(() => true);
    registerRuntime("conv-1", original, owner);
    expect(ownRuntimeInputReceipt("conv-1", original, receipt)).toBe(true);
    registerRuntime("conv-1", replacement);
    expect(ownRuntimeInputReceipt("conv-1", original, receipt)).toBe(false);
    expect(ownRuntimeInputReceipt("conv-1", replacement, receipt)).toBe(false);
    registerRuntime("conv-1", original);
    expect(ownRuntimeInputReceipt("conv-1", original, receipt)).toBe(false);
    expect(owner).toHaveBeenCalledOnce();
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

describe("one registry per process", () => {
  it("answers a second copy of the module, as routes load it beside the boot-time supervision", async () => {
    const runtime = makeMockRuntime();
    registerRuntime("conv-shared", runtime);
    vi.resetModules();
    const routeCopy = await import("./runtime-registry");
    expect(routeCopy.getRuntime("conv-shared")).toBe(runtime);
    routeCopy.unregisterRuntime("conv-shared", runtime);
    expect(getRuntime("conv-shared")).toBeUndefined();
  });
});
