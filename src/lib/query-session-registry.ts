/**
 * Registry for active QuerySession objects.
 *
 * Stores references to running QuerySession instances keyed by conversationId,
 * allowing prompt execution to reuse existing subprocess connections.
 *
 * Uses globalThis to survive HMR (same pattern as abort-registry.ts).
 */

import type { QuerySession } from "./query-session";
import { createLogger } from "./logging";
import { getGlobalSingleton } from "./global-singleton";

const logger = createLogger("query-session-registry");

const GLOBAL_KEY = "__cc_active_query_sessions" as const;

function getRegistry(): Map<string, QuerySession> {
  return getGlobalSingleton(GLOBAL_KEY, () => new Map<string, QuerySession>());
}

/**
 * Register an active QuerySession for a conversation.
 * Called when a new long-lived query is created for a conversation.
 */
export function registerSession(
  conversationId: string,
  session: QuerySession,
): void {
  getRegistry().set(conversationId, session);
  logger.debug("query-session.registered", { conversationId });
}

/**
 * Retrieve the active QuerySession for a conversation.
 * Returns undefined if no session exists.
 */
export function getSession(conversationId: string): QuerySession | undefined {
  return getRegistry().get(conversationId);
}

/**
 * Remove a registered QuerySession (called on close/crash).
 */
export function unregisterSession(conversationId: string): void {
  getRegistry().delete(conversationId);
  logger.debug("query-session.unregistered", { conversationId });
}

/**
 * Close all active sessions and clear the registry.
 * Called during server shutdown to clean up orphaned subprocesses.
 */
export function closeAllSessions(): void {
  const registry = getRegistry();
  for (const [conversationId, session] of registry) {
    logger.info("query-session.closing_all", { conversationId });
    session.close();
  }
  registry.clear();
}

/** Reset state for testing */
export function _resetForTesting(): void {
  getRegistry().clear();
}
