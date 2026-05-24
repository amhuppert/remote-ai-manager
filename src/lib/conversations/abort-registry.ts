import { createLogger } from "../logging";
import { getGlobalSingleton } from "../shared/global-singleton";
import { getRuntime } from "@/lib/agent-backends/runtime-registry";

const logger = createLogger("abort-registry");

// Use globalThis to survive HMR (same pattern as sse-broadcaster.ts)
const GLOBAL_KEY = "__cc_abort_controllers" as const;

function getRegistry(): Map<string, AbortController> {
  return getGlobalSingleton(
    GLOBAL_KEY,
    () => new Map<string, AbortController>(),
  );
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
  getRegistry().set(conversationId, controller);
  logger.debug("abort.registered", { conversationId });
}

/**
 * Remove a registered AbortController (called on normal completion).
 * @public Accessed via dynamic `import()` in actor-implementations.
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

  // Also close the backend runtime to terminate any active session.
  // The next prompt will create a fresh runtime with resume.
  try {
    getRuntime(conversationId)?.close();
  } catch {
    // best-effort
  }

  logger.info("abort.signaled", { conversationId });
  return true;
}
