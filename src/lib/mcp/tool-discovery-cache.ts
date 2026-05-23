/**
 * Tool inventory cache keyed by `{ serverKey, configSignature }`.
 *
 * Signature-based invalidation is load-bearing: at any moment only one
 * configuration signature is cached per `serverKey`. When a caller presents
 * a different signature, the existing entry is evicted and a fresh fetch is
 * issued — whether or not another fetch is still in-flight for the old
 * signature. Late-arriving results from the old fetch are discarded; they
 * must not clobber the newer entry.
 *
 * Access paths:
 * - `getOrFetch` — async, awaits a ready/stale/error result. Dedupes
 *   concurrent calls for the *same* signature so parallel view requests
 *   share a single probe.
 * - `peek` — sync, inspects the current entry state. Returns `not-loaded`
 *   when no entry exists or when the requested signature does not match
 *   the cached one, so signature changes surface as immediate invalidation
 *   in the view layer.
 *
 * Completion listeners fire after every fetch settles (ready or error) so
 * the query layer can invalidate scoped views and surface orphan flags.
 */
import { createLogger } from "@/lib/logging";
import type { McpToolInventoryResult } from "@/lib/schemas";

const logger = createLogger("mcp.tool-discovery");

export interface ToolInventoryKey {
  serverKey: string;
  configSignature: string;
}

export interface ToolInventoryCacheFetcher {
  fetch(key: ToolInventoryKey): Promise<McpToolInventoryResult>;
}

export interface ToolInventoryCompletionEvent {
  serverKey: string;
  configSignature: string;
  result: McpToolInventoryResult;
}

type ToolInventoryCompletionListener = (
  event: ToolInventoryCompletionEvent,
) => void;

export interface ToolInventoryCache {
  getOrFetch(key: ToolInventoryKey): Promise<McpToolInventoryResult>;
  refresh(key: ToolInventoryKey): Promise<McpToolInventoryResult>;
  peek(key: ToolInventoryKey): McpToolInventoryResult;
  markStale(key: ToolInventoryKey): void;
  onCompletion(listener: ToolInventoryCompletionListener): () => void;
}

export interface ToolInventoryCacheDeps {
  fetcher: ToolInventoryCacheFetcher;
}

interface CacheEntry {
  configSignature: string;
  result: McpToolInventoryResult;
  inflight?: Promise<McpToolInventoryResult>;
}

function entryKey(key: Pick<ToolInventoryKey, "serverKey">): string {
  return key.serverKey;
}

const NOT_LOADED: McpToolInventoryResult = {
  state: "not-loaded",
  tools: [],
  diagnostics: [],
};

const LOADING: McpToolInventoryResult = {
  state: "loading",
  tools: [],
  diagnostics: [],
};

export function createToolInventoryCache(
  deps: ToolInventoryCacheDeps,
): ToolInventoryCache {
  const entries = new Map<string, CacheEntry>();
  const listeners = new Set<ToolInventoryCompletionListener>();

  function notify(key: ToolInventoryKey, result: McpToolInventoryResult): void {
    if (listeners.size === 0) return;
    const event: ToolInventoryCompletionEvent = {
      serverKey: key.serverKey,
      configSignature: key.configSignature,
      result,
    };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn("cache.listener_failed", {
          serverKey: key.serverKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function runFetch(key: ToolInventoryKey): Promise<McpToolInventoryResult> {
    const id = entryKey(key);

    // Normalize the fetcher's success/failure into an `McpToolInventoryResult`
    // so a single code path handles persistence and notification.
    const settled: Promise<McpToolInventoryResult> = deps.fetcher
      .fetch(key)
      .then((result) => result)
      .catch<McpToolInventoryResult>((err) => ({
        state: "error",
        tools: [],
        diagnostics: [
          {
            severity: "error",
            code: "mcp.cache.fetch_failed",
            message: err instanceof Error ? err.message : "cache fetch failed",
            serverKey: key.serverKey,
          },
        ],
      }));

    // Install a loading placeholder tagged with this signature. If a prior
    // entry (any signature) was cached, this replaces it — signature changes
    // evict eagerly.
    entries.set(id, {
      configSignature: key.configSignature,
      result: LOADING,
      inflight: settled,
    });

    // A late-arriving result from a superseded signature must NOT overwrite
    // the current entry. Guard by checking that the current entry's
    // signature still matches this fetch's signature before persisting.
    return settled.then((result) => {
      const current = entries.get(id);
      if (current?.configSignature === key.configSignature) {
        entries.set(id, {
          configSignature: key.configSignature,
          result,
        });
        notify(key, result);
      }
      return result;
    });
  }

  return {
    async getOrFetch(key) {
      const id = entryKey(key);
      const existing = entries.get(id);

      if (existing && existing.configSignature === key.configSignature) {
        if (existing.inflight) return existing.inflight;
        if (
          existing.result.state === "ready" ||
          existing.result.state === "error" ||
          existing.result.state === "stale"
        ) {
          return existing.result;
        }
      }

      // No entry, or entry has a stale signature — evict + refetch.
      return runFetch(key);
    },

    async refresh(key) {
      entries.delete(entryKey(key));
      return runFetch(key);
    },

    peek(key) {
      const existing = entries.get(entryKey(key));
      if (!existing) return NOT_LOADED;
      if (existing.configSignature !== key.configSignature) return NOT_LOADED;
      if (existing.inflight && existing.result.state !== "ready") {
        return LOADING;
      }
      return existing.result;
    },

    markStale(key) {
      const id = entryKey(key);
      const existing = entries.get(id);
      if (!existing) return;
      if (existing.configSignature !== key.configSignature) return;
      if (existing.result.state !== "ready") return;
      entries.set(id, {
        ...existing,
        result: { ...existing.result, state: "stale" },
      });
    },

    onCompletion(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
