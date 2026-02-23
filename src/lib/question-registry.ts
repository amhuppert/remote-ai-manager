import { createLogger } from "./logging";

const logger = createLogger("question-registry");

interface PendingQuestion {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  conversationId: string;
  createdAt: number;
}

// Use globalThis to survive HMR (same pattern as sse-broadcaster.ts)
const GLOBAL_KEY = "__csm_pending_questions" as const;

function getRegistry(): Map<string, PendingQuestion> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, PendingQuestion>();
  }
  return g[GLOBAL_KEY] as Map<string, PendingQuestion>;
}

/**
 * Register a pending question and return a Promise that resolves
 * when the user submits an answer via the answer API.
 */
export function registerQuestion(
  questionId: string,
  conversationId: string,
): Promise<Record<string, string>> {
  const registry = getRegistry();

  return new Promise<Record<string, string>>((resolve, reject) => {
    registry.set(questionId, {
      resolve,
      reject,
      conversationId,
      createdAt: Date.now(),
    });
    logger.debug("question.registered", { questionId, conversationId });
  });
}

/**
 * Resolve a pending question with user-provided answers.
 * Returns true if the question existed and was resolved.
 */
export function resolveQuestion(
  questionId: string,
  answers: Record<string, string>,
): boolean {
  const registry = getRegistry();
  const pending = registry.get(questionId);
  if (!pending) {
    logger.warn("question.not_found", { questionId });
    return false;
  }

  registry.delete(questionId);
  pending.resolve(answers);
  logger.debug("question.resolved", { questionId });
  return true;
}

/**
 * Reject a pending question (e.g., on session abort).
 */
export function rejectQuestion(questionId: string, reason: string): boolean {
  const registry = getRegistry();
  const pending = registry.get(questionId);
  if (!pending) return false;

  registry.delete(questionId);
  pending.reject(new Error(reason));
  return true;
}

/**
 * Check if a conversation has any pending questions.
 */
export function hasPendingQuestion(conversationId: string): boolean {
  const registry = getRegistry();
  for (const entry of registry.values()) {
    if (entry.conversationId === conversationId) return true;
  }
  return false;
}

/** Reset state for testing */
export function _resetForTesting(): void {
  getRegistry().clear();
}
