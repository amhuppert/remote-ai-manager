import { describe, expect, it } from "vitest";

import type { PortableMcpServerConfig } from "@/lib/agent-backends/portable-mcp";

import { composeRuntimeMcpConfig } from "./composer";
import type { McpEffectiveServerResolution } from "./resolver";
import type { McpServerDefinition } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkDefinition(
  partial: Partial<McpServerDefinition> & { serverKey: string },
): McpServerDefinition {
  return {
    nativeId: partial.nativeId ?? partial.serverKey,
    backend: partial.backend ?? "shared",
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {
      transport: "stdio",
      command: "echo",
      args: ["hi"],
    },
    sourceRefs: partial.sourceRefs ?? [
      {
        backend: "claude",
        scope: "user",
        filePath: "/home/alex/.claude/settings.json",
      },
    ],
    configSignature: partial.configSignature ?? `sig-${partial.serverKey}`,
    reserved: partial.reserved ?? false,
    diagnostics: partial.diagnostics ?? [],
    ...partial,
  };
}

function mkEffective(
  partial: Partial<McpEffectiveServerResolution> & { serverKey: string },
): McpEffectiveServerResolution {
  return {
    serverKey: partial.serverKey,
    enabled: partial.enabled ?? true,
    enabledTools: partial.enabledTools ?? [],
    disabledTools: partial.disabledTools ?? [],
    toolOriginLevels: partial.toolOriginLevels ?? {},
    ...(partial.enabledOriginLevel !== undefined
      ? { enabledOriginLevel: partial.enabledOriginLevel }
      : {}),
  };
}

function gateway(id: string, path = "/mcp"): PortableMcpServerConfig {
  return {
    id,
    transport: "streamable-http",
    url: `http://localhost${path}`,
  };
}

// ===========================================================================
// Task 7.1 — Compose emitted runtime config from resolver output
// ===========================================================================

describe("composeRuntimeMcpConfig (task 7.1)", () => {
  it("emits a portable entry for each discovered stdio server with default enabled=true when no override exists", () => {
    const def = mkDefinition({
      serverKey: "calc",
      nativeId: "calc",
      config: {
        transport: "stdio",
        command: "/usr/bin/calc",
        args: ["--serve"],
        env: { PATH: "/bin" },
      },
    });

    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [def],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers).toHaveLength(1);
    const entry = result.portable.servers[0]!;
    expect(entry).toEqual({
      id: "calc",
      transport: "stdio",
      command: "/usr/bin/calc",
      args: ["--serve"],
      env: { PATH: "/bin" },
    });
  });

  it("emits a portable entry for streamable-http discovered servers preserving headers and bearer token env var", () => {
    const def = mkDefinition({
      serverKey: "web",
      nativeId: "web",
      transport: "streamable-http",
      config: {
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { "X-Trace": "1" },
        bearerTokenEnvVar: "WEB_TOKEN",
      },
    });

    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [def],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers[0]).toEqual({
      id: "web",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      headers: { "X-Trace": "1" },
      bearerTokenEnvVar: "WEB_TOKEN",
    });
  });

  it("emits `enabled: false` when the effective resolution disables the server so Codex does not fall back to TOML", () => {
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [mkDefinition({ serverKey: "calc", nativeId: "calc" })],
      effective: new Map([
        [
          "calc",
          mkEffective({
            serverKey: "calc",
            enabled: false,
            enabledOriginLevel: "session",
          }),
        ],
      ]),
      gatewayServers: [],
    });

    expect(result.portable.servers).toHaveLength(1);
    expect(result.portable.servers[0]!.enabled).toBe(false);
  });

  it("excludes orphaned server overrides from the emitted set but reports them in diagnostics", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [mkDefinition({ serverKey: "present", nativeId: "present" })],
      effective: new Map([
        ["present", mkEffective({ serverKey: "present" })],
        [
          "orphan",
          mkEffective({
            serverKey: "orphan",
            enabled: false,
            enabledOriginLevel: "project",
          }),
        ],
      ]),
      gatewayServers: [],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual(["present"]);
    expect(result.omittedOrphanServerKeys).toEqual(["orphan"]);
  });

  it("emits overridden enabledTools/disabledTools verbatim on the portable entry", () => {
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [mkDefinition({ serverKey: "fs", nativeId: "fs" })],
      effective: new Map([
        [
          "fs",
          mkEffective({
            serverKey: "fs",
            disabledTools: ["delete", "chmod"],
            enabledTools: ["read"],
          }),
        ],
      ]),
      gatewayServers: [],
    });

    expect(result.portable.servers[0]!.enabledTools).toEqual(["read"]);
    expect(result.portable.servers[0]!.disabledTools).toEqual([
      "delete",
      "chmod",
    ]);
  });

  it("falls back to native tool filters when no override is set", () => {
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [
        mkDefinition({
          serverKey: "fs",
          nativeId: "fs",
          native: {
            enabledTools: ["read", "list"],
            disabledTools: ["delete"],
          },
        }),
      ],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers[0]!.enabledTools).toEqual(["read", "list"]);
    expect(result.portable.servers[0]!.disabledTools).toEqual(["delete"]);
  });

  it("respects native enabled=false when no override layer provides an enabled value", () => {
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [
        mkDefinition({
          serverKey: "fs",
          nativeId: "fs",
          native: { enabled: false },
        }),
      ],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers[0]!.enabled).toBe(false);
  });

  it("filters out discovered servers whose backend does not match the active backend (and is not shared)", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [
        mkDefinition({
          serverKey: "claude-only",
          nativeId: "claude-only",
          backend: "claude",
        }),
        mkDefinition({
          serverKey: "codex-only",
          nativeId: "codex-only",
          backend: "codex",
        }),
        mkDefinition({
          serverKey: "shared-one",
          nativeId: "shared-one",
          backend: "shared",
        }),
      ],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers.map((s) => s.id).sort()).toEqual([
      "claude-only",
      "shared-one",
    ]);
  });

  it("skips discovered servers whose transport is not representable in the portable shape (sse)", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [
        mkDefinition({
          serverKey: "sse-server",
          nativeId: "sse-server",
          transport: "sse",
          config: { transport: "sse", url: "https://example.com/sse" },
        }),
      ],
      effective: new Map(),
      gatewayServers: [],
    });

    expect(result.portable.servers).toHaveLength(0);
    expect(result.droppedServerKeys).toEqual(["sse-server"]);
  });
});

