import { describe, expect, it } from "vitest";
import {
  agentFailureClassificationSchema,
  continuationDispositionSchema,
  extractRetryAfterHint,
  isLikelyQuotaExhaustedMessage,
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

  it("accepts a quota exhaustion carrying the provider's capacity hint", () => {
    expect(
      agentFailureClassificationSchema.parse({
        kind: "quota_exhausted",
        message: "You've hit your usage limit.",
        retryable: false,
        retryAfterHint: "Aug 19th, 2026 11:29 PM",
      }),
    ).toEqual({
      kind: "quota_exhausted",
      message: "You've hit your usage limit.",
      retryable: false,
      retryAfterHint: "Aug 19th, 2026 11:29 PM",
    });
  });

  it("leaves the capacity hint optional", () => {
    const parsed = agentFailureClassificationSchema.parse({
      kind: "quota_exhausted",
      message: "rate limit exceeded",
      retryable: false,
    });
    expect(parsed.retryAfterHint).toBeUndefined();
  });
});

describe("isLikelyQuotaExhaustedMessage", () => {
  it("matches provider capacity-refusal shapes", () => {
    for (const message of [
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 19th, 2026 11:29 PM.",
      "You have reached your usage limit",
      "Claude AI usage limit reached|1755559740",
      "rate limit exceeded",
      "429 Too Many Requests",
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      "HTTP 429",
      "request failed with status code 429",
      "Overloaded",
      "overloaded_error: the model is overloaded",
      "Your quota has been exhausted",
      "You are out of credits",
    ]) {
      expect(isLikelyQuotaExhaustedMessage(message), message).toBe(true);
    }
  });

  it("does not match ordinary failure text that merely mentions usage or numbers", () => {
    for (const message of [
      "usage: cctl validate run <name>",
      "Codex Exec exited with code 1: Reading prompt from stdin...",
      "limit reached: maximum file size",
      "Error at src/lib/git/worktree.ts:429:12",
      "processed 4290 rows",
      "config file not found",
      "OAuth token expired for this session",
      // A bare 429 is a number, not a status: git prose quotes SHAs and the
      // merge path reports byte counts and source coordinates.
      "Merge failed at commit e429fa1: fatal: cannot merge",
      "fatal: bad object a3e429b7c",
      "wrote 429 bytes to socket",
      "file src/foo.ts line 429 column 3",
      "read 429.5 KB",
    ]) {
      expect(isLikelyQuotaExhaustedMessage(message), message).toBe(false);
    }
  });
});

describe("extractRetryAfterHint", () => {
  it("captures the provider's own capacity-return text", () => {
    expect(
      extractRetryAfterHint(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 19th, 2026 11:29 PM.",
      ),
    ).toBe("Aug 19th, 2026 11:29 PM");
    expect(
      extractRetryAfterHint(
        "You've hit your usage limit. Try again in 4 hours",
      ),
    ).toBe("4 hours");
    expect(
      extractRetryAfterHint(
        "Usage limit reached. Your limit will reset at 10pm (America/New_York).",
      ),
    ).toBe("10pm (America/New_York)");
    expect(
      extractRetryAfterHint("rate limit exceeded; retry-after: 3600s"),
    ).toBe("3600s");
  });

  it("returns undefined when the message names no capacity-return text", () => {
    expect(extractRetryAfterHint("429 Too Many Requests")).toBeUndefined();
    expect(
      extractRetryAfterHint("You've hit your usage limit."),
    ).toBeUndefined();
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
