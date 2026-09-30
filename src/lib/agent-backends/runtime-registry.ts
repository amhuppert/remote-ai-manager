import type { ConversationBackendRuntime } from "./conversation";
import { createLogger } from "@/lib/logging";

const logger = createLogger("runtime-registry");

const runtimes = new Map<string, ConversationBackendRuntime>();
const receiptOwners = new WeakMap<
  ConversationBackendRuntime,
  (finish: () => Promise<void>) => boolean
>();

export function registerRuntime(
  conversationId: string,
  runtime: ConversationBackendRuntime,
  ownInputReceipt?: (finish: () => Promise<void>) => boolean,
): void {
  runtimes.set(conversationId, runtime);
  if (ownInputReceipt) receiptOwners.set(runtime, ownInputReceipt);
  else receiptOwners.delete(runtime);
  logger.debug("runtime.registered", {
    conversationId,
    backend: runtime.backend,
  });
}

/** Delegate receipt ownership to the host of the exact indexed runtime. */
export function ownRuntimeInputReceipt(
  conversationId: string,
  expected: ConversationBackendRuntime,
  finish: () => Promise<void>,
): boolean {
  if (runtimes.get(conversationId) !== expected) return false;
  return receiptOwners.get(expected)?.(finish) ?? false;
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
  receiptOwners.delete(expected);
  logger.debug("runtime.unregistered", { conversationId });
}

/** Reset state for testing */
export function _resetForTesting(): void {
  runtimes.clear();
}
