import type {
  AgentFailureClassification,
  AgentFailureClassifier,
} from "../errors";
import {
  createClassifierWithDefaultContinuation,
  failureMessage,
  isAbortFailure,
  isLikelyStaleResumeMessage,
  isTimeoutFailure,
} from "../errors";

/**
 * Marker the Codex conversation runtime prefixes onto a resume failure this
 * classifier already recognized as stale (the runtime classifies the raw
 * provider error at its capture point, then enriches the message with the
 * attempted thread id). Recognized here so re-classifying a persisted
 * enriched message — e.g. a turn result's stored failure text — reaches the
 * same `stale_resume_ref` verdict as the original raw error.
 */
const RESUME_FAILURE_PREFIX = "failed to resume codex thread";

/**
 * Codex failure classifier: normalizes abort/timeout shapes and stale
 * thread-resume failures into the neutral `AgentFailureClassification`
 * vocabulary. A stale thread ref is retryable because recovery (a fresh
 * thread) is always available; everything else is a non-retryable
 * `backend_error` — `codex exec` re-materializes per turn, so there is no
 * live session whose death would warrant `session_died`.
 */
export function createCodexFailureClassifier(): AgentFailureClassifier {
  function classify(error: unknown): AgentFailureClassification {
    const message = failureMessage(error);
    if (isAbortFailure(error)) {
      return { kind: "aborted", message, retryable: false };
    }
    if (isTimeoutFailure(error)) {
      return { kind: "timeout", message, retryable: false };
    }
    if (
      message.toLowerCase().includes(RESUME_FAILURE_PREFIX) ||
      isLikelyStaleResumeMessage(message)
    ) {
      return { kind: "stale_resume_ref", message, retryable: true };
    }
    return { kind: "backend_error", message, retryable: false };
  }

  return createClassifierWithDefaultContinuation(classify);
}
