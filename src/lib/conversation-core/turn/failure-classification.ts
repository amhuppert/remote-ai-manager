/**
 * Backend failure classification for the conversation layer: one place that
 * turns an arbitrary failure value into the neutral
 * {@link AgentFailureClassification}, used by the turn actors and by the
 * `task_run` entrypoint that projects a finished turn for workflow callers.
 */

import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import type {
  AgentFailureClassification,
  AgentFailureClassifier,
} from "@/lib/agent-backends/errors";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";

/**
 * Used when the backend is not registered (test doubles outside the registry),
 * preserving the classifier's never-throw contract.
 */
const fallbackFailureClassifier: AgentFailureClassifier = {
  classify(error): AgentFailureClassification {
    return {
      kind: "backend_error",
      message: getErrorMessage(error),
      retryable: false,
    };
  },
  classifyWithContinuation(error) {
    return {
      failure: this.classify(error),
      continuationDisposition: "retain",
    };
  },
};

export function resolveFailureClassifierForBackend(
  backend: AgentBackendId,
): AgentFailureClassifier {
  try {
    return getBackendDescriptor(backend).errors;
  } catch {
    return fallbackFailureClassifier;
  }
}

export function classifyFailureForBackend(
  backend: AgentBackendId,
  error: unknown,
): AgentFailureClassification {
  return resolveFailureClassifierForBackend(backend).classify(error);
}
