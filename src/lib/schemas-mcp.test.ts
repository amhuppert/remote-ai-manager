import { describe, expect, it } from "vitest";
import {
  conversationStateSchema,
  mcpApplyDispositionSchema,
  mcpConfigLevelSchema,
  mcpConfigPatchRequestSchema,
  mcpConfigUpdatedEventSchema,
  mcpConfigViewResponseSchema,
  mcpGlobalStateSchema,
  mcpInheritanceStatusSchema,
  mcpOverrideOperationSchema,
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
  mcpServerOverrideSchema,
  mcpToolInventoryResultSchema,
  mcpToolOverrideSchema,
  mcpToolsUpdatedEventSchema,
  mcpTransportSchema,
  projectStateSchema,
  sessionStateSchema,
  toolDiscoveryStateSchema,
} from "./schemas";

// ===========================================================================
// Task 1.1 — Canonical MCP override shapes
// ===========================================================================

describe("mcpToolOverrideSchema", () => {
  it("accepts an empty object (no explicit override)", () => {
    const result = mcpToolOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts an explicit enabled flag", () => {
    const result = mcpToolOverrideSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects non-boolean enabled", () => {
    const result = mcpToolOverrideSchema.safeParse({ enabled: "no" });
    expect(result.success).toBe(false);
  });
});

