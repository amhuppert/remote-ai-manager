import { describe, expect, it } from "vitest";
import { createCodexFailureClassifier } from "./failure-classifier";
import { agentFailureClassificationSchema } from "../errors";

const classifier = createCodexFailureClassifier();

describe("createCodexFailureClassifier", () => {
  it("classifies AbortError as aborted, non-retryable", () => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    expect(classifier.classify(err)).toEqual({
      kind: "aborted",
      message: "This operation was aborted",
      retryable: false,
    });
  });

  it("classifies timeout shapes as timeout", () => {
    expect(classifier.classify("Task timed out").kind).toBe("timeout");
    const named = new Error("deadline exceeded");
    named.name = "TimeoutError";
    expect(named && classifier.classify(named).kind).toBe("timeout");
  });

  it("classifies the runtime's thread-resume failure as retryable stale_resume_ref", () => {
    // Message shape produced by codex/conversation-runtime.ts when
    // resumeThread rejects.
    const message =
      "Failed to resume Codex thread thread-abc: rollout path missing";
    expect(classifier.classify(message)).toEqual({
      kind: "stale_resume_ref",
      message,
      retryable: true,
    });
  });

  it("pairs a thrown stale-resume classification with the adapter's clear verdict", () => {
    const error = new Error("thread thread-abc not found");

    expect(classifier.classifyWithContinuation(error)).toEqual({
      failure: {
        kind: "stale_resume_ref",
        message: error.message,
        retryable: true,
      },
      continuationDisposition: "clear",
    });
  });

  it("classifies stale-resume message shapes as retryable stale_resume_ref", () => {
    // The message-grep knowledge previously in
    // collaboration/agent-caller-production's getLikelyStaleResumeFailureMessage.
    for (const message of [
      "thread thread-abc not found",
      "no rollout found for thread thread-abc",
      "cannot resume: session does not exist",
      "thread expired",
    ]) {
      expect(classifier.classify(message)).toEqual({
        kind: "stale_resume_ref",
        message,
        retryable: true,
      });
      expect(classifier.classify(new Error(message)).kind).toBe(
        "stale_resume_ref",
      );
    }
  });

  it("classifies the usage-limit refusal as non-retryable quota_exhausted carrying the capacity hint", () => {
    // Verbatim message from the ticket #71 incident: four resolution attempts
    // reported this and were folded into "unresolvable conflict", then retried
    // against a wall that does not lift until Aug 19.
    const message =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 19th, 2026 11:29 PM.";

    expect(classifier.classify(message)).toEqual({
      kind: "quota_exhausted",
      message,
      retryable: false,
      retryAfterHint: "Aug 19th, 2026 11:29 PM",
    });
    expect(classifier.classify(new Error(message))).toEqual({
      kind: "quota_exhausted",
      message,
      retryable: false,
      retryAfterHint: "Aug 19th, 2026 11:29 PM",
    });
  });

  it("keeps the continuation on a quota refusal — the thread is still resumable", () => {
    const message = "You've hit your usage limit.";

    expect(classifier.classifyWithContinuation(message)).toEqual({
      failure: { kind: "quota_exhausted", message, retryable: false },
      continuationDisposition: "retain",
    });
  });

  it("omits the capacity hint when the refusal names no return time", () => {
    for (const message of [
      "You've hit your usage limit.",
      "rate limit exceeded",
    ]) {
      expect(classifier.classify(message)).toEqual({
        kind: "quota_exhausted",
        message,
        retryable: false,
      });
    }
  });

  it("does not classify a codex exec failure without continuity markers as stale", () => {
    expect(
      classifier.classify(
        "Codex Exec exited with code 1: Reading prompt from stdin...",
      ),
    ).toEqual({
      kind: "backend_error",
      message: "Codex Exec exited with code 1: Reading prompt from stdin...",
      retryable: false,
    });
  });

  it("retains the ref for expiry text that is not about the resumed thread", () => {
    const message = "OAuth token expired for this session";
    expect(classifier.classifyWithContinuation(message)).toEqual({
      failure: { kind: "backend_error", message, retryable: false },
      continuationDisposition: "retain",
    });
  });

  it("leaves every pre-quota classification untouched", () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const cases: Array<[unknown, string]> = [
      [abortError, "aborted"],
      ["Task timed out", "timeout"],
      [
        "Failed to resume Codex thread t-1: no rollout found",
        "stale_resume_ref",
      ],
      ["thread thread-abc not found", "stale_resume_ref"],
      [
        "Codex Exec exited with code 1: Reading prompt from stdin...",
        "backend_error",
      ],
      ["OAuth token expired for this session", "backend_error"],
      ["usage: cctl validate run <name>", "backend_error"],
      ["boom", "backend_error"],
    ];

    for (const [input, kind] of cases) {
      expect(classifier.classify(input).kind, String(input)).toBe(kind);
    }
  });

  it("never throws and always returns a schema-valid classification", () => {
    for (const input of [
      new Error("boom"),
      "plain string failure",
      { odd: "shape" },
      undefined,
      null,
      42,
    ]) {
      const classification = classifier.classify(input);
      expect(
        agentFailureClassificationSchema.safeParse(classification).success,
      ).toBe(true);
    }
  });
});
