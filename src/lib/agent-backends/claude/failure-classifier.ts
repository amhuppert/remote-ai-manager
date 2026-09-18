import type {
  AgentFailureClassification,
  AgentFailureClassifier,
} from "../errors";
import {
  createClassifierWithDefaultContinuation,
  extractRetryAfterHint,
  failureMessage,
  isAbortFailure,
  isLikelyQuotaExhaustedMessage,
  isLikelyStaleResumeMessage,
  isTimeoutFailure,
} from "../errors";
import {
  isSdkPipeBrokenError,
  isSessionDiedMidTurnError,
  isUndeliveredQuerySessionError,
} from "./query-session-errors";

/**
 * QuerySession lifecycle rejections ("QuerySession closed while turn was in
 * progress", "QuerySession ended before the turn completed") sometimes reach
 * the classifier as bare message strings — the runtime folds them into the
 * turn result's error text, where the error-code tag is lost — so the message
 * shape is recognized in addition to the tagged detectors above.
 */
function isQuerySessionDeathMessage(message: string): boolean {
  return /^querysession (closed|ended|died)\b/i.test(message);
}

function isStructuredOutputRetryExhaustion(message: string): boolean {
  return (
    /\bexceeded structured output retry limit\b/i.test(message) ||
    /\bfailed to (?:produce|provide) valid structured output after (?:maximum retries|\d+ attempts?)\b/i.test(
      message,
    )
  );
}

/**
 * Claude failure classifier: normalizes QuerySession lifecycle errors, abort
 * and timeout shapes, stale-`resume:` provider messages and account capacity
 * refusals into the neutral `AgentFailureClassification` vocabulary.
 *
 * Retryability encodes the QuerySession delivery contract: an undelivered
 * prompt (`promptNotDelivered`) is safe to re-dispatch on a fresh runtime,
 * while a mid-turn death or broken pipe may have produced side effects and is
 * not. A stale resume ref is retryable because recovery (a fresh session) is
 * always available.
 */
export function createClaudeFailureClassifier(): AgentFailureClassifier {
  function classify(error: unknown): AgentFailureClassification {
    const stderr =
      error instanceof Error ? Reflect.get(error, "stderr") : undefined;
    const message =
      typeof stderr === "string" && stderr.length > 0
        ? `${failureMessage(error)}\n${stderr}`
        : failureMessage(error);
    if (isAbortFailure(error)) {
      return { kind: "aborted", message, retryable: false };
    }
    if (isTimeoutFailure(error)) {
      return { kind: "timeout", message, retryable: false };
    }
    if (isStructuredOutputRetryExhaustion(message)) {
      return {
        kind: "structured_output_exhausted",
        message,
        retryable: false,
      };
    }
    // Provider evidence that the resumed session no longer exists is more
    // specific than the QuerySession transport tag added while the pump
    // unwinds. The stale ref must be cleared even when that same error also
    // carries a local session-death code.
    if (isLikelyStaleResumeMessage(message)) {
      return { kind: "stale_resume_ref", message, retryable: true };
    }
    if (isUndeliveredQuerySessionError(error)) {
      return { kind: "session_died", message, retryable: true };
    }
    if (isSessionDiedMidTurnError(error) || isSdkPipeBrokenError(error)) {
      return { kind: "session_died", message, retryable: false };
    }
    if (isQuerySessionDeathMessage(message)) {
      return { kind: "session_died", message, retryable: false };
    }
    // Last: capacity refusals only reclaim messages that would otherwise fall
    // through to `backend_error`, so no earlier verdict changes.
    if (isLikelyQuotaExhaustedMessage(message)) {
      const retryAfterHint = extractRetryAfterHint(message);
      return {
        kind: "quota_exhausted",
        message,
        retryable: false,
        ...(retryAfterHint !== undefined ? { retryAfterHint } : {}),
      };
    }
    return { kind: "backend_error", message, retryable: false };
  }

  return createClassifierWithDefaultContinuation(classify);
}
