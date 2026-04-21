/**
 * Wires tool-discovery completion into scoped MCP view invalidation.
 *
 * Every time a probe (or runtime status fetch) settles — ready, stale, or
 * error — any cached scoped view (global / project / session / conversation)
 * that references the affected `{ backend, serverKey }` may need to
 * re-render so orphan flags, tool filter states, and the live tool list
 * surface correctly. The cache itself is inert: it exposes an
 * `onCompletion` hook but never decides what "scoped view" means. This
 * module is the concrete caller that bridges the two.
 *
 * The `ScopedMcpViewInvalidator` interface is intentionally narrow so the
 * query-layer wiring (task 14.x) and SSE broadcast (task 13.2) can supply
 * their own implementation without this module taking a direct dependency
 * on either.
 */
import type { AgentBackendId } from "@/lib/agent-backends/types";
import { createLogger } from "@/lib/logging";

import type {
  ToolInventoryCache,
  ToolInventoryCompletionEvent,
} from "./tool-discovery-cache";

const logger = createLogger("mcp.tool-discovery");

export interface ScopedMcpViewInvalidator {
  invalidate(input: { backend: AgentBackendId; serverKey: string }): void;
}

export interface ToolDiscoveryInvalidationWiring {
  cache: Pick<ToolInventoryCache, "onCompletion">;
  invalidator: ScopedMcpViewInvalidator;
}

export function wireToolDiscoveryInvalidation(
  wiring: ToolDiscoveryInvalidationWiring,
): () => void {
  return wiring.cache.onCompletion((event: ToolInventoryCompletionEvent) => {
    try {
      wiring.invalidator.invalidate({
        backend: event.backend,
        serverKey: event.serverKey,
      });
    } catch (err) {
      logger.warn("invalidator.failed", {
        backend: event.backend,
        serverKey: event.serverKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
