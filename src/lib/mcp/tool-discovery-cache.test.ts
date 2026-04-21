import { describe, expect, it, vi } from "vitest";

import type { McpDiscoveredTool, McpToolInventoryResult } from "@/lib/schemas";

import {
  createToolInventoryCache,
  type ToolInventoryCacheFetcher,
  type ToolInventoryKey,
} from "./tool-discovery-cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readyResult(tools: McpDiscoveredTool[]): McpToolInventoryResult {
  return {
    state: "ready",
    tools,
    diagnostics: [],
    refreshedAt: "2025-01-01T00:00:00Z",
  };
}

function errorResult(code: string): McpToolInventoryResult {
  return {
    state: "error",
    tools: [],
    diagnostics: [{ severity: "error", code, message: "err", serverKey: "s" }],
  };
}

function mkKey(partial: Partial<ToolInventoryKey> = {}): ToolInventoryKey {
  return {
    backend: partial.backend ?? "claude",
    serverKey: partial.serverKey ?? "srv1",
    configSignature: partial.configSignature ?? "sig-a",
  };
}

function stubFetcher(
  impl: (
    key: ToolInventoryKey,
    call: number,
  ) => Promise<McpToolInventoryResult>,
): ToolInventoryCacheFetcher & { calls: number; keys: ToolInventoryKey[] } {
  let calls = 0;
  const keys: ToolInventoryKey[] = [];
  const fetcher = {
    async fetch(key: ToolInventoryKey) {
      calls += 1;
      keys.push(key);
      return impl(key, calls);
    },
    keys,
  } as ToolInventoryCacheFetcher & { calls: number; keys: ToolInventoryKey[] };
  Object.defineProperty(fetcher, "calls", {
    get: () => calls,
    enumerable: true,
  });
  return fetcher;
}

// ---------------------------------------------------------------------------
// Cache hits & signature invalidation
// ---------------------------------------------------------------------------

