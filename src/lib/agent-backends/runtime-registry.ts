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

export function unregisterRuntime(
  conversationId: string,
  expected: ConversationBackendRuntime,
): void {
  if (runtimes.get(conversationId) !== expected) return;
  runtimes.delete(conversationId);
  logger.debug("runtime.unregistered", { conversationId });
}

/** Reset state for testing */
export function _resetForTesting(): void {
  runtimes.clear();
}
