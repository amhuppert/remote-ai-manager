import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilityCascadeKind,
  AgentCapabilityScopeContext,
} from "@/lib/schemas";
import { _resetLoggerForTesting } from "@/lib/logging/logger";

import {
  createAgentCapabilityDiscoveryCache,
  discoverBackendCapabilities,
  runDiscoveryThroughCache,
} from "./discovery-cache";

const globalScope: AgentCapabilityScopeContext = { level: "global" };

const projectScope: AgentCapabilityScopeContext = {
  level: "project",
  projectName: "demo",
};

const originalLogFile = process.env["CC_LOG_FILE"];
const originalLogLevel = process.env["CC_LOG_LEVEL"];
const originalLogSilent = process.env["CC_LOG_SILENT"];

afterEach(() => {
  if (originalLogFile === undefined) {
    delete process.env["CC_LOG_FILE"];
  } else {
    process.env["CC_LOG_FILE"] = originalLogFile;
  }
  if (originalLogLevel === undefined) {
    delete process.env["CC_LOG_LEVEL"];
  } else {
    process.env["CC_LOG_LEVEL"] = originalLogLevel;
  }
  if (originalLogSilent === undefined) {
    delete process.env["CC_LOG_SILENT"];
  } else {
    process.env["CC_LOG_SILENT"] = originalLogSilent;
  }
  _resetLoggerForTesting();
});

type Inventory = {
  cascadeKind: AgentCapabilityCascadeKind;
  items: readonly { itemId: string }[];
  diagnostics: readonly { code: string }[];
  sourceSignature: string;
  refreshedAt: string;
};

function fakeInventory(
  cascadeKind: AgentCapabilityCascadeKind,
  sourceSignature: string,
  items: readonly string[] = [],
  diagnostics: readonly string[] = [],
): Inventory {
  return {
    cascadeKind,
    items: items.map((itemId) => ({ itemId })),
    diagnostics: diagnostics.map((code) => ({ code })),
    sourceSignature,
    refreshedAt: new Date().toISOString(),
  };
}

describe("createAgentCapabilityDiscoveryCache", () => {
  it("scopes cache entries by cascade and scope context", () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const a = fakeInventory("claude-skills", "sig-a", ["x"]);
    cache.set("claude-skills", globalScope, a);
    cache.set(
      "claude-skills",
      { level: "project", projectName: "other" },
      fakeInventory("claude-skills", "sig-b", ["y"]),
    );

    expect(cache.get("claude-skills", globalScope)?.sourceSignature).toBe(
      "sig-a",
    );
    expect(
      cache.get("claude-skills", {
        level: "project",
        projectName: "other",
      })?.sourceSignature,
    ).toBe("sig-b");
    // Different cascade kind is a different cache entry even at the same scope.
    expect(cache.get("claude-plugins", globalScope)).toBeUndefined();
  });

  it("invalidate() drops a single entry without disturbing the others", () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    cache.set(
      "claude-skills",
      globalScope,
      fakeInventory("claude-skills", "sig-a"),
    );
    cache.set(
      "claude-plugins",
      globalScope,
      fakeInventory("claude-plugins", "sig-b"),
    );
    cache.invalidate("claude-skills", globalScope);
    expect(cache.get("claude-skills", globalScope)).toBeUndefined();
    expect(cache.get("claude-plugins", globalScope)?.sourceSignature).toBe(
      "sig-b",
    );
  });
});

