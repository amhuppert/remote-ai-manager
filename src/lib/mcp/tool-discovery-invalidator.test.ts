import { describe, expect, it, vi } from "vitest";

import type { AgentBackendId } from "@/lib/agent-backends/types";
import type { McpToolInventoryResult } from "@/lib/schemas";

import {
  createToolInventoryCache,
  type ToolInventoryCacheFetcher,
  type ToolInventoryKey,
} from "./tool-discovery-cache";
import {
  wireToolDiscoveryInvalidation,
  type ScopedMcpViewInvalidator,
} from "./tool-discovery-invalidator";

function readyResult(name = "t"): McpToolInventoryResult {
  return {
    state: "ready",
    tools: [{ name }],
    diagnostics: [],
    refreshedAt: "2025-01-01T00:00:00Z",
  };
}

function errorResult(): McpToolInventoryResult {
  return {
    state: "error",
    tools: [],
    diagnostics: [
      { severity: "error", code: "err", message: "x", serverKey: "srv" },
    ],
  };
}

function makeFetcher(
  impl: (key: ToolInventoryKey) => Promise<McpToolInventoryResult>,
): ToolInventoryCacheFetcher {
  return { fetch: impl };
}

const claudeKey = (serverKey: string, sig = "sig-a"): ToolInventoryKey => ({
  backend: "claude" as AgentBackendId,
  serverKey,
  configSignature: sig,
});

describe("wireToolDiscoveryInvalidation", () => {
  it("invalidates scoped views for the affected server on completion", async () => {
    const cache = createToolInventoryCache({
      fetcher: makeFetcher(async () => readyResult("t1")),
    });
    const invalidator: ScopedMcpViewInvalidator = {
      invalidate: vi.fn(),
    };

    wireToolDiscoveryInvalidation({ cache, invalidator });

    await cache.getOrFetch(claudeKey("srv1"));

    expect(invalidator.invalidate).toHaveBeenCalledTimes(1);
    expect(invalidator.invalidate).toHaveBeenCalledWith({
      backend: "claude",
      serverKey: "srv1",
    });
  });

  it("invalidates on failed discovery as well (orphan flags react to either terminal state)", async () => {
    const cache = createToolInventoryCache({
      fetcher: makeFetcher(async () => errorResult()),
    });
    const invalidator: ScopedMcpViewInvalidator = {
      invalidate: vi.fn(),
    };

    wireToolDiscoveryInvalidation({ cache, invalidator });

    await cache.getOrFetch(claudeKey("srv1"));

    expect(invalidator.invalidate).toHaveBeenCalledTimes(1);
    expect(invalidator.invalidate).toHaveBeenCalledWith({
      backend: "claude",
      serverKey: "srv1",
    });
  });

  it("invalidates per refresh, once per affected server", async () => {
    const cache = createToolInventoryCache({
      fetcher: makeFetcher(async () => readyResult("t1")),
    });
    const invalidator: ScopedMcpViewInvalidator = {
      invalidate: vi.fn(),
    };

    wireToolDiscoveryInvalidation({ cache, invalidator });

    await cache.getOrFetch(claudeKey("srv-a"));
    await cache.refresh(claudeKey("srv-a"));
    await cache.getOrFetch(claudeKey("srv-b"));

    expect(invalidator.invalidate).toHaveBeenCalledTimes(3);
    expect(invalidator.invalidate).toHaveBeenNthCalledWith(1, {
      backend: "claude",
      serverKey: "srv-a",
    });
    expect(invalidator.invalidate).toHaveBeenNthCalledWith(2, {
      backend: "claude",
      serverKey: "srv-a",
    });
    expect(invalidator.invalidate).toHaveBeenNthCalledWith(3, {
      backend: "claude",
      serverKey: "srv-b",
    });
  });

  it("returns an unsubscribe that stops further invalidations", async () => {
    const cache = createToolInventoryCache({
      fetcher: makeFetcher(async () => readyResult("t1")),
    });
    const invalidator: ScopedMcpViewInvalidator = {
      invalidate: vi.fn(),
    };

    const unsubscribe = wireToolDiscoveryInvalidation({ cache, invalidator });
    unsubscribe();

    await cache.getOrFetch(claudeKey("srv1"));

    expect(invalidator.invalidate).not.toHaveBeenCalled();
  });

  it("does not let an invalidator error break the cache's notify loop", async () => {
    const cache = createToolInventoryCache({
      fetcher: makeFetcher(async () => readyResult("t1")),
    });
    const invalidator: ScopedMcpViewInvalidator = {
      invalidate: vi.fn(() => {
        throw new Error("invalidation boom");
      }),
    };

    wireToolDiscoveryInvalidation({ cache, invalidator });

    await expect(cache.getOrFetch(claudeKey("srv1"))).resolves.toMatchObject({
      state: "ready",
    });
  });
});
