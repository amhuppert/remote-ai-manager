import type { ConversationBackendRuntime } from "./conversation";
import { createLogger } from "@/lib/logging";

const logger = createLogger("runtime-registry");

const runtimes = new Map<string, ConversationBackendRuntime>();

export function registerRuntime(
  conversationId: string,
  runtime: ConversationBackendRuntime,
): void {
  runtimes.set(conversationId, runtime);
  logger.debug("runtime.registered", {
    conversationId,
    backend: runtime.backend,
  });
}

export function getRuntime(
  conversationId: string,
): ConversationBackendRuntime | undefined {
  return runtimes.get(conversationId);
}

export function unregisterRuntime(conversationId: string): void {
  runtimes.delete(conversationId);
  logger.debug("runtime.unregistered", { conversationId });
}

export function closeAllRuntimes(): void {
  const count = runtimes.size;
  logger.info("runtime.close_all", { count });
  for (const [conversationId, runtime] of runtimes) {
    try {
      runtime.close();
    } catch (err) {
      logger.error("runtime.close_error", {
        conversationId,
        error: String(err),
      });
    }
  }
  runtimes.clear();
}

/** Reset state for testing */
export function _resetForTesting(): void {
  runtimes.clear();
}
