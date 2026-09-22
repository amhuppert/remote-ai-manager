import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  projectConversationTarget,
  conversationTargetStoreSessionName,
} from "@/lib/conversations/conversation-target";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import { createMcpConfigMutationService } from "./config-mutation-service";
import {
  createConversationMcpConfigHandlers,
  createToolInventoryHandlers,
  type McpConfigRouteBroadcastPayload,
} from "./config-route-handlers";
import { createComposePortableMcpForConversation } from "./compose-for-conversation";
import {
  createMcpRuntimeApplicationStore,
  createMcpRuntimeApplyService,
} from "./runtime-apply";
import { createScopeOverrideStore } from "./scope-store";
import type { McpSourceDiscoveryResult } from "./types";

const projectPath = "/projects/example";
const fixture = createPersistenceFixture();
afterEach(() => fixture.reset());
afterAll(() => fixture.close());
const globalStore = {
  read: async () => ({ servers: {} }),
  patch: async () => {
    throw new Error("unused");
  },
  replace: async () => {
    throw new Error("unused");
  },
};
const discovery: McpSourceDiscoveryResult = {
  servers: [
    {
      serverKey: "calc",
      nativeId: "calc",
      transport: "stdio",
      config: { transport: "stdio", command: "calc" },
      sourceRefs: [{ scope: "project", filePath: `${projectPath}/.mcp.json` }],
      configSignature: "calc-1",
      reserved: false,
      diagnostics: [],
    },
  ],
  diagnostics: [],
  sourceFiles: [],
};

async function setup() {
  fixture.seedProject(projectPath);
  for (const id of ["one", "two"]) {
    await fixture.seedProjectConversation(
      projectPath,
      makeConversationState({
        id,
        scope: "project",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
      }),
    );
  }
  const compose = createComposePortableMcpForConversation({
    readGlobalOverrides: globalStore.read,
    readProjectOverrides: fixture.store.getProjectMcpOverrides,
    readSessionOverrides: async () => {
      throw new Error("Project conversation must skip session inheritance");
    },
    readConversationOverrides: async (path, target) =>
      (
        await fixture.store.getConversation(
          path,
          conversationTargetStoreSessionName(target),
          target.conversationId,
        )
      )?.mcpOverrides,
    discoverSources: async () => discovery,
    globalConfigPath: () => "/global/.mcp.json",
  });
  const applied = new Map<string, PortableMcpConfig>();
  const runtimes = new Map<string, ConversationBackendRuntime>();
  for (const id of ["one", "two"]) {
    runtimes.set(id, {
      backend: "claude",
      status: "alive",
      isTurnActive: false,
      modelSelection: { modelId: "test", parameters: {} },
      sendTurn: async () => {
        throw new Error("unused");
      },
      close: async () => {},
      applyPortableMcpConfig: async (config) => {
        applied.set(id, config);
        return {
          disposition: "applied_now",
          droppedServerIds: [],
          droppedFields: [],
          errors: {},
        };
      },
    });
  }
  const runtime = createMcpRuntimeApplyService({
    applicationState: createMcpRuntimeApplicationStore(fixture.store),
    getRuntime: (id) => runtimes.get(id),
    resolvePortableForConversation: async (input) => ({
      portable: await compose({ ...input, worktreePath: projectPath }),
    }),
  });
  const events: McpConfigRouteBroadcastPayload[] = [];
  const deps = {
    globalStore,
    scopeStore: createScopeOverrideStore({ stateManager: fixture.store }),
    mutationService: createMcpConfigMutationService({
      stateManager: fixture.store,
      globalStore,
      discoverAllSources: async () => discovery,
      globalConfigPath: () => "/global/.mcp.json",
    }),
    discoverAllSources: async () => discovery,
    globalConfigPath: () => "/global/.mcp.json",
    resolveProjectPath: async () => projectPath,
    getSession: fixture.store.getSession,
    getProjectConversation: fixture.store.getProjectConversation,
    readProjectOverrides: fixture.store.getProjectMcpOverrides,
    applyAfterOverrideChange: runtime.applyAfterOverrideChange,
    broadcast: (event: McpConfigRouteBroadcastPayload) => {
      events.push(event);
    },
  };
  return {
    handlers: createConversationMcpConfigHandlers(deps),
    deps,
    runtime,
    events,
    applied,
    compose,
  };
}
function context(conversationId: string) {
  return { params: Promise.resolve({ name: "example", conversationId }) };
}
const request = () => new Request("http://cc.test/mcp-config");

