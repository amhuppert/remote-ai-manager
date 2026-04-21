/**
 * Pure helpers that map an incoming MCP SSE event to the TanStack Query
 * invalidations required to keep every dependent scope in sync.
 *
 * The cascade resolves as: global → project → session → conversation. A change
 * at any ancestor level invalidates that level plus every descendant that
 * derives from it. This mirrors the four-level cascade in the resolver so the
 * UI sees the same effective config another client just patched.
 */

import type { McpConfigLevel } from "@/lib/schemas";

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
 * The `mcp-config` root segment is shared across all four scopes; the function
 * uses increasingly specific prefixes so TanStack's prefix-match invalidation
 * touches exactly the right subtree.
 */
export function computeMcpConfigInvalidations(
  event: McpConfigEventIdentifiers,
): readonly McpQueryKeyMatcher[] {
  const root = ["mcp-config"] as const;

  if (event.level === "global") {
    return [{ queryKey: root }];
  }

  if (event.level === "project") {
    if (!event.projectName) return [];
    return [
      { queryKey: [...root, "project", event.projectName] },
      { queryKey: [...root, "session", event.projectName] },
      { queryKey: [...root, "conversation", event.projectName] },
    ];
  }

  if (event.level === "session") {
    if (!event.projectName || !event.sessionName) return [];
    return [
      {
        queryKey: [...root, "session", event.projectName, event.sessionName],
      },
      {
        queryKey: [
          ...root,
          "conversation",
          event.projectName,
          event.sessionName,
        ],
      },
    ];
  }

  if (!event.projectName || !event.sessionName || !event.conversationId) {
    return [];
  }
  return [
    {
      queryKey: [
        ...root,
        "conversation",
        event.projectName,
        event.sessionName,
        event.conversationId,
      ],
    },
  ];
}
