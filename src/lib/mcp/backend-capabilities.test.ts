import { describe, expect, it, vi } from "vitest";

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import {
  translatePortableMcpToClaude,
  translatePortableMcpToCodex,
} from "@/lib/agent-backends/mcp-translation";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { McpServerDefinition } from "@/lib/mcp/types";
import { createClaudeRuntimeToolSource } from "@/lib/mcp/tool-discovery-runtime";
import type {
  McpDiscoveredTool,
  McpServerCompatibilityView,
} from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  buildCompatibilityLookup,
  createMcpCapabilityRegistry,
  defaultMcpCapabilityRegistry,
  type McpBackendCapabilities,
} from "./backend-capabilities";

function definition(
  partial: Partial<McpServerDefinition> & { serverKey: string },
): McpServerDefinition {
  return {
    nativeId: partial.nativeId ?? partial.serverKey,
    transport: partial.transport ?? "stdio",
    config: partial.config ?? { transport: "stdio", command: "x" },
    sourceRefs: partial.sourceRefs ?? [],
    configSignature: partial.configSignature ?? "sig",
    reserved: partial.reserved ?? false,
    diagnostics: partial.diagnostics ?? [],
    ...partial,
  };
}

// ===========================================================================
// Default registry — Claude
// ===========================================================================

describe("defaultMcpCapabilityRegistry — Claude capabilities", () => {
  const claude = defaultMcpCapabilityRegistry.getCapabilities("claude");

  it("declares strict authoritative config support", () => {
    expect(claude.strictAuthoritativeConfig).toBe(true);
  });

  it("disables servers by omission (not a native enabled:false field)", () => {
    expect(claude.serverDisable).toBe("omit");
  });

  it("applies between-turn changes live when the runtime is idle", () => {
    expect(claude.betweenTurnApply).toBe("live-when-idle");
  });

  it("uses permission-layer filtering for stdio and native policies for HTTP/SSE", () => {
    expect(claude.toolFiltering.mode).toBe("mixed");
    expect(claude.toolFiltering.byTransport.stdio).toBe("permission-layer");
    expect(claude.toolFiltering.byTransport["streamable-http"]).toBe("native");
    expect(claude.toolFiltering.byTransport.sse).toBe("native");
  });

  it("prefers runtime status for tool discovery and falls back to probe", () => {
    expect(claude.toolDiscovery.preferred).toBe("runtime-status");
    expect(claude.toolDiscovery.probeFallback).toBe(true);
  });

  it("carries its backend identifier", () => {
    expect(claude.backend).toBe("claude");
  });
});

// ===========================================================================
// Default registry — Codex
// ===========================================================================

describe("defaultMcpCapabilityRegistry — Codex capabilities", () => {
  const codex = defaultMcpCapabilityRegistry.getCapabilities("codex");

  it("declares strict authoritative config support via programmatic override", () => {
    expect(codex.strictAuthoritativeConfig).toBe(true);
  });

  it("disables servers via the native enabled:false field", () => {
    expect(codex.serverDisable).toBe("native");
  });

  it("applies between-turn changes at next turn (no live replace)", () => {
    expect(codex.betweenTurnApply).toBe("next-turn");
  });

  it("uses native tool filtering across supported transports", () => {
    expect(codex.toolFiltering.mode).toBe("native");
    expect(codex.toolFiltering.byTransport.stdio).toBe("native");
    expect(codex.toolFiltering.byTransport["streamable-http"]).toBe("native");
    expect(codex.toolFiltering.byTransport.sse).toBe("unsupported");
  });

  it("prefers direct probe for tool discovery (no runtime status)", () => {
    expect(codex.toolDiscovery.preferred).toBe("probe");
    expect(codex.toolDiscovery.probeFallback).toBe(true);
  });

  it("carries its backend identifier", () => {
    expect(codex.backend).toBe("codex");
  });
});

// ===========================================================================
// listBackends — extension points for adding new backends
// ===========================================================================