describe("runDiscoveryThroughCache", () => {
  it("calls the fetcher on the first request and stores its result", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const fetcher = vi
      .fn()
      .mockResolvedValue(fakeInventory("claude-skills", "sig-1", ["a"]));

    const result = await runDiscoveryThroughCache({
      cache,
      cascadeKind: "claude-skills",
      scope: globalScope,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.sourceSignature).toBe("sig-1");
    expect(cache.get("claude-skills", globalScope)?.sourceSignature).toBe(
      "sig-1",
    );
  });

  it("returns the cached object reference when the new signature equals the cached one", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const cached = fakeInventory("claude-skills", "sig-1", ["a"]);
    cache.set("claude-skills", globalScope, cached);

    const fetcher = vi
      .fn()
      .mockResolvedValue(fakeInventory("claude-skills", "sig-1", ["a"]));

    const result = await runDiscoveryThroughCache({
      cache,
      cascadeKind: "claude-skills",
      scope: globalScope,
      fetcher,
    });

    // Object identity is the contract; downstream React Query keys rely on it.
    expect(result).toBe(cached);
  });

  it("replaces the cached entry when the new signature differs", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    cache.set(
      "claude-skills",
      globalScope,
      fakeInventory("claude-skills", "old"),
    );
    const fresh = fakeInventory("claude-skills", "new", ["a"]);
    const fetcher = vi.fn().mockResolvedValue(fresh);

    const result = await runDiscoveryThroughCache({
      cache,
      cascadeKind: "claude-skills",
      scope: globalScope,
      fetcher,
    });

    expect(result).toBe(fresh);
    expect(cache.get("claude-skills", globalScope)?.sourceSignature).toBe(
      "new",
    );
  });

  it("force=true bypasses the cached value even when signatures match", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const cached = fakeInventory("claude-skills", "sig-1");
    cache.set("claude-skills", globalScope, cached);

    const fresh = fakeInventory("claude-skills", "sig-1");
    const fetcher = vi.fn().mockResolvedValue(fresh);

    const result = await runDiscoveryThroughCache({
      cache,
      cascadeKind: "claude-skills",
      scope: globalScope,
      fetcher,
      force: true,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    // Even with the same signature, force returns the freshly fetched object
    // so manual refresh updates `refreshedAt`-style fields.
    expect(result).toBe(fresh);
  });

  it("preserves the previous cached entry when the fetcher throws", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const cached = fakeInventory("claude-skills", "sig-1", ["a"]);
    cache.set("claude-skills", globalScope, cached);

    const fetcher = vi.fn().mockRejectedValue(new Error("filesystem blew up"));

    await expect(
      runDiscoveryThroughCache({
        cache,
        cascadeKind: "claude-skills",
        scope: globalScope,
        fetcher,
      }),
    ).rejects.toThrow("filesystem blew up");

    expect(cache.get("claude-skills", globalScope)).toBe(cached);
  });
});

