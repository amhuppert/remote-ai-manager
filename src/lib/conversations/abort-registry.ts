import {
  registerAbortHandle,
  unregisterAbortHandle,
  type AbortHandleKey,
} from "@/lib/shared/abort-registry";

/**
 * Conversation-scoped view over the shared abort registry
 * (`@/lib/shared/abort-registry`, scope `conversation:*`). This module owns
 * the domain index: signalling its controller requests cancellation from the
 * admitted attempt, which owns backend teardown and completion.
 */

function keyFor(conversationId: string): AbortHandleKey {
  return `conversation:${conversationId}`;
}

/**
 * Register an AbortController for a running conversation.
 * Registered by the lifecycle when it admits an attempt.
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
 */
export function unregisterAbortController(
  conversationId: string,
  controller: AbortController,
): void {
  unregisterAbortHandle(keyFor(conversationId), controller);
}