describe("mcpServerOverrideSchema", () => {
  it("accepts empty object", () => {
    const result = mcpServerOverrideSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts enabled flag only", () => {
    const result = mcpServerOverrideSchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("accepts tools map of per-tool overrides", () => {
    const result = mcpServerOverrideSchema.safeParse({
      enabled: true,
      tools: {
        search: { enabled: false },
        scrape: {},
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools?.search?.enabled).toBe(false);
    }
  });
});

describe("mcpOverridesSchema", () => {
  it("requires a servers record (empty allowed)", () => {
    const result = mcpOverridesSchema.safeParse({ servers: {} });
    expect(result.success).toBe(true);
  });

  it("persists per-server server and per-tool overrides", () => {
    const input = {
      servers: {
        playwright: {
          enabled: false,
          tools: { navigate: { enabled: false } },
        },
        kagi: { enabled: true },
      },
    };
    const result = mcpOverridesSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers.playwright?.enabled).toBe(false);
      expect(result.data.servers.kagi?.enabled).toBe(true);
    }
  });
});

describe("mcpGlobalStateSchema", () => {
  it("parses a minimal global state file", () => {
    const input = {
      version: 1,
      overrides: { servers: {} },
      updatedAt: "2026-04-21T12:00:00.000Z",
    };
    const result = mcpGlobalStateSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("requires version to be 1", () => {
    const result = mcpGlobalStateSchema.safeParse({
      version: 2,
      overrides: { servers: {} },
      updatedAt: "2026-04-21T12:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires updatedAt", () => {
    const result = mcpGlobalStateSchema.safeParse({
      version: 1,
      overrides: { servers: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("mcpOverrides field on state schemas", () => {
  const baseConversation = {
    id: "c1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    lastActivityAt: "2026-04-21T00:00:00.000Z",
  };

  const baseSession = {
    sessionName: "test",
    worktreePath: "/tmp/test",
    branchName: "csm/test",
    createdAt: "2026-04-21T00:00:00.000Z",
    lastActivityAt: "2026-04-21T00:00:00.000Z",
  };

  it("conversationStateSchema remains valid with mcpOverrides omitted (additive)", () => {
    const result = conversationStateSchema.safeParse(baseConversation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpOverrides).toBeUndefined();
    }
  });

  it("conversationStateSchema accepts and preserves mcpOverrides", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      mcpOverrides: { servers: { playwright: { enabled: false } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpOverrides?.servers.playwright?.enabled).toBe(false);
    }
  });

  it("sessionStateSchema accepts and preserves mcpOverrides", () => {
    const result = sessionStateSchema.safeParse({
      ...baseSession,
      mcpOverrides: { servers: { kagi: { enabled: false } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpOverrides?.servers.kagi?.enabled).toBe(false);
    }
  });

  it("projectStateSchema accepts and preserves mcpOverrides", () => {
    const result = projectStateSchema.safeParse({
      rootPath: "/repo",
      sessions: {},
      mcpOverrides: { servers: { playwright: { enabled: true } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpOverrides?.servers.playwright?.enabled).toBe(true);
    }
  });
});

// ===========================================================================
// Task 1.2 — Runtime application state
// ===========================================================================

describe("mcpApplyDispositionSchema", () => {
  it("accepts each defined disposition", () => {
    for (const value of [
      "applied_now",
      "deferred_to_next_turn",
      "no_active_runtime",
      "unsupported",
      "rejected",
    ]) {
      expect(mcpApplyDispositionSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects unknown dispositions", () => {
    expect(mcpApplyDispositionSchema.safeParse("applied").success).toBe(false);
  });
});

describe("mcpRuntimeApplicationStateSchema", () => {
  it("accepts an empty runtime state", () => {
    const result = mcpRuntimeApplicationStateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("carries applied/pending hash, pending server keys, last disposition and error", () => {
    const input = {
      lastAppliedConfigHash: "abc",
      pendingConfigHash: "def",
      pendingServerKeys: ["kagi", "playwright"],
      lastApplyDisposition: "deferred_to_next_turn",
      lastApplyError: "could not apply",
    };
    const result = mcpRuntimeApplicationStateSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastAppliedConfigHash).toBe("abc");
      expect(result.data.pendingServerKeys).toEqual(["kagi", "playwright"]);
      expect(result.data.lastApplyDisposition).toBe("deferred_to_next_turn");
    }
  });
});

describe("conversationStateSchema — mcpRuntime field", () => {
  const baseConversation = {
    id: "c1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-04-21T00:00:00.000Z",
    lastActivityAt: "2026-04-21T00:00:00.000Z",
  };

  it("remains valid when mcpRuntime is omitted", () => {
    const result = conversationStateSchema.safeParse(baseConversation);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpRuntime).toBeUndefined();
    }
  });

  it("preserves mcpRuntime when provided", () => {
    const result = conversationStateSchema.safeParse({
      ...baseConversation,
      mcpRuntime: {
        lastAppliedConfigHash: "h1",
        pendingConfigHash: "h2",
        pendingServerKeys: ["a"],
        lastApplyDisposition: "applied_now",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpRuntime?.pendingServerKeys).toEqual(["a"]);
    }
  });
});

// ===========================================================================
// Task 1.3 — API view / patch / tool-inventory shapes
// ===========================================================================

describe("mcpConfigLevelSchema", () => {
  it("accepts each defined level", () => {
    for (const value of ["global", "project", "session", "conversation"]) {
      expect(mcpConfigLevelSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe("mcpTransportSchema", () => {
  it("accepts stdio, streamable-http, sse", () => {
    for (const value of ["stdio", "streamable-http", "sse"]) {
      expect(mcpTransportSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe("mcpInheritanceStatusSchema", () => {
  it("accepts the four defined statuses", () => {
    for (const value of ["explicit", "inherited", "overridden", "disabled"]) {
      expect(mcpInheritanceStatusSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe("toolDiscoveryStateSchema", () => {
  it("accepts the five defined tool discovery states", () => {
    for (const value of ["not-loaded", "loading", "ready", "stale", "error"]) {
      expect(toolDiscoveryStateSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe("mcpConfigViewResponseSchema", () => {
  it("parses a minimal response", () => {
    const input = {
      level: "global",
      servers: [],
      diagnostics: [],
      pendingServerKeys: [],
    };
    const result = mcpConfigViewResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("parses a populated response with server rows, tool rows, flags, compatibility, and diagnostics", () => {
    const input = {
      level: "conversation",
      projectName: "repo",
      sessionName: "main",
      conversationId: "c1",
      backend: "claude",
      servers: [
        {
          serverKey: "playwright",
          displayName: "Playwright",
          nativeId: "playwright",
          backend: "shared",
          transport: "stdio",
          enabled: true,
          inheritanceStatus: "inherited",
          sourceRefs: [
            {
              backend: "claude",
              scope: "project",
              filePath: "/repo/.mcp.json",
            },
          ],
          reserved: false,
          orphaned: false,
          pending: false,
          compatibility: {
            backends: [
              { backend: "claude", supported: true },
              {
                backend: "codex",
                supported: false,
                reason: "stdio filtering not native",
              },
            ],
          },
          tools: {
            state: "ready",
            tools: [
              {
                name: "navigate",
                enabled: true,
                inherited: true,
                inheritanceStatus: "inherited",
                orphaned: false,
                pending: false,
              },
            ],
            refreshedAt: "2026-04-21T00:00:00.000Z",
            diagnostics: [],
          },
          diagnostics: [],
        },
      ],
      diagnostics: [
        {
          severity: "warning",
          code: "mcp.source.malformed",
          message: "JSON parse error",
          sourceRef: {
            backend: "claude",
            scope: "user",
            filePath: "~/.claude/settings.json",
          },
        },
      ],
      pendingServerKeys: ["playwright"],
      effectiveConfigHash: "abc",
    };
    const result = mcpConfigViewResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("mcpOverrideOperationSchema", () => {
  it.each([
    {
      type: "set-server-enabled",
      serverKey: "kagi",
      enabled: false,
    },
    { type: "reset-server", serverKey: "kagi" },
    {
      type: "set-tool-enabled",
      serverKey: "kagi",
      toolName: "search",
      enabled: true,
    },
    { type: "reset-tool", serverKey: "kagi", toolName: "search" },
  ])("accepts operation $type", (op) => {
    expect(mcpOverrideOperationSchema.safeParse(op).success).toBe(true);
  });

  it("rejects unknown operation type", () => {
    const result = mcpOverrideOperationSchema.safeParse({
      type: "delete-server",
      serverKey: "x",
    });
    expect(result.success).toBe(false);
  });

  it("requires enabled on set-server-enabled", () => {
    const result = mcpOverrideOperationSchema.safeParse({
      type: "set-server-enabled",
      serverKey: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("mcpConfigPatchRequestSchema", () => {
  it("requires an operations array (may be empty)", () => {
    const result = mcpConfigPatchRequestSchema.safeParse({ operations: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a request with several operations", () => {
    const result = mcpConfigPatchRequestSchema.safeParse({
      operations: [
        { type: "set-server-enabled", serverKey: "a", enabled: false },
        {
          type: "set-tool-enabled",
          serverKey: "a",
          toolName: "foo",
          enabled: true,
        },
        { type: "reset-server", serverKey: "b" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("mcpToolInventoryResultSchema", () => {
  it("requires state, tools, diagnostics", () => {
    const minimal = {
      state: "not-loaded",
      tools: [],
      diagnostics: [],
    };
    expect(mcpToolInventoryResultSchema.safeParse(minimal).success).toBe(true);
  });

  it("preserves discovery state, tool list, diagnostics, and last refreshed timestamp", () => {
    const input = {
      state: "ready",
      tools: [
        {
          name: "search",
          description: "search the web",
          inputSchema: { type: "object" },
        },
      ],
      diagnostics: [
        {
          severity: "info",
          code: "mcp.tool.cached",
          message: "cached inventory",
        },
      ],
      refreshedAt: "2026-04-21T00:00:00.000Z",
    };
    const result = mcpToolInventoryResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools[0]?.name).toBe("search");
      expect(result.data.refreshedAt).toBe("2026-04-21T00:00:00.000Z");
    }
  });

  it("rejects invalid discovery state", () => {
    const result = mcpToolInventoryResultSchema.safeParse({
      state: "done",
      tools: [],
      diagnostics: [],
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Task 13 — MCP live-update SSE events
// ===========================================================================

describe("mcpConfigUpdatedEventSchema", () => {
  it("accepts a global-scope event with only required fields", () => {
    const result = mcpConfigUpdatedEventSchema.safeParse({
      type: "mcp-config-updated",
      level: "global",
      changedServerKeys: ["calc"],
      effectiveConfigHash: "abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a conversation-scope event with full identifiers", () => {
    const result = mcpConfigUpdatedEventSchema.safeParse({
      type: "mcp-config-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      changedServerKeys: ["a", "b"],
      effectiveConfigHash: "hash",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.changedServerKeys).toEqual(["a", "b"]);
    }
  });

  it("rejects events that attempt to carry server configuration contents", () => {
    const result = mcpConfigUpdatedEventSchema.safeParse({
      type: "mcp-config-updated",
      level: "global",
      changedServerKeys: ["calc"],
      effectiveConfigHash: "abc",
      serverConfig: { command: "evil" },
    });
    expect(result.success).toBe(false);
  });

  it("requires a correct literal type discriminator", () => {
    const result = mcpConfigUpdatedEventSchema.safeParse({
      type: "mcp-config-changed",
      level: "global",
      changedServerKeys: [],
      effectiveConfigHash: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("mcpToolsUpdatedEventSchema", () => {
  it("accepts a conversation-scope event", () => {
    const result = mcpToolsUpdatedEventSchema.safeParse({
      type: "mcp-tools-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      serverKey: "calc",
      configSignature: "sig-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects events that attempt to carry tool list contents", () => {
    const result = mcpToolsUpdatedEventSchema.safeParse({
      type: "mcp-tools-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      serverKey: "calc",
      configSignature: "sig-1",
      tools: [{ name: "evil" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires serverKey and configSignature", () => {
    const result = mcpToolsUpdatedEventSchema.safeParse({
      type: "mcp-tools-updated",
      level: "conversation",
    });
    expect(result.success).toBe(false);
  });
});
