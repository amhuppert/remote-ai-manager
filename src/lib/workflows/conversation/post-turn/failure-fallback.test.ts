import { describe, it, expect, vi } from "vitest";
import {
  buildFailedTurnResult,
  buildAbortedTurnResult,
} from "./failure-fallback";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("buildFailedTurnResult", () => {
  it("nulls all usage fields and carries the error + disposition", () => {
    const contentBlocks = [{ type: "text" as const, text: "partial" }];
    const result = buildFailedTurnResult({
      contentBlocks,
      error: "boom",
      continuationDisposition: "clear",
    });
    expect(result).toEqual({
      backendRef: null,
      costUsd: null,
      durationMs: null,
      numTurns: null,
      contextTokens: null,
      contextWindow: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      contentBlocks,
      aborted: false,
      compacted: false,
      error: "boom",
      continuationDisposition: "clear",
    });
  });
});

describe("buildAbortedTurnResult", () => {
  it("reports a user cancel through aborted with retain disposition and no error", () => {
    const result = buildAbortedTurnResult({
      contentBlocks: [],
      timeoutFired: false,
      timeoutMs: 300_000,
    });
    expect(result.aborted).toBe(true);
    expect(result.error).toBeNull();
    expect(result.continuationDisposition).toBe("retain");
    expect(result.abortReason).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it("stamps timeout metadata when the safety-net timeout fired", () => {
    const result = buildAbortedTurnResult({
      contentBlocks: [],
      timeoutFired: true,
      timeoutMs: 120_000,
    });
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toBe("timeout");
    expect(result.timeoutMs).toBe(120_000);
    expect(result.continuationDisposition).toBe("retain");
  });
});
