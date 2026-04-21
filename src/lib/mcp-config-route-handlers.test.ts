/**
 * Factory-level tests for MCP config route handlers across all four scopes
 * and for the scoped tool-inventory endpoint pair. Each handler is built via
 * dependency injection — no HTTP or network in scope here.
 */

import { describe, expect, it, vi } from "vitest";

import type { GlobalOverrideStore } from "@/lib/mcp/global-store";
import type { ScopeOverrideStore } from "@/lib/mcp/scope-store";
import type { ToolInventoryCache } from "@/lib/mcp/tool-discovery-cache";
import type { McpOverrideOperation, McpOverrides } from "@/lib/schemas";
import type {
  McpSourceDiscoveryInput,
  McpSourceDiscoveryResult,
} from "@/lib/mcp/types";
import type {
  AfterOverrideChangeInput,
  ConversationApplyResult,
} from "@/lib/mcp/runtime-apply";
import type { McpServerDefinition } from "@/lib/mcp/types";
import type { ConversationState, SessionState } from "@/types";

import {
  createConversationMcpConfigHandlers,
  createGlobalMcpConfigHandlers,
  createGlobalToolInventoryHandlers,
  createProjectMcpConfigHandlers,
  createProjectToolInventoryHandlers,
  createSessionMcpConfigHandlers,
  createSessionToolInventoryHandlers,
  createToolInventoryHandlers,
  type McpConfigRouteBroadcast,
} from "./mcp-config-route-handlers";