describe("McpCapabilityRegistry — extension points", () => {
  it("lists both shipped backends by default", () => {
    expect(defaultMcpCapabilityRegistry.listBackends()).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("throws when asked for a backend with no registered capabilities", () => {
    const empty = createMcpCapabilityRegistry([]);
    expect(() =>
      empty.getCapabilities("claude" as AgentBackendId),
    ).toThrowError(/claude/);
  });

  it("accepts a new backend entry without any other code change", () => {
    const futureBackend: McpBackendCapabilities = {
      backend: "claude",
      strictAuthoritativeConfig: false,
      serverDisable: "unsupported",
      betweenTurnApply: "unsupported",
      toolFiltering: {
        mode: "unsupported",
        byTransport: {
          stdio: "unsupported",
          "streamable-http": "unsupported",
          sse: "unsupported",
        },
      },
      toolDiscovery: {
        preferred: "unsupported",
        probeFallback: false,
      },
    };
    const registry = createMcpCapabilityRegistry([futureBackend]);
    expect(registry.getCapabilities("claude").strictAuthoritativeConfig).toBe(
      false,
    );
  });
});

// ===========================================================================
// Compatibility lookup — drives UI badges without branching on backend id
// ===========================================================================

describe("buildCompatibilityLookup — registry-driven compatibility", () => {
  const lookup = buildCompatibilityLookup(defaultMcpCapabilityRegistry);

  it("marks stdio servers as supported by every backend the registry knows", () => {
    const view: McpServerCompatibilityView = lookup(
      definition({ serverKey: "kagi", transport: "stdio" }),
    );
    const claude = view.backends.find((b) => b.backend === "claude");
    const codex = view.backends.find((b) => b.backend === "codex");
    expect(claude?.supported).toBe(true);
    expect(codex?.supported).toBe(true);
  });

  it("marks streamable-http servers as supported by both Claude and Codex", () => {
    const view = lookup(
      definition({ serverKey: "cursor-http", transport: "streamable-http" }),
    );
    expect(view.backends.find((b) => b.backend === "claude")?.supported).toBe(
      true,
    );
    expect(view.backends.find((b) => b.backend === "codex")?.supported).toBe(
      true,
    );
  });

  it("marks SSE servers as unsupported by Codex with a capability reason", () => {
    const view = lookup(definition({ serverKey: "ext-sse", transport: "sse" }));
    const codex = view.backends.find((b) => b.backend === "codex");
    expect(codex?.supported).toBe(false);
    expect(codex?.reason).toMatch(/sse/i);
  });

  it("includes an entry for every backend the registry lists (stable order)", () => {
    const view = lookup(definition({ serverKey: "any" }));
    expect(view.backends.map((b) => b.backend)).toEqual(["claude", "codex"]);
  });

  it("derives compatibility from the injected registry — not hardcoded ids", () => {
    const codexOnly = createMcpCapabilityRegistry([
      defaultMcpCapabilityRegistry.getCapabilities("codex"),
    ]);
    const onlyCodex = buildCompatibilityLookup(codexOnly);
    const view = onlyCodex(definition({ serverKey: "any", transport: "sse" }));
    expect(view.backends.map((b) => b.backend)).toEqual(["codex"]);
    expect(view.backends[0]?.supported).toBe(false);
  });
});

// ===========================================================================
// Production delegation — translators consult the registry's capabilities
// ===========================================================================

describe("translatePortableMcpToCodex — capability-driven server disable", () => {
  it("emits enabled:false natively because Codex capabilities declare serverDisable='native'", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "x",
          enabled: false,
        },
      ],
    };
    const { mcpServers } = translatePortableMcpToCodex(config);
    expect(mcpServers["srv"]).toMatchObject({ enabled: false });
  });

  it("omits disabled servers entirely when capabilities say serverDisable='omit'", () => {
    const omitCaps: McpBackendCapabilities = {
      ...defaultMcpCapabilityRegistry.getCapabilities("codex"),
      serverDisable: "omit",
    };
    const config: PortableMcpConfig = {
      servers: [
        { id: "on", transport: "stdio", command: "a" },
        { id: "off", transport: "stdio", command: "b", enabled: false },
      ],
    };
    const { mcpServers } = translatePortableMcpToCodex(config, {
      capabilities: omitCaps,
    });
    expect(mcpServers).toHaveProperty("on");
    expect(mcpServers).not.toHaveProperty("off");
  });
});

describe("translatePortableMcpToClaude — capability-driven server disable", () => {
  it("omits disabled servers because Claude capabilities declare serverDisable='omit'", () => {
    const config: PortableMcpConfig = {
      servers: [
        { id: "on", transport: "stdio", command: "a" },
        { id: "off", transport: "stdio", command: "b", enabled: false },
      ],
    };
    const { servers } = translatePortableMcpToClaude(config);
    expect(servers).toHaveProperty("on");
    expect(servers).not.toHaveProperty("off");
  });

  it("passes through disabled servers as enabled when injected capabilities declare serverDisable='native'", () => {
    const nativeCaps: McpBackendCapabilities = {
      ...defaultMcpCapabilityRegistry.getCapabilities("claude"),
      serverDisable: "native",
    };
    const config: PortableMcpConfig = {
      servers: [
        { id: "off", transport: "stdio", command: "b", enabled: false },
      ],
    };
    const { servers } = translatePortableMcpToClaude(config, {
      capabilities: nativeCaps,
    });
    expect(servers).toHaveProperty("off");
  });
});

