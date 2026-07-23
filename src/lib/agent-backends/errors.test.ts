import { describe, expect, it } from "vitest";
import {
  agentFailureClassificationSchema,
  continuationDispositionSchema,
  isLikelyStaleResumeMessage,
  isPromptNotDeliveredFailure,
  markPromptNotDelivered,
  turnContinuationSchema,
} from "./errors";

describe("agentFailureClassificationSchema", () => {
  it("accepts the dedicated structured-output exhaustion classification", () => {
    expect(
      agentFailureClassificationSchema.parse({
        kind: "structured_output_exhausted",
        message: "Agent exceeded structured output retry limit",
        retryable: false,
      }),
    ).toEqual({
      kind: "structured_output_exhausted",
      message: "Agent exceeded structured output retry limit",
      retryable: false,
    });
  });
});

describe("isLikelyStaleResumeMessage", () => {
  it("matches provider stale-resume shapes", () => {
    for (const message of [
      "No conversation found with session ID: abc-123",
      "session abc-123 not found",
      "session abc-123 has expired",
      "cannot resume: transcript not found",
      "thread thread-abc not found",
      "no rollout found for thread thread-abc",
      "Failed to resume Codex thread t-1: no rollout found",
      "cannot resume: session does not exist",
      "thread expired",
    ]) {
      expect(isLikelyStaleResumeMessage(message), message).toBe(true);
    }
  });

  it("does not match expiry or missing-marker text that is not about the continuation", () => {
    for (const message of [
      "OAuth token expired for this session",
      "API key expired — please start a new session",
      "Session started. File not found.",
      "config file not found",
      "no rollout data available",
    ]) {
      expect(isLikelyStaleResumeMessage(message), message).toBe(false);
    }
  });
});

describe("turnContinuationSchema", () => {
  it("rejects the contradictory pair: clear disposition with a non-null ref", () => {
    const result = turnContinuationSchema.safeParse({
      backendRef: { backend: "codex", ref: "thread-stale" },
      continuationDisposition: "clear",
    });
    expect(result.success).toBe(false);
  });

  it("accepts clear with a null ref", () => {
    expect(
      turnContinuationSchema.safeParse({
        backendRef: null,
        continuationDisposition: "clear",
      }).success,
    ).toBe(true);
  });

  it("accepts retain with either a ref or null", () => {
    expect(
      turnContinuationSchema.safeParse({
        backendRef: { backend: "claude", ref: "sess-1" },
        continuationDisposition: "retain",
      }).success,
    ).toBe(true);
    expect(
      turnContinuationSchema.safeParse({
        backendRef: null,
        continuationDisposition: "retain",
      }).success,
    ).toBe(true);
  });

  it("only admits the two known dispositions", () => {
    expect(continuationDispositionSchema.options).toEqual(["retain", "clear"]);
    expect(continuationDispositionSchema.safeParse("drop").success).toBe(false);
  });
});

describe("prompt-not-delivered marker", () => {
  it("detects a marked error and returns the same instance from mark", () => {
    const error = new Error("runtime unrecoverable");
    const marked = markPromptNotDelivered(error);
    expect(marked).toBe(error);
    expect(isPromptNotDeliveredFailure(marked)).toBe(true);
  });

  it("does not match unmarked errors or non-error values", () => {
    expect(isPromptNotDeliveredFailure(new Error("plain failure"))).toBe(false);
    expect(isPromptNotDeliveredFailure("prompt not delivered")).toBe(false);
    expect(isPromptNotDeliveredFailure(undefined)).toBe(false);
  });
});