describe("createToolInventoryCache — basic caching", () => {
  it("returns the cached result when the signature is unchanged", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t1" }]));
    const cache = createToolInventoryCache({ fetcher });

    const a = await cache.getOrFetch(mkKey());
    const b = await cache.getOrFetch(mkKey());

    expect(a.tools.map((t) => t.name)).toEqual(["t1"]);
    expect(b.tools.map((t) => t.name)).toEqual(["t1"]);
    expect(fetcher.calls).toBe(1);
  });

  it("re-fetches when the signature changes (signature invalidation)", async () => {
    const fetcher = stubFetcher(async (_k, n) =>
      readyResult([{ name: `v${n}` }]),
    );
    const cache = createToolInventoryCache({ fetcher });

    const a = await cache.getOrFetch(mkKey({ configSignature: "sig-a" }));
    const b = await cache.getOrFetch(mkKey({ configSignature: "sig-b" }));

    expect(a.tools.map((t) => t.name)).toEqual(["v1"]);
    expect(b.tools.map((t) => t.name)).toEqual(["v2"]);
    expect(fetcher.calls).toBe(2);
  });

  it("peek returns not-loaded when no entry exists", () => {
    const fetcher = stubFetcher(async () => readyResult([]));
    const cache = createToolInventoryCache({ fetcher });

    expect(cache.peek(mkKey())).toEqual({
      state: "not-loaded",
      tools: [],
      diagnostics: [],
    });
  });

  it("peek returns loading while discovery is in flight", async () => {
    let resolve: ((r: McpToolInventoryResult) => void) | undefined;
    const fetcher: ToolInventoryCacheFetcher = {
      fetch() {
        return new Promise<McpToolInventoryResult>((r) => {
          resolve = r;
        });
      },
    };
    const cache = createToolInventoryCache({ fetcher });

    const pending = cache.getOrFetch(mkKey());
    const mid = cache.peek(mkKey());
    expect(mid.state).toBe("loading");

    resolve?.(readyResult([{ name: "t" }]));
    await pending;
  });

  it("peek returns ready after a successful fetch", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t" }]));
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey());
    expect(cache.peek(mkKey()).state).toBe("ready");
  });

  it("peek returns error after a failed fetch", async () => {
    const fetcher = stubFetcher(async () => errorResult("mcp.err"));
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey());
    expect(cache.peek(mkKey()).state).toBe("error");
  });

  it("markStale transitions a ready entry to stale without dropping tools", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t1" }]));
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey());
    cache.markStale(mkKey());
    const peek = cache.peek(mkKey());

    expect(peek.state).toBe("stale");
    expect(peek.tools.map((t) => t.name)).toEqual(["t1"]);
  });

  it("peek returns not-loaded when cached entry has a different signature", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t1" }]));
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey({ configSignature: "sig-a" }));

    const peeked = cache.peek(mkKey({ configSignature: "sig-b" }));

    expect(peeked).toEqual({
      state: "not-loaded",
      tools: [],
      diagnostics: [],
    });
  });

  it("peek returns not-loaded when a stale signature is requested after markStale", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t1" }]));
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey({ configSignature: "sig-a" }));
    cache.markStale(mkKey({ configSignature: "sig-a" }));

    expect(cache.peek(mkKey({ configSignature: "sig-b" })).state).toBe(
      "not-loaded",
    );
    expect(cache.peek(mkKey({ configSignature: "sig-a" })).state).toBe("stale");
  });

  it("getOrFetch with a different signature while a fetch is in-flight starts a new fetch", async () => {
    const resolvers: Array<(r: McpToolInventoryResult) => void> = [];
    let calls = 0;
    const keysSeen: ToolInventoryKey[] = [];
    const fetcher: ToolInventoryCacheFetcher = {
      fetch(key) {
        calls += 1;
        keysSeen.push(key);
        return new Promise<McpToolInventoryResult>((r) => {
          resolvers.push(r);
        });
      },
    };
    const cache = createToolInventoryCache({ fetcher });

    const a = cache.getOrFetch(mkKey({ configSignature: "sig-a" }));
    const b = cache.getOrFetch(mkKey({ configSignature: "sig-b" }));

    expect(calls).toBe(2);
    expect(keysSeen.map((k) => k.configSignature)).toEqual(["sig-a", "sig-b"]);

    resolvers[1]?.(readyResult([{ name: "fresh" }]));
    resolvers[0]?.(readyResult([{ name: "stale" }]));

    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult.tools.map((t) => t.name)).toEqual(["stale"]);
    expect(bResult.tools.map((t) => t.name)).toEqual(["fresh"]);

    // The winning entry must be the sig-b result — the older sig-a fetch must
    // not clobber the newer entry even though it settles last.
    const peeked = cache.peek(mkKey({ configSignature: "sig-b" }));
    expect(peeked.state).toBe("ready");
    expect(peeked.tools.map((t) => t.name)).toEqual(["fresh"]);
  });

  it("dedupes concurrent getOrFetch calls for the same key", async () => {
    let resolve: ((r: McpToolInventoryResult) => void) | undefined;
    let calls = 0;
    const fetcher: ToolInventoryCacheFetcher = {
      fetch() {
        calls += 1;
        return new Promise<McpToolInventoryResult>((r) => {
          resolve = r;
        });
      },
    };
    const cache = createToolInventoryCache({ fetcher });

    const a = cache.getOrFetch(mkKey());
    const b = cache.getOrFetch(mkKey());
    expect(calls).toBe(1);

    resolve?.(readyResult([{ name: "t" }]));
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-server refresh & isolation
// ---------------------------------------------------------------------------

describe("createToolInventoryCache — refresh", () => {
  it("forces re-discovery for one server without affecting other entries", async () => {
    const fetcher = stubFetcher(async (k, n) =>
      readyResult([{ name: `${k.serverKey}-${n}` }]),
    );
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey({ serverKey: "a" })); // call 1 — a
    await cache.getOrFetch(mkKey({ serverKey: "b" })); // call 2 — b
    expect(fetcher.calls).toBe(2);

    const refreshed = await cache.refresh(mkKey({ serverKey: "a" })); // call 3

    expect(refreshed.tools.map((t) => t.name)).toEqual(["a-3"]);
    expect(fetcher.calls).toBe(3);
    // b's entry remains untouched
    expect(
      cache.peek(mkKey({ serverKey: "b" })).tools.map((t) => t.name),
    ).toEqual(["b-2"]);
  });

  it("refresh replaces the cached entry and subsequent getOrFetch returns it", async () => {
    const fetcher = stubFetcher(async (_k, n) =>
      readyResult([{ name: `v${n}` }]),
    );
    const cache = createToolInventoryCache({ fetcher });

    await cache.getOrFetch(mkKey());
    await cache.refresh(mkKey());
    const after = await cache.getOrFetch(mkKey());

    expect(after.tools.map((t) => t.name)).toEqual(["v2"]);
    expect(fetcher.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Completion listeners — used to invalidate scoped view queries
// ---------------------------------------------------------------------------

describe("createToolInventoryCache — onCompletion", () => {
  it("notifies subscribers after getOrFetch completes", async () => {
    const fetcher = stubFetcher(async () => readyResult([{ name: "t" }]));
    const cache = createToolInventoryCache({ fetcher });
    const listener = vi.fn();
    const unsubscribe = cache.onCompletion(listener);

    await cache.getOrFetch(mkKey());

    expect(listener).toHaveBeenCalledTimes(1);
    const [event] = listener.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      backend: "claude",
      serverKey: "srv1",
      result: { state: "ready" },
    });

    unsubscribe();
  });

  it("notifies subscribers after refresh completes", async () => {
    const fetcher = stubFetcher(async () => readyResult([]));
    const cache = createToolInventoryCache({ fetcher });
    const listener = vi.fn();
    cache.onCompletion(listener);

    await cache.refresh(mkKey());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", async () => {
    const fetcher = stubFetcher(async () => readyResult([]));
    const cache = createToolInventoryCache({ fetcher });
    const listener = vi.fn();
    const unsubscribe = cache.onCompletion(listener);
    unsubscribe();

    await cache.getOrFetch(mkKey());

    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies on failed fetch as well (error is still a completion)", async () => {
    const fetcher = stubFetcher(async () => errorResult("mcp.err"));
    const cache = createToolInventoryCache({ fetcher });
    const listener = vi.fn();
    cache.onCompletion(listener);

    await cache.getOrFetch(mkKey());

    expect(listener).toHaveBeenCalledTimes(1);
    const [event] = listener.mock.calls[0] ?? [];
    expect(event.result.state).toBe("error");
  });
});