function makeRequest(body?: unknown): Request {
  const init: RequestInit =
    body === undefined
      ? {}
      : {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  return new Request("http://localhost/test", init);
}

function emptyDiscovery(): McpSourceDiscoveryResult {
  return { servers: [], diagnostics: [], sourceFiles: [] };
}

function mkDefinition(
  key: string,
  overrides: Partial<McpServerDefinition> = {},
): McpServerDefinition {
  return {
    serverKey: key,
    nativeId: key,
    backend: overrides.backend ?? "shared",
    transport: overrides.transport ?? "stdio",
    config: overrides.config ?? { transport: "stdio", command: "/bin/echo" },
    sourceRefs: overrides.sourceRefs ?? [
      {
        backend: "claude",
        scope: "user",
        filePath: "/home/alex/.claude/settings.json",
      },
    ],
    configSignature: overrides.configSignature ?? `sig-${key}`,
    reserved: overrides.reserved ?? false,
    diagnostics: overrides.diagnostics ?? [],
    ...(overrides.native !== undefined ? { native: overrides.native } : {}),
  };
}

function mkGlobalStore(initial: McpOverrides): GlobalOverrideStore {
  let overrides: McpOverrides = initial;
  return {
    async read() {
      return overrides;
    },
    async patch({ operations }) {
      const changed: string[] = [];
      const next: McpOverrides = {
        servers: { ...overrides.servers },
      };
      for (const op of operations) {
        if (op.type === "set-server-enabled") {
          next.servers[op.serverKey] = {
            ...next.servers[op.serverKey],
            enabled: op.enabled,
          };
          changed.push(op.serverKey);
        } else if (op.type === "reset-server") {
          delete next.servers[op.serverKey];
          changed.push(op.serverKey);
        }
      }
      overrides = next;
      return { overrides: next, changedServerKeys: changed };
    },
  };
}

function mkScopeStore(): {
  store: ScopeOverrideStore;
  calls: {
    project: Array<{
      path: string;
      operations: readonly McpOverrideOperation[];
    }>;
    session: Array<{
      path: string;
      name: string;
      ops: readonly McpOverrideOperation[];
    }>;
    conversation: Array<{
      path: string;
      name: string;
      conversationId: string;
      ops: readonly McpOverrideOperation[];
    }>;
  };
} {
  const calls = {
    project: [] as Array<{
      path: string;
      operations: readonly McpOverrideOperation[];
    }>,
    session: [] as Array<{
      path: string;
      name: string;
      ops: readonly McpOverrideOperation[];
    }>,
    conversation: [] as Array<{
      path: string;
      name: string;
      conversationId: string;
      ops: readonly McpOverrideOperation[];
    }>,
  };
  const store: ScopeOverrideStore = {
    async patchProject(projectPath, operations) {
      calls.project.push({ path: projectPath, operations });
      const changed = operations.map((o) => o.serverKey);
      return { overrides: { servers: {} }, changedServerKeys: changed };
    },
    async patchSession(projectPath, sessionName, operations) {
      calls.session.push({
        path: projectPath,
        name: sessionName,
        ops: operations,
      });
      const changed = operations.map((o) => o.serverKey);
      return { overrides: { servers: {} }, changedServerKeys: changed };
    },
    async patchConversation(
      projectPath,
      sessionName,
      conversationId,
      operations,
    ) {
      calls.conversation.push({
        path: projectPath,
        name: sessionName,
        conversationId,
        ops: operations,
      });
      const changed = operations.map((o) => o.serverKey);
      return { overrides: { servers: {} }, changedServerKeys: changed };
    },
  };
  return { store, calls };
}

const EMPTY_OVERRIDES: McpOverrides = { servers: {} };

// ---------------------------------------------------------------------------
// 12.1 — Global endpoints
// ---------------------------------------------------------------------------

describe("createGlobalMcpConfigHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createGlobalMcpConfigHandlers>[0]
    > = {},
  ) {
    return {
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async (_: McpSourceDiscoveryInput) =>
        emptyDiscovery(),
      homePath: () => "/home/test",
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns a view with level=global and servers from user-scope discovery", async () => {
    const deps = baseDeps({
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createGlobalMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("global");
    expect(
      body.view.servers.map((s: { serverKey: string }) => s.serverKey),
    ).toContain("calc");
    expect(typeof body.view.effectiveConfigHash).toBe("string");
  });

  it("PATCH applies operations via the store and returns the updated view + hash", async () => {
    const store = mkGlobalStore(EMPTY_OVERRIDES);
    const deps = baseDeps({
      globalStore: store,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createGlobalMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("global");
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.enabled).toBe(false);
    expect(typeof body.effectiveConfigHash).toBe("string");
  });

  it("PATCH returns 400 on invalid body (Zod failure)", async () => {
    const deps = baseDeps();
    const handlers = createGlobalMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({ operations: [{ type: "unknown", serverKey: "calc" }] }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH returns 409 when expectedEffectiveConfigHash does not match the pre-write hash", async () => {
    const deps = baseDeps({
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createGlobalMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
        expectedEffectiveConfigHash: "definitely-not-the-real-hash",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("PATCH succeeds when expectedEffectiveConfigHash matches the current hash", async () => {
    const deps = baseDeps({
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createGlobalMcpConfigHandlers(deps);
    const getRes = await handlers.GET(makeRequest());
    const current = await getRes.json();
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
        expectedEffectiveConfigHash: current.view.effectiveConfigHash,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("broadcasts global-scope change after a successful PATCH", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({
      broadcast,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createGlobalMcpConfigHandlers(deps);
    await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("config-updated");
    if (call.kind !== "config-updated") throw new Error("unexpected kind");
    expect(call.level).toBe("global");
    expect(call.changedServerKeys).toEqual(["calc"]);
    expect(typeof call.effectiveConfigHash).toBe("string");
  });

  it("PATCH returns 500 when the store throws", async () => {
    const store = mkGlobalStore(EMPTY_OVERRIDES);
    store.patch = async () => {
      throw new Error("disk full");
    };
    const deps = baseDeps({ globalStore: store });
    const handlers = createGlobalMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
    );
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 12.2 — Project endpoints
// ---------------------------------------------------------------------------

describe("createProjectMcpConfigHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createProjectMcpConfigHandlers>[0]
    > = {},
  ) {
    const scope = mkScopeStore();
    return {
      scopeStore: scope.store,
      scopeCalls: scope.calls,
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async (_: McpSourceDiscoveryInput) =>
        emptyDiscovery(),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      readProjectOverrides: async (_path: string) =>
        undefined as McpOverrides | undefined,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns a view with level=project for a known project", async () => {
    const deps = baseDeps();
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("project");
    expect(body.view.projectName).toBe("proj");
  });

  it("GET returns 404 for an unknown project", async () => {
    const deps = baseDeps();
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH applies project overrides via the scope store", async () => {
    const scope = mkScopeStore();
    const deps = baseDeps({ scopeStore: scope.store });
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
      }),
      { params: Promise.resolve({ name: "proj" }) },
    );
    expect(res.status).toBe(200);
    expect(scope.calls.project).toHaveLength(1);
    expect(scope.calls.project[0]!.path).toBe("/projects/proj");
  });

  it("PATCH returns 409 on hash mismatch", async () => {
    const deps = baseDeps();
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
        expectedEffectiveConfigHash: "mismatch",
      }),
      { params: Promise.resolve({ name: "proj" }) },
    );
    expect(res.status).toBe(409);
  });

  it("broadcasts project-scope change after PATCH", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({ broadcast });
    const handlers = createProjectMcpConfigHandlers(deps);
    await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
      }),
      { params: Promise.resolve({ name: "proj" }) },
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("config-updated");
    if (call.kind !== "config-updated") throw new Error("unexpected kind");
    expect(call.level).toBe("project");
    expect(call.projectName).toBe("proj");
  });

  it("GET includes project overrides in the cascade", async () => {
    const deps = baseDeps({
      readProjectOverrides: async () => ({
        servers: { calc: { enabled: false } },
      }),
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.enabled).toBe(false);
    expect(calc.inheritanceStatus).toBe("disabled");
  });

  it("PATCH response reflects newly-patched project overrides", async () => {
    // Scope store that persists patched project overrides, plus a
    // readProjectOverrides that reads the latest persisted state.
    let stored: McpOverrides | undefined;
    const scope: ScopeOverrideStore = {
      async patchProject(_path, operations) {
        const servers = { ...(stored?.servers ?? {}) };
        for (const op of operations) {
          if (op.type === "set-server-enabled") {
            servers[op.serverKey] = {
              ...servers[op.serverKey],
              enabled: op.enabled,
            };
          } else if (op.type === "reset-server") {
            delete servers[op.serverKey];
          }
        }
        stored = { servers };
        return {
          overrides: stored,
          changedServerKeys: operations.map((o) => o.serverKey),
        };
      },
      async patchSession() {
        return { overrides: { servers: {} }, changedServerKeys: [] };
      },
      async patchConversation() {
        return { overrides: { servers: {} }, changedServerKeys: [] };
      },
    };
    const deps = baseDeps({
      scopeStore: scope,
      readProjectOverrides: async () => stored,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createProjectMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: false },
        ],
      }),
      { params: Promise.resolve({ name: "proj" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.enabled).toBe(false);
    expect(calc.inheritanceStatus).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// 12.3 — Session endpoints
// ---------------------------------------------------------------------------

function mkSession(
  name: string,
  extras: Partial<SessionState> = {},
): SessionState {
  return {
    name,
    worktreePath: `/projects/proj/.worktrees/${name}`,
    branch: `csm/${name}`,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conversations: [],
    activeConversationId: null,
    ...extras,
  } as unknown as SessionState;
}

function mkConversation(id: string): ConversationState {
  return {
    id,
    createdAt: new Date().toISOString(),
    title: "test",
  } as unknown as ConversationState;
}

describe("createSessionMcpConfigHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createSessionMcpConfigHandlers>[0]
    > = {},
  ) {
    const scope = mkScopeStore();
    return {
      scopeStore: scope.store,
      scopeCalls: scope.calls,
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async (_: McpSourceDiscoveryInput) =>
        emptyDiscovery(),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      getSession: async (_path: string, name: string) =>
        name === "sess" ? mkSession("sess") : null,
      readProjectOverrides: async (_path: string) =>
        undefined as McpOverrides | undefined,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns session-level view when project+session exist", async () => {
    const deps = baseDeps();
    const handlers = createSessionMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", session: "sess" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("session");
    expect(body.view.sessionName).toBe("sess");
  });

  it("GET returns 404 when session is missing", async () => {
    const deps = baseDeps({
      getSession: async () => null,
    });
    const handlers = createSessionMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", session: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH applies session overrides via the scope store", async () => {
    const scope = mkScopeStore();
    const deps = baseDeps({ scopeStore: scope.store });
    const handlers = createSessionMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
      }),
      { params: Promise.resolve({ name: "proj", session: "sess" }) },
    );
    expect(res.status).toBe(200);
    expect(scope.calls.session).toHaveLength(1);
    expect(scope.calls.session[0]!.name).toBe("sess");
  });

  it("GET includes project overrides in the cascade so a project-disabled server reads as inherited (disabled) at session level", async () => {
    const deps = baseDeps({
      readProjectOverrides: async () => ({
        servers: { calc: { enabled: false } },
      }),
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createSessionMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", session: "sess" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.enabled).toBe(false);
    expect(calc.inheritanceStatus).toBe("inherited");
  });

  it("PATCH returns 409 when project-scope overrides have changed since the client's hash was read", async () => {
    const projectOverridesRef: { current: McpOverrides | undefined } = {
      current: undefined,
    };
    const deps = baseDeps({
      readProjectOverrides: async () => projectOverridesRef.current,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createSessionMcpConfigHandlers(deps);
    const firstGet = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", session: "sess" }),
    });
    const firstBody = await firstGet.json();
    const clientHash = firstBody.view.effectiveConfigHash as string;

    // Project-level override lands before the session PATCH.
    projectOverridesRef.current = { servers: { calc: { enabled: false } } };

    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
        expectedEffectiveConfigHash: clientHash,
      }),
      { params: Promise.resolve({ name: "proj", session: "sess" }) },
    );
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 12.4 — Conversation endpoints
// ---------------------------------------------------------------------------

describe("createConversationMcpConfigHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createConversationMcpConfigHandlers>[0]
    > = {},
  ) {
    const scope = mkScopeStore();
    const apply = vi.fn<
      (input: AfterOverrideChangeInput) => Promise<ConversationApplyResult>
    >(async (input) => ({
      conversationId: input.conversationId,
      backend: input.backend,
      disposition: "applied_now",
      effectiveConfigHash: "fake-hash",
    }));
    return {
      scopeStore: scope.store,
      scopeCalls: scope.calls,
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async (_: McpSourceDiscoveryInput) =>
        emptyDiscovery(),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      getSession: async (_path: string, name: string) =>
        name === "sess"
          ? mkSession("sess", {
              conversations: [mkConversation("conv-1")],
            })
          : null,
      readProjectOverrides: async (_path: string) =>
        undefined as McpOverrides | undefined,
      applyAfterOverrideChange: apply,
      applyMock: apply,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns conversation-level view", async () => {
    const deps = baseDeps();
    const handlers = createConversationMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("conversation");
    expect(body.view.conversationId).toBe("conv-1");
  });

  it("GET returns 404 when conversation is missing", async () => {
    const deps = baseDeps();
    const handlers = createConversationMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "ghost",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH applies conversation overrides, triggers runtime apply, and returns apply result", async () => {
    const deps = baseDeps();
    const handlers = createConversationMcpConfigHandlers(deps);
    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
      }),
      {
        params: Promise.resolve({
          name: "proj",
          session: "sess",
          conversationId: "conv-1",
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.view.level).toBe("conversation");
    expect(body.apply.disposition).toBe("applied_now");
    expect(deps.applyMock).toHaveBeenCalledTimes(1);
  });

  it("GET includes project overrides in the cascade so a project-disabled server reads as inherited (disabled) at conversation level", async () => {
    const deps = baseDeps({
      readProjectOverrides: async () => ({
        servers: { calc: { enabled: false } },
      }),
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createConversationMcpConfigHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.enabled).toBe(false);
    expect(calc.inheritanceStatus).toBe("inherited");
  });

  it("PATCH returns 409 when project-scope overrides have changed since the client's hash was read", async () => {
    const projectOverridesRef: { current: McpOverrides | undefined } = {
      current: undefined,
    };
    const deps = baseDeps({
      readProjectOverrides: async () => projectOverridesRef.current,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
    });
    const handlers = createConversationMcpConfigHandlers(deps);
    const firstGet = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
      }),
    });
    const firstBody = await firstGet.json();
    const clientHash = firstBody.view.effectiveConfigHash as string;

    // Project-level override lands before the conversation PATCH.
    projectOverridesRef.current = { servers: { calc: { enabled: false } } };

    const res = await handlers.PATCH(
      makeRequest({
        operations: [
          { type: "set-server-enabled", serverKey: "calc", enabled: true },
        ],
        expectedEffectiveConfigHash: clientHash,
      }),
      {
        params: Promise.resolve({
          name: "proj",
          session: "sess",
          conversationId: "conv-1",
        }),
      },
    );
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Tool inventory cache integration — GET handlers surface cached inventories
// through the resolved view so server cards can render tool rows without
// forcing an additional round-trip to the tools endpoint.
// ---------------------------------------------------------------------------

describe("GET handlers surface cached tool inventories", () => {
  function readyCache(): ToolInventoryCache {
    return {
      peek: () => ({
        state: "ready",
        tools: [{ name: "add" }, { name: "subtract" }],
        diagnostics: [],
      }),
      refresh: async () => ({
        state: "ready",
        tools: [],
        diagnostics: [],
      }),
      getOrFetch: async () => ({
        state: "ready",
        tools: [],
        diagnostics: [],
      }),
      markStale: () => {},
      onCompletion: () => () => {},
    };
  }

  it("global GET attaches cached tool inventory + calls onDefinitionLoaded for each discovered server", async () => {
    const onDefinitionLoaded = vi.fn();
    const handlers = createGlobalMcpConfigHandlers({
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      toolInventoryCache: readyCache(),
      onDefinitionLoaded,
    });
    const res = await handlers.GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.tools.state).toBe("ready");
    expect(calc.tools.tools.map((t: { name: string }) => t.name)).toEqual([
      "add",
      "subtract",
    ]);
    expect(onDefinitionLoaded).toHaveBeenCalledTimes(1);
    const [key, definition] = onDefinitionLoaded.mock.calls[0]!;
    expect(key).toMatchObject({
      backend: "claude",
      serverKey: "calc",
      configSignature: "sig-calc",
    });
    expect(definition.serverKey).toBe("calc");
  });

  it("project GET attaches cached tool inventory", async () => {
    const handlers = createProjectMcpConfigHandlers({
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      scopeStore: mkScopeStore().store,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async () => "/projects/proj",
      readProjectOverrides: async () => undefined,
      toolInventoryCache: readyCache(),
    });
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj" }),
    });
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.tools.state).toBe("ready");
    expect(calc.tools.tools).toHaveLength(2);
  });

  it("session GET attaches cached tool inventory", async () => {
    const handlers = createSessionMcpConfigHandlers({
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      scopeStore: mkScopeStore().store,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async () => "/projects/proj",
      getSession: async () => mkSession("sess"),
      readProjectOverrides: async () => undefined,
      toolInventoryCache: readyCache(),
    });
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", session: "sess" }),
    });
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.tools.state).toBe("ready");
    expect(calc.tools.tools).toHaveLength(2);
  });

  it("conversation GET attaches cached tool inventory", async () => {
    const handlers = createConversationMcpConfigHandlers({
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      scopeStore: mkScopeStore().store,
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async () => "/projects/proj",
      getSession: async () =>
        mkSession("sess", { conversations: [mkConversation("conv-1")] }),
      readProjectOverrides: async () => undefined,
      applyAfterOverrideChange: async () => ({
        conversationId: "conv-1",
        backend: "claude",
        disposition: "applied_now",
        effectiveConfigHash: "fake-hash",
      }),
      toolInventoryCache: readyCache(),
    });
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
      }),
    });
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.tools.state).toBe("ready");
    expect(calc.tools.tools).toHaveLength(2);
  });

  it("omitted toolInventoryCache yields not-loaded tool state (pre-wiring behaviour preserved)", async () => {
    const handlers = createGlobalMcpConfigHandlers({
      globalStore: mkGlobalStore(EMPTY_OVERRIDES),
      discoverAllSources: async () => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
    });
    const res = await handlers.GET(makeRequest());
    const body = await res.json();
    const calc = body.view.servers.find(
      (s: { serverKey: string }) => s.serverKey === "calc",
    );
    expect(calc.tools.state).toBe("not-loaded");
    expect(calc.tools.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12.5 — Tool inventory endpoints
// ---------------------------------------------------------------------------

describe("createToolInventoryHandlers", () => {
  function mkCache(): ToolInventoryCache {
    const peek: ToolInventoryCache["peek"] = () => ({
      state: "ready",
      tools: [{ name: "add" }, { name: "subtract" }],
      diagnostics: [],
    });
    const refresh: ToolInventoryCache["refresh"] = async () => ({
      state: "ready",
      tools: [{ name: "add" }, { name: "subtract" }, { name: "multiply" }],
      diagnostics: [],
      refreshedAt: new Date().toISOString(),
    });
    const getOrFetch: ToolInventoryCache["getOrFetch"] = async () => ({
      state: "ready",
      tools: [{ name: "add" }],
      diagnostics: [],
    });
    return {
      peek,
      refresh,
      getOrFetch,
      markStale: () => {},
      onCompletion: () => () => {},
    };
  }

  function baseDeps(
    overrides: Partial<Parameters<typeof createToolInventoryHandlers>[0]> = {},
  ) {
    return {
      cache: mkCache(),
      discoverAllSources: async (_: McpSourceDiscoveryInput) => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      getSession: async (_path: string, name: string) =>
        name === "sess"
          ? mkSession("sess", {
              conversations: [mkConversation("conv-1")],
            })
          : null,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns the cached inventory for a known server", async () => {
    const deps = baseDeps();
    const handlers = createToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
        serverKey: "calc",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ready");
    expect(body.tools.map((t: { name: string }) => t.name)).toContain("add");
  });

  it("GET returns 404 for unknown server key", async () => {
    const deps = baseDeps();
    const handlers = createToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
        serverKey: "ghost",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("POST forces a refresh and returns the new inventory", async () => {
    const deps = baseDeps();
    const refreshSpy = vi.spyOn(deps.cache, "refresh");
    const handlers = createToolInventoryHandlers(deps);
    const res = await handlers.POST(makeRequest({}), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
        serverKey: "calc",
      }),
    });
    expect(res.status).toBe(200);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.tools.map((t: { name: string }) => t.name)).toContain(
      "multiply",
    );
  });

  it("POST broadcasts mcp-tools-updated after refresh", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({ broadcast });
    const handlers = createToolInventoryHandlers(deps);
    await handlers.POST(makeRequest({}), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        conversationId: "conv-1",
        serverKey: "calc",
      }),
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("tools-updated");
  });
});

