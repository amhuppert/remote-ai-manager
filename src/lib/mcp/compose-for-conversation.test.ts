import { describe, expect, it, vi } from "vitest";

import type {
  PortableMcpConfig,
  PortableMcpServerConfig,
} from "@/lib/agent-backends/portable-mcp";
import type { McpOverrides } from "@/lib/mcp/schemas";
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
    transport: partial.transport ?? "stdio",
    config: partial.config ?? {
      transport: "stdio",
      command: "/bin/echo",
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
      overrideChain: { global: emptyOverrides },
      discovered,
      gatewayServers: [gateway],
      reservedGatewayIds: [],
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
      overrideChain: {
        global: emptyOverrides,
        project: emptyOverrides,
        session: sessionOverrides,
      },
      discovered,
      gatewayServers: [gateway],
      reservedGatewayIds: [],
    });

    const calc = result.portable.servers.find((s) => s.id === "calc");
    expect(calc?.enabled).toBe(false);
  });

  it("conversation-level override wins over session-level", () => {
    const discovered = [mkDefinition({ serverKey: "calc" })];

    const result = composePortableForConversation({
      overrideChain: {
        global: emptyOverrides,
        session: { servers: { calc: { enabled: false } } },
        conversation: { servers: { calc: { enabled: true } } },
      },
      discovered,
      gatewayServers: [gateway],
      reservedGatewayIds: [],
    });

    const calc = result.portable.servers.find((s) => s.id === "calc");
    expect(calc?.enabled).toBe(true);
  });

  it("omits orphaned overrides (override references server not in discovery)", () => {
    const result = composePortableForConversation({
      overrideChain: {
        global: emptyOverrides,
        session: { servers: { "ghost-server": { enabled: true } } },
      },
      discovered: [],
      gatewayServers: [gateway],
      reservedGatewayIds: [],
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
      overrideChain: { global: emptyOverrides },
      discovered,
      gatewayServers: [gateway],
      reservedGatewayIds: [],
    });

    const gatewayEntries = result.portable.servers.filter(
      (s) => s.id === "cc-session-tools",
    );
    expect(gatewayEntries).toHaveLength(1);
    expect(gatewayEntries[0]?.transport).toBe("streamable-http");
  });

  it("reserves ids passed via reservedGatewayIds even when no gateway server is emitted", () => {
    const discovered = [
      mkDefinition({
        serverKey: "cc-session-tools",
        nativeId: "cc-session-tools",
      }),
      mkDefinition({ serverKey: "calc" }),
    ];

    const result = composePortableForConversation({
      overrideChain: { global: emptyOverrides },
      discovered,
      gatewayServers: [],
      reservedGatewayIds: ["cc-session-tools"],
    });

    const ids = result.portable.servers.map((s) => s.id);
    expect(ids).toEqual(["calc"]);
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
      overrideChain: { global: emptyOverrides },
      discovered: [mkDefinition({ serverKey: "calc" })],
      gatewayServers: [gateway],
      reservedGatewayIds: [],
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
      overrideChain: { global: emptyOverrides },
      discovered: [mkDefinition({ serverKey: "calc" })],
      gatewayServers: [gateway],
      reservedGatewayIds: [],
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
      globalConfigPath: () => "/home/alex/.config/cc/.mcp.json",
      buildGatewayServers: () => [gateway],
      buildReservedGatewayIds: () => [],
      ...overrides,
    };
  }

  it("invokes discoverSources with globalConfigPath and worktreePath and no backend filter", async () => {
    const discoverSources = vi.fn<ComposePortableMcpDeps["discoverSources"]>(
      async () => ({
        servers: [] as McpServerDefinition[],
        diagnostics: [],
        sourceFiles: [],
      }),
    );

    const deps = createDeps({ discoverSources });
    const compose = createComposePortableMcpForConversation(deps);
    await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/projects/proj/.worktrees/sess",
    });

    expect(discoverSources).toHaveBeenCalledTimes(1);
    const callArgs = discoverSources.mock.calls[0]![0]!;
    expect(typeof callArgs.globalConfigPath).toBe("string");
    expect(callArgs.globalConfigPath.length).toBeGreaterThan(0);
    expect(callArgs.worktreePath).toBe("/projects/proj/.worktrees/sess");
    expect(callArgs).not.toHaveProperty("backends");
    expect(callArgs).not.toHaveProperty("backend");
  });

  it("reads all four override levels when composing", async () => {
    const readGlobalOverrides = vi.fn(async () => emptyOverrides);
    const readProjectOverrides = vi.fn(async () => undefined);
    const readSessionOverrides = vi.fn(async () => undefined);
    const readConversationOverrides = vi.fn(async () => undefined);

    const deps = createDeps({
      readGlobalOverrides,
      readProjectOverrides,
      readSessionOverrides,
      readConversationOverrides,
    });
    const compose = createComposePortableMcpForConversation(deps);
    await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/projects/proj/.worktrees/sess",
    });

    expect(readGlobalOverrides).toHaveBeenCalledTimes(1);
    expect(readProjectOverrides).toHaveBeenCalledWith("/projects/proj");
    expect(readSessionOverrides).toHaveBeenCalledWith("/projects/proj", "sess");
    expect(readConversationOverrides).toHaveBeenCalledWith(
      "/projects/proj",
      "sess",
      "conv",
    );
  });

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
      url: "http://localhost:3000/api/projects/x/sessions/y/conversations/conv/mcp",
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

  it("passes backend and conversationId to buildGatewayServers", async () => {
    const buildGatewayServers = vi.fn<
      ComposePortableMcpDeps["buildGatewayServers"]
    >(() => []);

    const deps = createDeps({ buildGatewayServers });
    const compose = createComposePortableMcpForConversation(deps);
    await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj-name",
      sessionName: "sess-name",
      conversationId: "conv-xyz",
      worktreePath: "/worktree",
    });

    expect(buildGatewayServers).toHaveBeenCalledWith(
      "claude",
      "proj-name",
      "sess-name",
      "conv-xyz",
    );
  });

  it("passes backend to buildReservedGatewayIds", async () => {
    const buildReservedGatewayIds = vi.fn<
      ComposePortableMcpDeps["buildReservedGatewayIds"]
    >(() => []);

    const deps = createDeps({ buildReservedGatewayIds });
    const compose = createComposePortableMcpForConversation(deps);
    await compose({
      backend: "codex",
      projectPath: "/projects/proj",
      projectName: "proj-name",
      sessionName: "sess-name",
      conversationId: "conv-xyz",
      worktreePath: "/worktree",
    });

    expect(buildReservedGatewayIds).toHaveBeenCalledWith("codex");
  });

  it("for backend=claude, omits cc-session-tools from the portable config when buildGatewayServers returns []", async () => {
    const deps = createDeps({
      buildGatewayServers: (backend) => (backend === "claude" ? [] : [gateway]),
      buildReservedGatewayIds: () => ["cc-session-tools"],
    });

    const compose = createComposePortableMcpForConversation(deps);
    const portable = await compose({
      backend: "claude",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/worktree",
    });

    const ids = portable.servers.map((s) => s.id);
    expect(ids).not.toContain("cc-session-tools");
  });

  it("for backend=codex, includes a streamable-http cc-session-tools entry", async () => {
    const deps = createDeps({
      buildGatewayServers: (backend) => (backend === "claude" ? [] : [gateway]),
      buildReservedGatewayIds: () => ["cc-session-tools"],
    });

    const compose = createComposePortableMcpForConversation(deps);
    const portable = await compose({
      backend: "codex",
      projectPath: "/projects/proj",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
      worktreePath: "/worktree",
    });

    const entry = portable.servers.find((s) => s.id === "cc-session-tools");
    expect(entry).toBeDefined();
    expect(entry?.transport).toBe("streamable-http");
  });

  it("for backend=claude, drops a colliding user-defined cc-session-tools server from discovery", async () => {
    const deps = createDeps({
      buildGatewayServers: (backend) => (backend === "claude" ? [] : [gateway]),
      buildReservedGatewayIds: () => ["cc-session-tools"],
      discoverSources: async () => ({
        servers: [
          mkDefinition({
            serverKey: "cc-session-tools",
            nativeId: "cc-session-tools",
            config: { transport: "stdio", command: "/user/cc-session-tools" },
          }),
          mkDefinition({ serverKey: "calc" }),
        ],
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
      worktreePath: "/worktree",
    });

    const ids = portable.servers.map((s) => s.id);
    expect(ids).not.toContain("cc-session-tools");
    expect(ids).toContain("calc");
  });

  it("merges transient portable MCP last so graph-workflow tooling wins on id collision", async () => {
    const deps = createDeps({
      discoverSources: async () => ({
        servers: [
          mkDefinition({
            serverKey: "calc",
            nativeId: "calc",
            config: { transport: "stdio", command: "/discovered/calc" },
          }),
        ],
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
      worktreePath: "/worktree",
      transientPortableMcp: {
        servers: [
          {
            id: "cc-graph-workflow",
            transport: "streamable-http",
            url: "http://localhost:3000/gw",
          },
          {
            id: "calc",
            transport: "stdio",
            command: "/transient/calc",
          },
        ],
      },
    });

    const ids = portable.servers.map((s) => s.id);
    expect(ids).toContain("cc-graph-workflow");
    const calc = portable.servers.find((s) => s.id === "calc");
    expect(calc).toBeDefined();
    if (calc?.transport === "stdio") {
      expect(calc.command).toBe("/transient/calc");
    } else {
      throw new Error("expected stdio transport from transient override");
    }
  });
});