describe("discoverBackendCapabilities", () => {
  function fetcher(sig: string, items: readonly string[] = []) {
    return vi
      .fn<() => Promise<Inventory>>()
      .mockImplementation(async () =>
        fakeInventory("claude-skills", sig, items),
      );
  }

  it("returns one inventory per cascade and uses the cache on a re-run", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const skills = fetcher("sk-1", ["a"]);
    const plugins = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-plugins", "pl-1", ["p"]));
    const agents = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-agents", "ag-1", ["g"]));

    const fetchers: Partial<
      Record<AgentCapabilityCascadeKind, () => Promise<Inventory>>
    > = {
      "claude-skills": skills,
      "claude-plugins": plugins,
      "claude-agents": agents,
    };

    const first = await discoverBackendCapabilities({
      cache,
      scope: projectScope,
      cascadeKinds: ["claude-skills", "claude-plugins", "claude-agents"],
      fetcher: (kind) => fetchers[kind]!(),
    });

    expect(Object.keys(first.inventories).sort()).toEqual([
      "claude-agents",
      "claude-plugins",
      "claude-skills",
    ]);
    expect(first.failures).toEqual([]);
    expect(skills).toHaveBeenCalledTimes(1);
    expect(plugins).toHaveBeenCalledTimes(1);
    expect(agents).toHaveBeenCalledTimes(1);

    // Re-running with identical signatures should reuse cached references.
    const skills2 = fetcher("sk-1", ["a"]);
    const plugins2 = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-plugins", "pl-1", ["p"]));
    const agents2 = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-agents", "ag-1", ["g"]));

    const second = await discoverBackendCapabilities({
      cache,
      scope: projectScope,
      cascadeKinds: ["claude-skills", "claude-plugins", "claude-agents"],
      fetcher: (kind) =>
        ({
          "claude-skills": skills2,
          "claude-plugins": plugins2,
          "claude-agents": agents2,
        })[kind as "claude-skills" | "claude-plugins" | "claude-agents"](),
    });

    expect(second.inventories["claude-skills"]).toBe(
      first.inventories["claude-skills"],
    );
    expect(second.inventories["claude-plugins"]).toBe(
      first.inventories["claude-plugins"],
    );
    expect(second.inventories["claude-agents"]).toBe(
      first.inventories["claude-agents"],
    );
  });

  it("isolates one cascade's failure so other cascades still return results", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const skills = vi
      .fn<() => Promise<Inventory>>()
      .mockRejectedValue(new Error("skills exploded"));
    const plugins = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-plugins", "pl-1", ["p"]));
    const agents = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-agents", "ag-1", ["g"]));

    const result = await discoverBackendCapabilities({
      cache,
      scope: projectScope,
      cascadeKinds: ["claude-skills", "claude-plugins", "claude-agents"],
      fetcher: (kind) =>
        ({
          "claude-skills": skills,
          "claude-plugins": plugins,
          "claude-agents": agents,
        })[kind as "claude-skills" | "claude-plugins" | "claude-agents"](),
    });

    // Skills missing from inventories, but plugins/agents are intact.
    expect(result.inventories["claude-skills"]).toBeUndefined();
    expect(result.inventories["claude-plugins"]?.sourceSignature).toBe("pl-1");
    expect(result.inventories["claude-agents"]?.sourceSignature).toBe("ag-1");
    expect(result.failures.map((f) => f.cascadeKind)).toEqual([
      "claude-skills",
    ]);
    expect(result.failures[0]?.message).toContain("skills exploded");
  });

  it("does not erase a previously cached inventory when the fetcher fails on re-run", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    const cached = fakeInventory("claude-skills", "sk-1", ["a"]);
    cache.set("claude-skills", projectScope, cached);

    const skills = vi
      .fn<() => Promise<Inventory>>()
      .mockRejectedValue(new Error("transient"));

    const result = await discoverBackendCapabilities({
      cache,
      scope: projectScope,
      cascadeKinds: ["claude-skills"],
      fetcher: () => skills(),
    });

    expect(result.inventories["claude-skills"]).toBeUndefined();
    expect(result.failures).toHaveLength(1);
    // Cache survives — task 5.3's "one cascade failure must not discard
    // successful discovery for other cascades" includes the cross-time case.
    expect(cache.get("claude-skills", projectScope)).toBe(cached);
  });

  it("refresh=true forces every fetcher even on signature match", async () => {
    const cache = createAgentCapabilityDiscoveryCache<Inventory>();
    cache.set(
      "claude-skills",
      projectScope,
      fakeInventory("claude-skills", "sk-1"),
    );
    cache.set(
      "claude-plugins",
      projectScope,
      fakeInventory("claude-plugins", "pl-1"),
    );

    const skills = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-skills", "sk-1"));
    const plugins = vi
      .fn<() => Promise<Inventory>>()
      .mockResolvedValue(fakeInventory("claude-plugins", "pl-1"));

    const result = await discoverBackendCapabilities({
      cache,
      scope: projectScope,
      cascadeKinds: ["claude-skills", "claude-plugins"],
      fetcher: (kind) => (kind === "claude-skills" ? skills() : plugins()),
      refresh: true,
    });

    expect(skills).toHaveBeenCalledTimes(1);
    expect(plugins).toHaveBeenCalledTimes(1);
    expect(result.inventories["claude-skills"]?.sourceSignature).toBe("sk-1");
    expect(result.inventories["claude-plugins"]?.sourceSignature).toBe("pl-1");
  });

  it("logs refresh and failure events with scope correlation context", async () => {
    const logDir = await mkdtemp(path.join(os.tmpdir(), "cap-disc-logs-"));
    const logFile = path.join(logDir, "cc-debug.log");
    process.env["CC_LOG_FILE"] = logFile;
    process.env["CC_LOG_LEVEL"] = "info";
    delete process.env["CC_LOG_SILENT"];
    _resetLoggerForTesting();

    try {
      const cache = createAgentCapabilityDiscoveryCache<Inventory>();
      const scope: AgentCapabilityScopeContext = {
        level: "conversation",
        projectName: "demo-project",
        sessionName: "demo-session",
        conversationId: "conv-1",
      };

      await discoverBackendCapabilities({
        cache,
        scope,
        cascadeKinds: ["claude-skills", "claude-plugins"],
        fetcher: async (kind) => {
          if (kind === "claude-plugins") {
            throw new Error(
              "plugins failed with ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz and token abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN in /home/alex/.claude/settings.json",
            );
          }
          return fakeInventory("claude-skills", "sk-1", ["a"]);
        },
      });

      const entries = (await readFile(logFile, "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries).toContainEqual(
        expect.objectContaining({
          message: "discovery.refreshed",
          cascadeKind: "claude-skills",
          scopeLevel: "conversation",
          projectName: "demo-project",
          sessionName: "demo-session",
          conversationId: "conv-1",
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          message: "discovery.failed",
          cascadeKind: "claude-plugins",
          scopeLevel: "conversation",
          error: expect.stringContaining("<redacted>"),
          projectName: "demo-project",
          sessionName: "demo-session",
          conversationId: "conv-1",
        }),
      );
      const failure = entries.find(
        (entry) => entry["message"] === "discovery.failed",
      );
      expect(failure?.["error"]).not.toContain(
        "sk-ant-abcdefghijklmnopqrstuvwxyz",
      );
      expect(failure?.["error"]).not.toContain(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      );
      expect(failure?.["error"]).not.toContain("/home/alex");
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });
});