// ---------------------------------------------------------------------------
// 12.5b — Scoped tool inventory (global / project / session)
// ---------------------------------------------------------------------------

function mkToolCache(): ToolInventoryCache {
  return {
    peek: () => ({
      state: "ready",
      tools: [{ name: "add" }],
      diagnostics: [],
    }),
    refresh: async () => ({
      state: "ready",
      tools: [{ name: "add" }, { name: "multiply" }],
      diagnostics: [],
      refreshedAt: new Date().toISOString(),
    }),
    getOrFetch: async () => ({
      state: "ready",
      tools: [{ name: "add" }],
      diagnostics: [],
    }),
    markStale: () => {},
    onCompletion: () => () => {},
  };
}

describe("createGlobalToolInventoryHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createGlobalToolInventoryHandlers>[0]
    > = {},
  ) {
    return {
      cache: mkToolCache(),
      discoverAllSources: async (_: McpSourceDiscoveryInput) => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns the cached inventory for a known user-scope server", async () => {
    const deps = baseDeps();
    const handlers = createGlobalToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ serverKey: "calc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ready");
  });

  it("GET returns 404 for an unknown server", async () => {
    const deps = baseDeps();
    const handlers = createGlobalToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ serverKey: "ghost" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST forces a refresh and broadcasts tools-updated at global level", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({ broadcast });
    const handlers = createGlobalToolInventoryHandlers(deps);
    const res = await handlers.POST(makeRequest({}), {
      params: Promise.resolve({ serverKey: "calc" }),
    });
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("tools-updated");
    if (call.kind !== "tools-updated") throw new Error("unexpected kind");
    expect(call.level).toBe("global");
    expect(call.serverKey).toBe("calc");
  });
});