// ===========================================================================
// Task 7.2 — Gateway protection
// ===========================================================================

describe("composeRuntimeMcpConfig gateway protection (task 7.2)", () => {
  it("appends CC-injected gateway servers after user-configured servers", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [mkDefinition({ serverKey: "user-a", nativeId: "user-a" })],
      effective: new Map(),
      gatewayServers: [
        gateway("cc-session-tools"),
        gateway("cc-graph-workflow"),
      ],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual([
      "user-a",
      "cc-session-tools",
      "cc-graph-workflow",
    ]);
  });

  it("preserves gateway entries verbatim", () => {
    const gw = gateway("cc-session-tools");
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [],
      effective: new Map(),
      gatewayServers: [gw],
    });

    expect(result.portable.servers[0]).toBe(gw);
  });

  it("drops a user-configured server whose id collides with a gateway id and keeps the gateway", () => {
    const gw = gateway("cc-session-tools", "/gw-path");
    const result = composeRuntimeMcpConfig({
      backend: "codex",
      discovered: [
        mkDefinition({
          serverKey: "user-collision",
          nativeId: "cc-session-tools",
        }),
        mkDefinition({ serverKey: "keeper", nativeId: "keeper" }),
      ],
      effective: new Map(),
      gatewayServers: [gw],
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).toEqual(["keeper", "cc-session-tools"]);
    const gatewayEntry = result.portable.servers.find(
      (s) => s.id === "cc-session-tools",
    );
    expect(gatewayEntry).toBe(gw);
    expect(result.collidedGatewayIds).toEqual(["cc-session-tools"]);
  });

  it("marks gateway ids as reserved so no UI surface can expose a toggle for them", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [],
      effective: new Map(),
      gatewayServers: [
        gateway("cc-session-tools"),
        gateway("cc-graph-workflow"),
      ],
    });

    expect(result.reservedServerIds).toEqual([
      "cc-session-tools",
      "cc-graph-workflow",
    ]);
  });

  it("always appends gateway servers even when no user-configured servers are present", () => {
    const result = composeRuntimeMcpConfig({
      backend: "claude",
      discovered: [],
      effective: new Map(),
      gatewayServers: [gateway("cc-session-tools")],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual([
      "cc-session-tools",
    ]);
    expect(result.reservedServerIds).toEqual(["cc-session-tools"]);
  });
});
