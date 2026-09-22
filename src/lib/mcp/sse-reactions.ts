/**
 * MCP config/tools SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { mcpConfigKeys, mcpToolsKeys } from "@/lib/mcp/query-keys";
import {
  mcpConfigUpdatedEventSchema,
  mcpToolsUpdatedEventSchema,
} from "@/lib/mcp/schemas";
import { computeMcpConfigInvalidations } from "@/lib/mcp/sse-invalidation";

export interface McpSseReactionDeps {
  queryClient: QueryClient;
}

export function registerMcpSseReactions(
  es: EventSource,
  deps: McpSseReactionDeps,
): void {
  const { queryClient } = deps;

  addSseListener(
    es,
    "mcp-config-updated",
    mcpConfigUpdatedEventSchema,
    (data) => {
      // An override at any scope changes the resolved view at that scope and
      // every descendant scope, so we invalidate the whole subtree — not
      // just the emitting level.
      const invalidations = computeMcpConfigInvalidations(data);
      for (const matcher of invalidations) {
        void queryClient.invalidateQueries({ queryKey: matcher.queryKey });
      }
    },
  );

  addSseListener(
    es,
    "mcp-tools-updated",
    mcpToolsUpdatedEventSchema,
    (data) => {
      if (data.target) {
        void queryClient.invalidateQueries({
          queryKey: mcpToolsKeys.inventory(data.target, data.serverKey),
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: mcpToolsKeys.all });
      }
      void queryClient.invalidateQueries({ queryKey: mcpConfigKeys.all });
    },
  );
}