describe("createProjectToolInventoryHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createProjectToolInventoryHandlers>[0]
    > = {},
  ) {
    return {
      cache: mkToolCache(),
      discoverAllSources: async (_: McpSourceDiscoveryInput) => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns the cached inventory for a known server at project scope", async () => {
    const deps = baseDeps();
    const handlers = createProjectToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "proj", serverKey: "calc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ready");
  });

  it("GET returns 404 when project is unknown", async () => {
    const deps = baseDeps();
    const handlers = createProjectToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({ name: "missing", serverKey: "calc" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST forces a refresh and broadcasts tools-updated at project level", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({ broadcast });
    const handlers = createProjectToolInventoryHandlers(deps);
    const res = await handlers.POST(makeRequest({}), {
      params: Promise.resolve({ name: "proj", serverKey: "calc" }),
    });
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("tools-updated");
    if (call.kind !== "tools-updated") throw new Error("unexpected kind");
    expect(call.level).toBe("project");
    expect(call.projectName).toBe("proj");
    expect(call.serverKey).toBe("calc");
  });
});

describe("createSessionToolInventoryHandlers", () => {
  function baseDeps(
    overrides: Partial<
      Parameters<typeof createSessionToolInventoryHandlers>[0]
    > = {},
  ) {
    return {
      cache: mkToolCache(),
      discoverAllSources: async (_: McpSourceDiscoveryInput) => ({
        servers: [mkDefinition("calc")],
        diagnostics: [],
        sourceFiles: [],
      }),
      homePath: () => "/home/test",
      resolveProjectPath: async (name: string) =>
        name === "proj" ? "/projects/proj" : null,
      getSession: async (_path: string, name: string) =>
        name === "sess" ? mkSession("sess") : null,
      broadcast: vi.fn<McpConfigRouteBroadcast>(),
      ...overrides,
    };
  }

  it("GET returns the cached inventory for a known server at session scope", async () => {
    const deps = baseDeps();
    const handlers = createSessionToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        serverKey: "calc",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("ready");
  });

  it("GET returns 404 when session is unknown", async () => {
    const deps = baseDeps();
    const handlers = createSessionToolInventoryHandlers(deps);
    const res = await handlers.GET(makeRequest(), {
      params: Promise.resolve({
        name: "proj",
        session: "ghost",
        serverKey: "calc",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("POST forces a refresh and broadcasts tools-updated at session level", async () => {
    const broadcast = vi.fn<McpConfigRouteBroadcast>();
    const deps = baseDeps({ broadcast });
    const handlers = createSessionToolInventoryHandlers(deps);
    const res = await handlers.POST(makeRequest({}), {
      params: Promise.resolve({
        name: "proj",
        session: "sess",
        serverKey: "calc",
      }),
    });
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0]![0];
    expect(call.kind).toBe("tools-updated");
    if (call.kind !== "tools-updated") throw new Error("unexpected kind");
    expect(call.level).toBe("session");
    expect(call.projectName).toBe("proj");
    expect(call.sessionName).toBe("sess");
    expect(call.serverKey).toBe("calc");
  });
});
