import { describe, expect, it } from "vitest";
import { createClaudeFailureClassifier } from "./failure-classifier";
import {
  tagQuerySessionError,
  QUERY_SESSION_ERROR_CODES,
} from "./query-session-errors";
import { agentFailureClassificationSchema } from "../errors";

const classifier = createClaudeFailureClassifier();

describe("createClaudeFailureClassifier", () => {
  it("classifies AbortError as aborted, non-retryable", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    expect(classifier.classify(err)).toEqual({
      kind: "aborted",
      message: "The operation was aborted",
      retryable: false,
    });
  });

  it("classifies timeout shapes as timeout", () => {
    expect(classifier.classify(new Error("Task timed out")).kind).toBe(
      "timeout",
    );
    const named = new Error("deadline exceeded");
    named.name = "TimeoutError";
    expect(classifier.classify(named).kind).toBe("timeout");
  });

  it("classifies native structured-output retry exhaustion distinctly and non-retryably", () => {
    for (const message of [
      "Agent exceeded structured output retry limit",
      "Failed to produce valid structured output after maximum retries",
      "Failed to provide valid structured output after 5 attempts",
    ]) {
      expect(classifier.classify(message)).toEqual({
        kind: "structured_output_exhausted",
        message,
        retryable: false,
      });
      expect(classifier.classifyWithContinuation(message)).toEqual({
        failure: {
          kind: "structured_output_exhausted",
          message,
          retryable: false,
        },
        continuationDisposition: "retain",
      });
    }
  });

  it("classifies an undelivered-prompt query-session error as retryable session_died", () => {
    const err = tagQuerySessionError(
      new Error("QuerySession ended before the turn completed"),
      QUERY_SESSION_ERROR_CODES.promptNotDelivered,
    );
    expect(classifier.classify(err)).toEqual({
      kind: "session_died",
      message: "QuerySession ended before the turn completed",
      retryable: true,
    });
  });

  it("classifies mid-turn session death as non-retryable session_died", () => {
    const err = tagQuerySessionError(
      new Error("QuerySession closed while turn was in progress"),
      QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
    );
    expect(classifier.classify(err)).toEqual({
      kind: "session_died",
      message: "QuerySession closed while turn was in progress",
      retryable: false,
    });
  });

  it("lets stale-resume evidence outrank a QuerySession death tag", () => {
    const err = tagQuerySessionError(
      new Error("Session session-gone does not exist"),
      QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
    );

    expect(classifier.classify(err)).toEqual({
      kind: "stale_resume_ref",
      message: "Session session-gone does not exist",
      retryable: true,
    });
  });

  it("pairs a thrown stale-resume classification with the adapter's clear verdict", () => {
    const error = new Error("Session session-gone does not exist");

    expect(classifier.classifyWithContinuation(error)).toEqual({
      failure: {
        kind: "stale_resume_ref",
        message: error.message,
        retryable: true,
      },
      continuationDisposition: "clear",
    });
  });

  it("classifies a broken SDK pipe as non-retryable session_died", () => {
    const err = tagQuerySessionError(
      new Error("EPIPE writing to CLI"),
      QUERY_SESSION_ERROR_CODES.sdkPipeBroken,
    );
    expect(classifier.classify(err).kind).toBe("session_died");
    expect(classifier.classify(err).retryable).toBe(false);
  });

  it("classifies untagged QuerySession lifecycle messages as non-retryable session_died", () => {
    // The runtime folds QuerySession rejections into the turn result's error
    // text, where the error-code tag is lost — only the message shape remains.
    for (const message of [
      "QuerySession closed while turn was in progress",
      "QuerySession ended before the turn completed",
    ]) {
      expect(classifier.classify(message)).toEqual({
        kind: "session_died",
        message,
        retryable: false,
      });
      expect(classifier.classify(new Error(message)).kind).toBe("session_died");
    }
  });

  it("classifies stale-resume message shapes as retryable stale_resume_ref", () => {
    // The message-grep knowledge previously in
    // collaboration/agent-caller-production's getLikelyStaleResumeFailureMessage.
    for (const message of [
      "session abc-123 not found",
      "session abc-123 has expired",
      "cannot resume: transcript not found",
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

  it("does not classify a missing-file error without continuity nouns as stale", () => {
    expect(classifier.classify("config file not found").kind).toBe(
      "backend_error",
    );
  });

  it("retains the ref for expiry text that is not about the resumed session", () => {
    const message = "OAuth token expired for this session";
    expect(classifier.classifyWithContinuation(message)).toEqual({
      failure: { kind: "backend_error", message, retryable: false },
      continuationDisposition: "retain",
    });
  });

  it("maps everything else to non-retryable backend_error and never throws", () => {
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
    expect(classifier.classify(new Error("boom"))).toEqual({
      kind: "backend_error",
      message: "boom",
      retryable: false,
    });
  });
});
