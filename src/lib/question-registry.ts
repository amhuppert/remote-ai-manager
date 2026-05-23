import { createLogger } from "./logging";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("question-registry");

interface PendingQuestion {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  conversationId: string;
  createdAt: number;
}

// Use globalThis to survive HMR (same pattern as sse-broadcaster.ts)
const GLOBAL_KEY = "__cc_pending_questions" as const;

function getRegistry(): Map<string, PendingQuestion> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<string, PendingQuestion>(),
  );
}

/**
 * Reject all pending questions for a given conversation (e.g., on abort).
 * Returns the number of questions rejected.
 */
export function rejectQuestionsForConversation(
  conversationId: string,
  reason: string,
): number {
  const registry = getRegistry();
  let count = 0;
  for (const [questionId, pending] of registry) {
    if (pending.conversationId === conversationId) {
      registry.delete(questionId);
      pending.reject(new Error(reason));
      count++;
      logger.debug("question.rejected_for_conversation", {
        questionId,
        conversationId,
      });
    }
  }
  return count;
}
