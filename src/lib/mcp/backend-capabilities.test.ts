import { describe, expect, it } from "vitest";

import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import {
  translatePortableMcpToClaude,
  translatePortableMcpToCodex,
} from "@/lib/agent-backends/mcp-translation";
import type { McpServerDefinition } from "@/lib/mcp/types";
import type { McpServerCompatibilityView } from "@/lib/mcp/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { McpBackendCapabilities } from "@/lib/agent-backends/mcp-capabilities";
import {
  buildCompatibilityLookup,
  createMcpCapabilityRegistry,
  defaultMcpCapabilityRegistry,
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

  it("applies saved changes at the next turn boundary", () => {
    expect(claude.betweenTurnApply).toBe("next-turn");
  });

  it("uses native creation-time exclusions for stdio and HTTP/SSE", () => {
    expect(claude.toolFiltering.mode).toBe("native");
    expect(claude.toolFiltering.byTransport.stdio).toBe("native");
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
// Default registry — Cursor
// ===========================================================================

describe("defaultMcpCapabilityRegistry — Cursor capabilities", () => {
  const cursor = defaultMcpCapabilityRegistry.getCapabilities("cursor");

  // The ordinary inline call path passes (spec D18 / R10), but the authority
  // matrix — ambient merge, duplicate names, empty-inline, per-run replacement,
  // disable/filter, permission, environment, resume-apply — is a separate gate.
  // One passing call is not authority.
  it("declares strict authoritative config UNSUPPORTED", () => {
    expect(cursor.strictAuthoritativeConfig).toBe(false);
  });

  it("disables servers by omission — the SDK's inline entry has no disabled flag", () => {
    expect(cursor.serverDisable).toBe("omit");
  });

  it("applies between-turn changes at the next turn", () => {
    expect(cursor.betweenTurnApply).toBe("next-turn");
  });

  it("supports all three transports through the enforcing bridge", () => {
    expect(cursor.transports.stdio).toBe(true);
    expect(cursor.transports["streamable-http"]).toBe(true);
    expect(cursor.transports.sse).toBe(true);
  });

  it("declares bridge enforcement for each transport", () => {
    expect(cursor.toolFiltering.mode).toBe("bridge");
    expect(cursor.toolFiltering.byTransport.stdio).toBe("bridge");
    expect(cursor.toolFiltering.byTransport["streamable-http"]).toBe("bridge");
    expect(cursor.toolFiltering.byTransport.sse).toBe("bridge");
  });

  it("prefers a direct probe — the runtime exposes no MCP server status", () => {
    expect(cursor.toolDiscovery.preferred).toBe("probe");
    expect(cursor.toolDiscovery.probeFallback).toBe(true);
  });

  it("carries its backend identifier", () => {
    expect(cursor.backend).toBe("cursor");
  });
});

// ===========================================================================
// Transport support is a separate question from tool filtering
// ===========================================================================

describe("transport support vs tool filtering", () => {
  it("reports Claude and Codex transport support unchanged by the split", () => {
    const claude = defaultMcpCapabilityRegistry.getCapabilities("claude");
    const codex = defaultMcpCapabilityRegistry.getCapabilities("codex");
    expect(claude.transports).toEqual({
      stdio: true,
      "streamable-http": true,
      sse: true,
    });
    expect(codex.transports).toEqual({
      stdio: true,
      "streamable-http": true,
      sse: false,
    });
  });

  it("marks a stdio server supported by Cursor even though it filters no tools", () => {
    const lookup = buildCompatibilityLookup(defaultMcpCapabilityRegistry);
    const view = lookup(definition({ serverKey: "kagi", transport: "stdio" }));
    const cursor = view.backends.find((b) => b.backend === "cursor");
    expect(cursor?.supported).toBe(true);
    expect(cursor?.reason).toBeUndefined();
  });

  it("marks a remote server compatible with Cursor", () => {
    const lookup = buildCompatibilityLookup(defaultMcpCapabilityRegistry);
    const view = lookup(
      definition({ serverKey: "remote", transport: "streamable-http" }),
    );
    const cursor = view.backends.find((b) => b.backend === "cursor");
    expect(cursor?.supported).toBe(true);
    expect(cursor?.reason).toBeUndefined();
  });
});

// ===========================================================================
// listBackends — extension points for adding new backends
// ===========================================================================

describe("McpCapabilityRegistry — extension points", () => {
  it("lists every shipped backend by default", () => {
    expect(defaultMcpCapabilityRegistry.listBackends()).toEqual([
      "claude",
      "codex",
      "cursor",
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
      transports: {
        stdio: true,
        "streamable-http": false,
        sse: false,
      },
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
    expect(view.backends.map((b) => b.backend)).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
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
  it("keeps the server available while reporting unsupported allowlists", () => {
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
    expect(rejectedFields).toContain("srv.enabledTools");
    expect(rejectedFields).not.toContain("srv.disabledTools");
    expect(servers).toHaveProperty("srv");
  });

  it("retains availability when capability cannot apply tool filters", () => {
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
    expect(rejectedServers).not.toContain("srv");
    expect(rejectedFields).toContain("srv.enabledTools");
  });
});

it("preserves SSE identity for Claude and refuses it for Codex", () => {
  const portable: PortableMcpConfig = {
    servers: [{ id: "sse", transport: "sse", url: "https://example.test/sse" }],
  };
  expect(translatePortableMcpToClaude(portable).servers.sse).toMatchObject({
    type: "sse",
    url: "https://example.test/sse",
  });
  const codex = translatePortableMcpToCodex(portable);
  expect(codex.mcpServers).toEqual({});
  expect(codex.droppedFields).toContain("sse.transport");
});
