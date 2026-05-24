"use client";

import { useMemo } from "react";

import {
  useRefreshMcpToolsMutation,
  useResetMcpServerMutation,
  useResetMcpToolMutation,
  useToggleMcpServerMutation,
  useToggleMcpToolMutation,
  type McpMutationScope,
} from "@/lib/mcp/mutations";
import type { McpServerCardActions, McpServerView } from "./types";

/**
 * Builds the `McpServerCardActions` bundle for a given cascade scope, wiring
 * each user gesture to the matching TanStack mutation. Auto-promote semantics
 * are handled server-side: any `set-*-enabled` operation produces an override
 * at the scope level, regardless of whether the row was inherited.
 */
export function useMcpActions(
  scope: McpMutationScope,
  servers: readonly McpServerView[],
): McpServerCardActions {
  const toggleServer = useToggleMcpServerMutation(scope);
  const resetServer = useResetMcpServerMutation(scope);
  const toggleTool = useToggleMcpToolMutation(scope);
  const resetTool = useResetMcpToolMutation(scope);
  const refreshTools = useRefreshMcpToolsMutation(scope);

  return useMemo<McpServerCardActions>(() => {
    void servers;
    return {
      onToggleEnabled: (serverKey, nextEnabled) => {
        toggleServer.mutate({ serverKey, enabled: nextEnabled });
      },
      onOverride: (serverKey) => {
        const row = servers.find((s) => s.id === serverKey);
        const nextEnabled = row ? row.enabled : true;
        toggleServer.mutate({ serverKey, enabled: nextEnabled });
      },
      onResetToInherit: (serverKey) => {
        resetServer.mutate({ serverKey });
      },
      onToggleTool: (serverKey, toolName, nextEnabled) => {
        toggleTool.mutate({ serverKey, toolName, enabled: nextEnabled });
      },
      onResetTool: (serverKey, toolName) => {
        resetTool.mutate({ serverKey, toolName });
      },
      onRefreshTools: (serverKey) => {
        refreshTools.mutate(serverKey);
      },
      // First-open lazy-fetch. Re-using the refresh mutation keeps the
      // contract simple: the scoped tools POST populates the inventory cache
      // and broadcasts `mcp-tools-updated`, which invalidates the config view
      // so the next GET peek returns the populated inventory.
      onExpand: (serverKey) => {
        refreshTools.mutate(serverKey);
      },
    };
  }, [servers, toggleServer, resetServer, toggleTool, resetTool, refreshTools]);
}
