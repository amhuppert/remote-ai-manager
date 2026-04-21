import { describe, expect, it } from "vitest";

import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { McpOverrides } from "@/lib/schemas";

import {
  composePortableForConversation,
  createComposePortableMcpForConversation,
  type ComposePortableMcpDeps,
} from "./compose-for-conversation";
import type { McpServerDefinition } from "./types";

function mkDefinition(
  partial: Partial<McpServerDefinition> & { serverKey: string },
): McpServerDefinition {
  return {
    nativeId: partial.nativeId ?? partial.serverKey,
    backend: partial.backend ?? "shared",
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {
      transport: "stdio",
      command: "/bin/echo",
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

const gateway: PortableMcpServerConfig = {
  id: "cc-session-tools",
  transport: "streamable-http",
  url: "http://localhost:3000/api/projects/proj/sessions/sess/mcp",
};

const emptyOverrides: McpOverrides = { servers: {} };

describe("composePortableForConversation (pure)", () => {
  it("emits discovered servers + gateway when there are no overrides or transient tooling", () => {
    const discovered = [
      mkDefinition({ serverKey: "calc" }),
      mkDefinition({ serverKey: "fs" }),
    ];

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: { global: emptyOverrides },
      discovered,
      gatewayServers: [gateway],
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["calc", "fs", "cc-session-tools"]),
    );
  });

  it("honors session-level disable over global enabled default — resolver cascade", () => {
    const discovered = [mkDefinition({ serverKey: "calc" })];
    const sessionOverrides: McpOverrides = {
      servers: { calc: { enabled: false } },
    };

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: {
        global: emptyOverrides,
        project: emptyOverrides,
        session: sessionOverrides,
      },
      discovered,
      gatewayServers: [gateway],
    });

    const calc = result.portable.servers.find((s) => s.id === "calc");
    expect(calc?.enabled).toBe(false);
  });

  it("conversation-level override wins over session-level", () => {
    const discovered = [mkDefinition({ serverKey: "calc" })];

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: {
        global: emptyOverrides,
        session: { servers: { calc: { enabled: false } } },
        conversation: { servers: { calc: { enabled: true } } },
      },
      discovered,
      gatewayServers: [gateway],
    });

    const calc = result.portable.servers.find((s) => s.id === "calc");
    expect(calc?.enabled).toBe(true);
  });

  it("omits orphaned overrides (override references server not in discovery)", () => {
    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: {
        global: emptyOverrides,
        session: { servers: { "ghost-server": { enabled: true } } },
      },
      discovered: [],
      gatewayServers: [gateway],
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).not.toContain("ghost-server");
    expect(result.omittedOrphanServerKeys).toContain("ghost-server");
  });

  it("always appends the gateway even when it collides with a user-configured id", () => {
    const discovered = [
      mkDefinition({
        serverKey: "cc-session-tools",
        nativeId: "cc-session-tools",
      }),
    ];

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: { global: emptyOverrides },
      discovered,
      gatewayServers: [gateway],
    });

    const gatewayEntries = result.portable.servers.filter(
      (s) => s.id === "cc-session-tools",
    );
    expect(gatewayEntries).toHaveLength(1);
    expect(gatewayEntries[0]?.transport).toBe("streamable-http");
  });

  it("merges transient tooling overrides last (graph-workflow seam)", () => {
    const transient: PortableMcpConfig = {
      servers: [
        {
          id: "cc-graph-workflow",
          transport: "streamable-http",
          url: "http://localhost:3000/api/projects/proj/sessions/sess/mcp/graph-workflow/exec/contexts/ctx",
        },
      ],
    };

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: { global: emptyOverrides },
      discovered: [mkDefinition({ serverKey: "calc" })],
      gatewayServers: [gateway],
      transientPortableMcp: transient,
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining(["calc", "cc-session-tools", "cc-graph-workflow"]),
    );
  });

  it("transient tooling entries override same-id base entries (seam replaces by id)", () => {
    const transient: PortableMcpConfig = {
      servers: [
        {
          id: "calc",
          transport: "stdio",
          command: "/transient/calc",
        },
      ],
    };

    const result = composePortableForConversation({
      backend: "claude",
      overrideChain: { global: emptyOverrides },
      discovered: [mkDefinition({ serverKey: "calc" })],
      gatewayServers: [gateway],
      transientPortableMcp: transient,
    });

    const calc = result.portable.servers.find((s) => s.id === "calc");
    expect(calc).toBeDefined();
    if (calc?.transport === "stdio") {
      expect(calc.command).toBe("/transient/calc");
    } else {
      throw new Error("expected stdio transport from transient override");
    }
  });
});

describe("createComposePortableMcpForConversation (factory)", () => {
  function createDeps(
    overrides: Partial<ComposePortableMcpDeps> = {},
  ): ComposePortableMcpDeps {
    return {
      readGlobalOverrides: async () => emptyOverrides,
      readProjectOverrides: async () => undefined,
      readSessionOverrides: async () => undefined,
      readConversationOverrides: async () => undefined,
      discoverSources: async () => ({
        servers: [],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      buildGatewayServers: () => [gateway],
      ...overrides,
    };
  }

  it("passes all four override levels into the cascade resolver", async () => {
    const globalOverrides: McpOverrides = {
      servers: { calc: { enabled: false } },
    };
    const projectOverrides: McpOverrides = {
      servers: { calc: { enabled: true } },
    };
    const conversationOverrides: McpOverrides = {
      servers: { calc: { enabled: false } },
    };

    const deps = createDeps({
      readGlobalOverrides: async () => globalOverrides,
      readProjectOverrides: async () => projectOverrides,
      readSessionOverrides: async () => undefined,
      readConversationOverrides: async () => conversationOverrides,
      discoverSources: async () => ({
        servers: [mkDefinition({ serverKey: "calc" })],
        diagnostics: [],
        sourceFiles: [],
      }),
    });

    const compose = createComposePortableMcpForConversation(deps);
    const portable = await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/projects/proj/.worktrees/sess",
    });

    const calc = portable.servers.find((s) => s.id === "calc");
    expect(calc?.enabled).toBe(false);
  });

  it("appends gateway servers produced by buildGatewayServers", async () => {
    const customGateway: PortableMcpServerConfig = {
      id: "cc-session-tools",
      transport: "streamable-http",
      url: "http://localhost:3000/api/projects/x/sessions/y/mcp",
    };

    const deps = createDeps({
      buildGatewayServers: () => [customGateway],
    });
    const compose = createComposePortableMcpForConversation(deps);
    const portable = await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "x",
      sessionName: "y",
      conversationId: "conv",
      worktreePath: "/worktree",
    });

    const ids = portable.servers.map((s) => s.id);
    expect(ids).toContain("cc-session-tools");
  });

  it("passes transient tooling overrides through to the pure composer", async () => {
    const deps = createDeps();
    const compose = createComposePortableMcpForConversation(deps);
    const portable = await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/worktree",
      transientPortableMcp: {
        servers: [
          {
            id: "cc-graph-workflow",
            transport: "streamable-http",
            url: "http://localhost:3000/gw",
          },
        ],
      },
    });

    const ids = portable.servers.map((s) => s.id);
    expect(ids).toContain("cc-graph-workflow");
  });
});
