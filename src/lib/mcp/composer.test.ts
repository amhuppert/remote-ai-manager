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
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {
      transport: "stdio",
      command: "echo",
      args: ["hi"],
    },
    sourceRefs: partial.sourceRefs ?? [
      {
        scope: "global",
        filePath: "/home/alex/.config/cc/.mcp.json",
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
      discovered: [def],
      effective: new Map(),
      gatewayServers: [],
      reservedGatewayIds: [],
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
      discovered: [def],
      effective: new Map(),
      gatewayServers: [],
      reservedGatewayIds: [],
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
      reservedGatewayIds: [],
    });

    expect(result.portable.servers).toHaveLength(1);
    expect(result.portable.servers[0]!.enabled).toBe(false);
  });

  it("excludes orphaned server overrides from the emitted set but reports them in diagnostics", () => {
    const result = composeRuntimeMcpConfig({
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
      reservedGatewayIds: [],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual(["present"]);
    expect(result.omittedOrphanServerKeys).toEqual(["orphan"]);
  });

  it("applies per-tool overrides without restricting unrelated tools", () => {
    const result = composeRuntimeMcpConfig({
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
      reservedGatewayIds: [],
    });

    expect(result.portable.servers[0]!.enabledTools).toBeUndefined();
    expect(result.portable.servers[0]!.disabledTools).toEqual([
      "delete",
      "chmod",
    ]);
  });

  it("falls back to native tool filters when no override is set", () => {
    const result = composeRuntimeMcpConfig({
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
      reservedGatewayIds: [],
    });

    expect(result.portable.servers[0]!.enabledTools).toEqual(["read", "list"]);
    expect(result.portable.servers[0]!.disabledTools).toEqual(["delete"]);
  });

  it("respects native enabled=false when no override layer provides an enabled value", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [
        mkDefinition({
          serverKey: "fs",
          nativeId: "fs",
          native: { enabled: false },
        }),
      ],
      effective: new Map(),
      gatewayServers: [],
      reservedGatewayIds: [],
    });

    expect(result.portable.servers[0]!.enabled).toBe(false);
  });

  it("emits every discovered definition regardless of any notional active backend (translators handle backend-specific omission)", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [
        mkDefinition({ serverKey: "alpha", nativeId: "alpha" }),
        mkDefinition({ serverKey: "beta", nativeId: "beta" }),
        mkDefinition({ serverKey: "gamma", nativeId: "gamma" }),
      ],
      effective: new Map(),
      gatewayServers: [],
      reservedGatewayIds: [],
    });

    expect(result.portable.servers.map((s) => s.id).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("preserves discovered SSE servers through portable composition", () => {
    const result = composeRuntimeMcpConfig({
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
      reservedGatewayIds: [],
    });

    expect(result.portable.servers).toMatchObject([
      { id: "sse-server", transport: "sse", url: "https://example.com/sse" },
    ]);
    expect(result.droppedServerKeys).toEqual([]);
  });
});

// ===========================================================================
// Task 7.2 — Gateway protection
// ===========================================================================

describe("composeRuntimeMcpConfig gateway protection (task 7.2)", () => {
  it("appends CC-injected gateway servers after user-configured servers", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [mkDefinition({ serverKey: "user-a", nativeId: "user-a" })],
      effective: new Map(),
      gatewayServers: [gateway("gateway-alpha"), gateway("gateway-beta")],
      reservedGatewayIds: [],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual([
      "user-a",
      "gateway-alpha",
      "gateway-beta",
    ]);
  });

  it("preserves gateway entries verbatim", () => {
    const gw = gateway("gateway-alpha");
    const result = composeRuntimeMcpConfig({
      discovered: [],
      effective: new Map(),
      gatewayServers: [gw],
      reservedGatewayIds: [],
    });

    expect(result.portable.servers[0]).toBe(gw);
  });

  it("drops a user-configured server whose id collides with a gateway id and keeps the gateway", () => {
    const gw = gateway("gateway-alpha", "/gw-path");
    const result = composeRuntimeMcpConfig({
      discovered: [
        mkDefinition({
          serverKey: "user-collision",
          nativeId: "gateway-alpha",
        }),
        mkDefinition({ serverKey: "keeper", nativeId: "keeper" }),
      ],
      effective: new Map(),
      gatewayServers: [gw],
      reservedGatewayIds: [],
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).toEqual(["keeper", "gateway-alpha"]);
    const gatewayEntry = result.portable.servers.find(
      (s) => s.id === "gateway-alpha",
    );
    expect(gatewayEntry).toBe(gw);
    expect(result.collidedGatewayIds).toEqual(["gateway-alpha"]);
  });

  it("marks gateway ids as reserved so no UI surface can expose a toggle for them", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [],
      effective: new Map(),
      gatewayServers: [gateway("gateway-alpha"), gateway("gateway-beta")],
      reservedGatewayIds: [],
    });

    expect(result.reservedServerIds).toEqual(["gateway-alpha", "gateway-beta"]);
  });

  it("always appends gateway servers even when no user-configured servers are present", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [],
      effective: new Map(),
      gatewayServers: [gateway("gateway-alpha")],
      reservedGatewayIds: [],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual(["gateway-alpha"]);
    expect(result.reservedServerIds).toEqual(["gateway-alpha"]);
  });

  it("reserves explicit gateway ids even when no gateway server is emitted, dropping a colliding user-configured server", () => {
    const result = composeRuntimeMcpConfig({
      discovered: [
        mkDefinition({
          serverKey: "user-collision",
          nativeId: "gateway-alpha",
        }),
        mkDefinition({ serverKey: "keeper", nativeId: "keeper" }),
      ],
      effective: new Map(),
      gatewayServers: [],
      reservedGatewayIds: ["gateway-alpha"],
    });

    expect(result.portable.servers.map((s) => s.id)).toEqual(["keeper"]);
    expect(result.collidedGatewayIds).toEqual(["gateway-alpha"]);
  });
});

it("enabling a tool removes its authored deny without narrowing unrelated tools", () => {
  const result = composeRuntimeMcpConfig({
    discovered: [
      mkDefinition({
        serverKey: "fixture",
        native: { disabledTools: ["denied"] },
      }),
    ],
    effective: new Map([
      [
        "fixture",
        {
          serverKey: "fixture",
          enabled: true,
          enabledTools: ["denied"],
          disabledTools: [],
          toolOriginLevels: { denied: "global" },
        },
      ],
    ]),
    gatewayServers: [],
    reservedGatewayIds: [],
  });
  const server = result.portable.servers[0];
  expect(server?.disabledTools).toEqual([]);
  expect(server?.enabledTools ?? []).toEqual([]);
});
