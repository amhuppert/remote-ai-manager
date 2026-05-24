/**
 * Pure helpers that map an incoming MCP SSE event to the TanStack Query
 * invalidations required to keep every dependent scope in sync.
 *
 * The cascade resolves as: global → project → session → conversation. A change
 * at any ancestor level invalidates that level plus every descendant that
 * derives from it. This mirrors the four-level cascade in the resolver so the
 * UI sees the same effective config another client just patched.
 */

import { mcpConfigKeys } from "@/lib/mcp/query-keys";
import type { McpConfigLevel } from "@/lib/mcp/schemas";
export interface McpConfigEventIdentifiers {
  level: McpConfigLevel;
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
}

export interface McpQueryKeyMatcher {
  /** Exact prefix to invalidate, e.g. ["mcp-config"]. */
  queryKey: readonly unknown[];
}

/**
 * Returns the set of query-key prefixes to invalidate for a config event.
 *
 * Invariants:
 * - A `global` event invalidates every MCP config query.
 * - A `project` event invalidates the project view and every session and
 *   conversation view within that project (their resolved views depend on the
 *   project-level overrides).
 * - A `session` event invalidates the session view and every conversation view
 *   within that session.
 * - A `conversation` event invalidates only that conversation view.
 *
 * Every prefix is built from `mcpConfigKeys` so changes to the factory ripple
 * through the cascade without manual updates.
 */
export function computeMcpConfigInvalidations(
  event: McpConfigEventIdentifiers,
): readonly McpQueryKeyMatcher[] {
  if (event.level === "global") {
    return [{ queryKey: mcpConfigKeys.all }];
  }

  if (event.level === "project") {
    if (!event.projectName) return [];
    return [
      { queryKey: mcpConfigKeys.project(event.projectName) },
      { queryKey: mcpConfigKeys.sessionsInProject(event.projectName) },
      { queryKey: mcpConfigKeys.conversationsInProject(event.projectName) },
    ];
  }

  if (event.level === "session") {
    if (!event.projectName || !event.sessionName) return [];
    return [
      { queryKey: mcpConfigKeys.session(event.projectName, event.sessionName) },
      {
        queryKey: mcpConfigKeys.conversationsInSession(
          event.projectName,
          event.sessionName,
        ),
      },
    ];
  }

  if (!event.projectName || !event.sessionName || !event.conversationId) {
    return [];
  }
  return [
    {
      queryKey: mcpConfigKeys.conversation(
        event.projectName,
        event.sessionName,
        event.conversationId,
      ),
    },
  ];
}