describe("translatePortableMcpToClaude — capability-driven tool-filter handling", () => {
  it("accepts enabledTools/disabledTools without rejection when capability is 'permission-layer'", () => {
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "x",
          enabledTools: ["a"],
          disabledTools: ["b"],
        },
      ],
    };
    const { servers, rejectedServers, rejectedFields } =
      translatePortableMcpToClaude(config);
    expect(rejectedServers).not.toContain("srv");
    expect(rejectedFields).not.toContain("srv.enabledTools");
    expect(rejectedFields).not.toContain("srv.disabledTools");
    expect(servers).toHaveProperty("srv");
  });

  it("rejects tool filters when capability marks the transport 'unsupported'", () => {
    const unsupportedCaps: McpBackendCapabilities = {
      ...defaultMcpCapabilityRegistry.getCapabilities("claude"),
      toolFiltering: {
        mode: "unsupported",
        byTransport: {
          stdio: "unsupported",
          "streamable-http": "unsupported",
          sse: "unsupported",
        },
      },
    };
    const config: PortableMcpConfig = {
      servers: [
        {
          id: "srv",
          transport: "stdio",
          command: "x",
          enabledTools: ["a"],
        },
      ],
    };
    const { rejectedServers, rejectedFields } = translatePortableMcpToClaude(
      config,
      { capabilities: unsupportedCaps },
    );
    expect(rejectedServers).toContain("srv");
    expect(rejectedFields).toContain("srv.enabledTools");
  });
});

// ===========================================================================
// Production delegation — tool-discovery runtime branches on capability
// ===========================================================================

function makeRuntime(
  partial: Partial<ConversationBackendRuntime> & {
    listMcpServerTools?: (
      serverKey: string,
    ) => Promise<McpDiscoveredTool[] | undefined>;
  },
): ConversationBackendRuntime {
  return {
    backend: partial.backend ?? "claude",
    status: partial.status ?? "alive",
    modelId: partial.modelId,
    reasoningEffort: partial.reasoningEffort,
    outputFormat: partial.outputFormat,
    sendTurn: partial.sendTurn ?? vi.fn(),
    close: partial.close ?? vi.fn(),
    ...(partial.listMcpServerTools
      ? { listMcpServerTools: partial.listMcpServerTools }
      : {}),
  } as ConversationBackendRuntime;
}

describe("createClaudeRuntimeToolSource — capability-driven backend filter", () => {
  it("returns tools for a Claude runtime (registry default — preferred='runtime-status')", async () => {
    const tools: McpDiscoveredTool[] = [{ name: "t1" }];
    const runtime = makeRuntime({
      backend: "claude",
      listMcpServerTools: async () => tools,
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });
    const result = await source.listToolsFromActiveRuntime({
      conversationId: "c",
      serverKey: "s",
    });
    expect(result).toEqual(tools);
  });

  it("skips a backend whose capability says preferred='probe'", async () => {
    const runtime = makeRuntime({
      backend: "codex",
      listMcpServerTools: async () => [{ name: "ignored" }],
    });
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
    });
    const result = await source.listToolsFromActiveRuntime({
      conversationId: "c",
      serverKey: "s",
    });
    expect(result).toBeUndefined();
  });

  it("uses an injected capability lookup over the default registry", async () => {
    const runtime = makeRuntime({
      backend: "codex",
      listMcpServerTools: async () => [{ name: "via-codex" }],
    });
    const registry = createMcpCapabilityRegistry([
      {
        ...defaultMcpCapabilityRegistry.getCapabilities("codex"),
        toolDiscovery: { preferred: "runtime-status", probeFallback: true },
      },
    ]);
    const source = createClaudeRuntimeToolSource({
      getRuntime: () => runtime,
      capabilityRegistry: registry,
    });
    const result = await source.listToolsFromActiveRuntime({
      conversationId: "c",
      serverKey: "s",
    });
    expect(result).toEqual([{ name: "via-codex" }]);
  });
});
