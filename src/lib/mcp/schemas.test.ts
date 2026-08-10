import { describe, expect, it } from "vitest";
import {
  mcpConfigUpdatedEventSchema,
  mcpConfigViewResponseSchema,
  mcpOverrideOperationSchema,
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
  mcpToolInventoryResultSchema,
  mcpToolsUpdatedEventSchema,
} from "./schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { projectStateSchema } from "@/lib/projects/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";

// ===========================================================================
// Task 1.1 — Canonical MCP override shapes
// ===========================================================================

describe("mcpOverridesSchema", () => {
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

describe("mcpRuntimeApplicationStateSchema", () => {
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

describe("mcpConfigViewResponseSchema", () => {
  it("parses a populated response with server rows, tool rows, flags, and diagnostics", () => {
    const input = {
      level: "conversation",
      projectName: "repo",
      sessionName: "main",
      conversationId: "c1",
      servers: [
        {
          serverKey: "playwright",
          displayName: "Playwright",
          nativeId: "playwright",
          transport: "stdio",
          enabled: true,
          inheritanceStatus: "inherited",
          sourceRefs: [
            {
              scope: "project",
              filePath: "/repo/.mcp.json",
            },
          ],
          reserved: false,
          orphaned: false,
          pending: false,
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
            scope: "global",
            filePath: "/cc-config/.mcp.json",
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

describe("mcpToolInventoryResultSchema", () => {
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
});

// ===========================================================================
// Task 13 — MCP live-update SSE events
// ===========================================================================

describe("mcpConfigUpdatedEventSchema", () => {
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
      tools: [{ name: "evil" }],
    });
    expect(result.success).toBe(false);
  });
});
