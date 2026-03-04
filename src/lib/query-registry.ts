/**
 * Registry for active SDK Query objects.
 *
 * Stores references to running Query instances keyed by conversationId,
 * allowing queued messages to be delivered via `query.streamInput()`.
 *
 * Uses globalThis to survive HMR (same pattern as abort-registry.ts).
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "./logging";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("query-registry");

const GLOBAL_KEY = "__cc_active_queries" as const;

function getRegistry(): Map<string, Query> {
  return getGlobalSingleton(GLOBAL_KEY, () => new Map<string, Query>());
}

/**
 * Register an active Query for a running conversation.
 * Called when `executePromptStream` starts SDK execution.
 */
export function registerQuery(conversationId: string, q: Query): void {
  getRegistry().set(conversationId, q);
  logger.debug("query.registered", { conversationId });
}

/**
 * Retrieve the active Query for a conversation.
 * Returns undefined if no query is running.
 */
export function getQuery(conversationId: string): Query | undefined {
  return getRegistry().get(conversationId);
}

/**
 * Remove a registered Query (called on completion/cleanup).
 */
export function unregisterQuery(conversationId: string): void {
  getRegistry().delete(conversationId);
  logger.debug("query.unregistered", { conversationId });
}

/** Reset state for testing */
export function _resetForTesting(): void {
  getRegistry().clear();
}
