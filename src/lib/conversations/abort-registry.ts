import { createLogger } from "../logging";
import {
  abortHandle,
  registerAbortHandle,
  unregisterAbortHandle,
  type AbortHandleKey,
} from "@/lib/shared/abort-registry";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";

/**
 * Conversation-scoped view over the shared abort registry
 * (`@/lib/shared/abort-registry`, scope `conversation:*`). This module owns
 * the domain semantics: aborting a conversation also closes its backend
 * runtime so the active session terminates and the next prompt resumes fresh.
 */

const logger = createLogger("abort-registry.conversation");

function keyFor(conversationId: string): AbortHandleKey {
  return `conversation:${conversationId}`;
}

/**
 * Register an AbortController for a running conversation.
 * Called when `executePromptStream` starts SDK execution.
 * @public Accessed via dynamic `import()` in actor-implementations.
 */
export function registerAbortController(
  conversationId: string,
  controller: AbortController,
): void {
  registerAbortHandle(keyFor(conversationId), controller);
}

/**
 * Remove a registered AbortController (called on normal completion).
 * Compare-and-delete: a turn's teardown may run after a replacement turn
 * has registered its own controller under the same conversation id (abort →
 * immediate re-dispatch), and an id-only delete would strip the live turn's
 * controller, making it uncancellable.
 * @public Accessed via dynamic `import()` in actor-implementations.
 */
export function unregisterAbortController(
  conversationId: string,
  controller: AbortController,
): void {
  unregisterAbortHandle(keyFor(conversationId), controller);
}

/**
 * Abort a running conversation's SDK execution.
 * Returns true if a running controller was found and aborted.
 */
export function abortConversation(conversationId: string): boolean {
  const aborted = abortHandle(keyFor(conversationId));
  if (!aborted) return false;

  // Also close the backend runtime to terminate any active session.
  // The next prompt will create a fresh runtime with resume. Abort reports the
  // signal synchronously and orders no destructive follow-up work, so teardown
  // runs to completion in the background; a failure is recorded rather than
  // left as an unhandled rejection.
  try {
    void getRuntime(conversationId)
      ?.close()
      .catch((err: unknown) => {
        logger.warn("abort.runtime_close_error", {
          conversationId,
          error: String(err),
        });
      });
  } catch {
    // best-effort
  }

  logger.info("abort.conversation_signaled", { conversationId });
  return true;
}
