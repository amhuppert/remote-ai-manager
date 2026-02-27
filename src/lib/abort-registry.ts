import { createLogger } from "./logging";

const logger = createLogger("abort-registry");

// Use globalThis to survive HMR (same pattern as sse-broadcaster.ts)
const GLOBAL_KEY = "__cc_abort_controllers" as const;

function getRegistry(): Map<string, AbortController> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, AbortController>();
  }
  return g[GLOBAL_KEY] as Map<string, AbortController>;
}

/**
 * Register an AbortController for a running conversation.
 * Called when `executePromptStream` starts SDK execution.
 */
export function registerAbortController(
  conversationId: string,
  controller: AbortController,
): void {
  getRegistry().set(conversationId, controller);
  logger.debug("abort.registered", { conversationId });
}

/**
 * Remove a registered AbortController (called on normal completion).
 */
export function unregisterAbortController(conversationId: string): void {
  getRegistry().delete(conversationId);
  logger.debug("abort.unregistered", { conversationId });
}

/**
 * Abort a running conversation's SDK execution.
 * Returns true if a running controller was found and aborted.
 */
export function abortConversation(conversationId: string): boolean {
  const registry = getRegistry();
  const controller = registry.get(conversationId);
  if (!controller) return false;

  registry.delete(conversationId);
  controller.abort();
  logger.info("abort.signaled", { conversationId });
  return true;
}

/** Reset state for testing */
export function _resetForTesting(): void {
  getRegistry().clear();
}