describe("project-conversation MCP isolation", () => {
  it("persists an individual selection and applies only that conversation while its sibling keeps inherited availability", async () => {
    const { handlers, runtime, events, applied } = await setup();
    const first = await handlers.GET(request(), context("one"));
    const firstBody = await first.json();
    const response = await handlers.PATCH(
      new Request("http://cc.test/mcp-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operations: [
            { type: "set-server-enabled", serverKey: "calc", enabled: false },
          ],
          expectedEffectiveConfigHash: firstBody.view.effectiveConfigHash,
        }),
      }),
      context("one"),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.view.servers[0]).toMatchObject({
      enabled: false,
      pending: true,
    });
    expect(body.view.target).toEqual(
      projectConversationTarget("example", "one"),
    );
    expect(body.view).not.toHaveProperty("sessionName");
    expect(applied.size).toBe(0);
    const reloaded = fixture.recreateStore();
    expect(
      (await reloaded.getProjectConversation(projectPath, "one"))?.mcpOverrides
        ?.servers.calc?.enabled,
    ).toBe(false);
    expect(
      (await reloaded.getProjectConversation(projectPath, "two"))?.mcpOverrides,
    ).toBeUndefined();
    expect(
      (await reloaded.getProjectConversation(projectPath, "two"))?.mcpRuntime,
    ).toBeUndefined();
    expect(await reloaded.getProjectMcpOverrides(projectPath)).toBeUndefined();
    await runtime.applyAtTurnStart({
      projectPath,
      target: projectConversationTarget("example", "one"),
      backend: "claude",
    });
    expect(applied.get("one")?.servers[0]).toMatchObject({
      id: "calc",
      enabled: false,
    });
    expect(applied.has("two")).toBe(false);
    const sibling = await (
      await handlers.GET(request(), context("two"))
    ).json();
    expect(sibling.view.servers[0]).toMatchObject({
      enabled: true,
      pending: false,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        level: "conversation",
        target: projectConversationTarget("example", "one"),
      }),
    );
  });

  it("reloads pending and failed application state into the addressed view and can reset an override", async () => {
    const { handlers, deps } = await setup();
    const target = projectConversationTarget("example", "one");
    await deps.mutationService.patchConversation({
      projectPath,
      target,
      operations: [
        { type: "set-server-enabled", serverKey: "calc", enabled: false },
      ],
    });
    expect(
      (await fixture.recreateStore().getProjectConversation(projectPath, "one"))
        ?.lastActivityAt,
    ).toBe("2026-01-01T00:00:00Z");
    await fixture.store.mutateConversation(
      projectPath,
      conversationTargetStoreSessionName(target),
      "one",
      "test.pending",
      (conversation) => {
        conversation.mcpRuntime = {
          pendingConfigHash: "pending",
          pendingServerKeys: ["calc"],
          lastApplyDisposition: "rejected",
          lastApplyError: "Cannot load server",
        };
      },
    );
    const reloaded = fixture.recreateStore();
    const reader = createConversationMcpConfigHandlers({
      ...deps,
      getProjectConversation: reloaded.getProjectConversation,
    });
    const body = await (await reader.GET(request(), context("one"))).json();
    expect(body.view.runtime).toMatchObject({
      lastApplyError: "Cannot load server",
      pendingConfigHash: "pending",
    });
    expect(body.view.pendingServerKeys).toEqual(["calc"]);
    const reset = await handlers.PATCH(
      new Request("http://cc.test/mcp-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operations: [{ type: "reset-server", serverKey: "calc" }],
        }),
      }),
      context("one"),
    );
    expect(reset.status).toBe(200);
    expect(
      (await fixture.recreateStore().getProjectConversation(projectPath, "one"))
        ?.mcpOverrides,
    ).toBeUndefined();
  });

  it("refreshes project-conversation tools through the same route operation and publishes its target", async () => {
    const { deps, events } = await setup();
    const inventory = {
      state: "ready" as const,
      tools: [{ name: "sum" }],
      diagnostics: [],
    };
    const handlers = createToolInventoryHandlers({
      ...deps,
      cache: {
        peek: () => inventory,
        refresh: async () => inventory,
        getOrFetch: async () => inventory,
        markStale: () => {},
        onCompletion: () => () => {},
      },
    });
    const response = await handlers.POST(request(), {
      params: Promise.resolve({
        name: "example",
        conversationId: "one",
        serverKey: "calc",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tools: [{ name: "sum" }] });
    expect(events).toEqual([
      {
        kind: "tools-updated",
        level: "conversation",
        target: projectConversationTarget("example", "one"),
        serverKey: "calc",
      },
    ]);
  });
});
