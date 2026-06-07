import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilitiesDiscoveryUpdatedEvent,
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityCascadeKind,
  AgentCapabilityInventory,
  AgentCapabilityViewResponse,
} from "./schemas";

import {
  CapabilityRouteDiscoveryError,
  CapabilityRoutePersistenceError,
  createConversationCapabilityHandlers,
  createGlobalCapabilityHandlers,
  createProjectConversationCapabilityHandlers,
  createProjectCapabilityHandlers,
  createSessionCapabilityHandlers,
  type CapabilityRouteDeps,
} from "./route-handlers";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

function view(
  cascadeKind: AgentCapabilityCascadeKind,
  effectiveHash: string,
  level: AgentCapabilityViewResponse["level"] = "global",
): AgentCapabilityViewResponse {
  return {
    level,
    cascadeKind,
    backend: cascadeKind.startsWith("codex-") ? "codex" : "claude",
    items: [],
    diagnostics: [],
    effectiveHash,
  };
}

function inventory(
  cascadeKind: AgentCapabilityCascadeKind,
): AgentCapabilityInventory {
  return {
    cascadeKind,
    items: [],
    diagnostics: [],
    sourceSignature: `${cascadeKind}:sig`,
    refreshedAt: "2026-05-18T12:00:00.000Z",
  };
}

function request(url: string, body?: unknown): Request {
  if (body === undefined) return new Request(url);
  return new Request(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function jsonRequest(method: string, url: string, body: unknown): Request {
  return new Request(url, {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function baseDeps(
  overrides: Partial<CapabilityRouteDeps> = {},
): CapabilityRouteDeps & {
  events: Array<
    AgentCapabilitiesUpdatedEvent | AgentCapabilitiesDiscoveryUpdatedEvent
  >;
} {
  const events: Array<
    AgentCapabilitiesUpdatedEvent | AgentCapabilitiesDiscoveryUpdatedEvent
  > = [];
  return {
    async resolveView(input) {
      return view(input.cascadeKind, "hash-current", input.scope.level);
    },
    async mutate(input) {
      return {
        status: "applied",
        scope: input.scope,
        cascadeKind: input.request.cascadeKind,
        changedItemIds: ["skill:a"],
        effectiveHash: "hash-next",
        view: view(input.request.cascadeKind, "hash-next", input.scope.level),
        operationId: "cap-op-default",
      };
    },
    async refreshDiscovery(input) {
      return {
        inventory: inventory(input.cascadeKind),
        view: view(input.cascadeKind, "hash-refresh", input.scope.level),
      };
    },
    async resolveProjectPath(projectName) {
      return `/projects/${projectName}`;
    },
    broadcast(event) {
      events.push(event);
    },
    events,
    ...overrides,
  };
}

describe("agent capability route handlers", () => {
  it("serves a resolved global capability view for a requested cascade", async () => {
    const deps = baseDeps();
    const handlers = createGlobalCapabilityHandlers(deps);

    const response = await handlers.GET(
      request(
        "http://cc.test/api/config/agent-capabilities?cascadeKind=claude-skills",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: {
        level: "global",
        cascadeKind: "claude-skills",
        effectiveHash: "hash-current",
      },
    });
  });

  it("returns structured validation errors for malformed patch bodies", async () => {
    const mutate = vi.fn();
    const handlers = createGlobalCapabilityHandlers(
      baseDeps({ mutate: mutate as CapabilityRouteDeps["mutate"] }),
    );

    const response = await handlers.PATCH(
      jsonRequest("PATCH", "http://cc.test/api/config/agent-capabilities", {
        cascadeKind: "claude-skills",
        operations: [{ type: "set-item-enabled", itemId: "skill:a" }],
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("returns the latest view and invalidation scope on expected-hash conflicts", async () => {
    const deps = baseDeps({
      async mutate(input) {
        return {
          status: "conflict",
          scope: input.scope,
          cascadeKind: input.request.cascadeKind,
          expectedHash: "hash-stale",
          actualHash: "hash-current",
          latestView: view(input.request.cascadeKind, "hash-current"),
          operationId: "cap-op-conflict",
        };
      },
    });
    const handlers = createGlobalCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest("PATCH", "http://cc.test/api/config/agent-capabilities", {
        cascadeKind: "claude-skills",
        expectedHash: "hash-stale",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "conflict" },
      expectedHash: "hash-stale",
      actualHash: "hash-current",
      latestView: { effectiveHash: "hash-current" },
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        effectiveHash: "hash-current",
      },
    });
    expect(deps.events).toEqual([]);
  });

  it("keeps stale item writes all-or-nothing and broadcasts successful updates", async () => {
    const deps = baseDeps({
      async mutate(input) {
        return {
          status: "applied",
          scope: input.scope,
          cascadeKind: input.request.cascadeKind,
          changedItemIds: ["skill:a"],
          effectiveHash: "hash-next",
          view: view(input.request.cascadeKind, "hash-next", input.scope.level),
          operationId: "cap-op-route",
        };
      },
    });
    const handlers = createGlobalCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest("PATCH", "http://cc.test/api/config/agent-capabilities", {
        cascadeKind: "claude-skills",
        expectedHash: "hash-current",
        operations: [
          { type: "set-item-enabled", itemId: "missing-skill", enabled: false },
        ],
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: { effectiveHash: "hash-next" },
      changedItemIds: ["skill:a"],
      invalidationHints: {
        level: "global",
        cascadeKind: "claude-skills",
        effectiveHash: "hash-next",
        itemIds: ["skill:a"],
        operationId: "cap-op-route",
      },
      operationId: "cap-op-route",
    });
    expect(deps.events).toMatchObject([
      {
        type: "agent-capabilities-updated",
        level: "global",
        cascadeKind: "claude-skills",
        changedItemIds: ["skill:a"],
        effectiveHash: "hash-next",
        operationId: "cap-op-route",
        invalidationHints: {
          operationId: "cap-op-route",
        },
      },
    ]);
  });

  it("returns structured persistence errors without reporting success", async () => {
    const deps = baseDeps({
      async mutate() {
        throw new CapabilityRoutePersistenceError("write failed");
      },
    });
    const handlers = createGlobalCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest("PATCH", "http://cc.test/api/config/agent-capabilities", {
        cascadeKind: "claude-skills",
        operations: [
          { type: "set-item-enabled", itemId: "skill:a", enabled: false },
        ],
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "persistence_error" },
    });
    expect(deps.events).toEqual([]);
  });

  it("redacts sensitive native diagnostic text from view responses", async () => {
    const deps = baseDeps({
      async resolveView(input) {
        return {
          ...view(input.cascadeKind, "hash-current", input.scope.level),
          diagnostics: [
            {
              severity: "warning",
              code: "agent-capability-source-unreadable",
              message:
                'Failed reading enabledPlugins {"token":"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"} with OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
              cascadeKind: input.cascadeKind,
              backend: "claude",
            },
          ],
        };
      },
    });
    const handlers = createGlobalCapabilityHandlers(deps);

    const response = await handlers.GET(
      request(
        "http://cc.test/api/config/agent-capabilities?cascadeKind=claude-skills",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const message = body.view.diagnostics[0].message as string;
    expect(message).toContain("<redacted>");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN");
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("refreshes discovery for project scope and broadcasts refresh hints", async () => {
    const deps = baseDeps();
    const handlers = createProjectCapabilityHandlers(deps);

    const response = await handlers.POST(
      jsonRequest(
        "POST",
        "http://cc.test/api/projects/proj/agent-capabilities",
        { cascadeKind: "claude-skills" },
      ),
      { params: Promise.resolve({ name: "proj" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      inventory: {
        cascadeKind: "claude-skills",
        sourceSignature: "claude-skills:sig",
      },
      view: {
        level: "project",
        cascadeKind: "claude-skills",
        effectiveHash: "hash-refresh",
      },
      invalidationHints: {
        level: "project",
        projectName: "proj",
        cascadeKind: "claude-skills",
        refreshDiscovery: true,
        sourceSignature: "claude-skills:sig",
      },
    });
    expect(deps.events).toMatchObject([
      {
        type: "agent-capabilities-discovery-updated",
        level: "project",
        projectName: "proj",
        cascadeKind: "claude-skills",
        sourceSignature: "claude-skills:sig",
      },
    ]);
  });

  it("returns structured not-found errors for missing scoped resources", async () => {
    const deps = baseDeps({
      async resolveProjectPath() {
        return null;
      },
    });
    const handlers = createSessionCapabilityHandlers(deps);

    const response = await handlers.GET(
      request(
        "http://cc.test/api/projects/missing/sessions/s/agent-capabilities?cascadeKind=claude-skills",
      ),
      { params: Promise.resolve({ name: "missing", session: "s" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("maps scoped patch state-store not-found failures to structured not-found errors", async () => {
    const deps = baseDeps({
      async mutate() {
        throw new Error('Session "s" not found in project "/projects/proj"');
      },
    });
    const handlers = createSessionCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/sessions/s/agent-capabilities",
        {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: true },
          ],
        },
      ),
      { params: Promise.resolve({ name: "proj", session: "s" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(deps.events).toEqual([]);
  });

  it("preserves full conversation scope in mutation invalidation hints", async () => {
    const deps = baseDeps();
    const handlers = createConversationCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/sessions/s/conversations/c/agent-capabilities",
        {
          cascadeKind: "claude-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: true },
          ],
        },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          session: "s",
          conversationId: "c",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        sessionName: "s",
        conversationId: "c",
        cascadeKind: "claude-skills",
      },
    });
    expect(deps.events[0]).toMatchObject({
      level: "conversation",
      projectName: "proj",
      sessionName: "s",
      conversationId: "c",
    });
  });

  it("serves project-conversation capability views through the public project route shape", async () => {
    const resolveView = vi.fn(async (input) => {
      return {
        ...view(input.cascadeKind, "hash-plc", input.scope.level),
        projectName: "proj",
        conversationScope: "project" as const,
        conversationId: "plc-1",
      };
    });
    const deps = baseDeps({
      resolveView: resolveView as CapabilityRouteDeps["resolveView"],
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.GET(
      request(
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities?cascadeKind=codex-skills",
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      view: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
        cascadeKind: "codex-skills",
        effectiveHash: "hash-plc",
      },
    });
    expect(resolveView).toHaveBeenCalledWith({
      scope: {
        level: "conversation",
        projectName: "proj",
        projectPath: "/projects/proj",
        conversationScope: "project",
        conversationId: "plc-1",
      },
      cascadeKind: "codex-skills",
    });
  });

  it("returns structured validation errors for malformed project-conversation patch bodies", async () => {
    const mutate = vi.fn();
    const handlers = createProjectConversationCapabilityHandlers(
      baseDeps({ mutate: mutate as CapabilityRouteDeps["mutate"] }),
    );

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "codex-skills",
          operations: [{ type: "set-item-enabled", itemId: "skill:a" }],
        },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "validation_error" },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("returns project-conversation conflict errors with direct invalidation identity", async () => {
    const deps = baseDeps({
      async mutate(input) {
        return {
          status: "conflict",
          scope: input.scope,
          cascadeKind: input.request.cascadeKind,
          expectedHash: "hash-stale",
          actualHash: "hash-current",
          latestView: {
            ...view(input.request.cascadeKind, "hash-current", "conversation"),
            projectName: "proj",
            conversationScope: "project",
            conversationId: "plc-1",
          },
          operationId: "cap-op-plc-conflict",
        };
      },
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "codex-skills",
          expectedHash: "hash-stale",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
        },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: "conflict" },
      expectedHash: "hash-stale",
      actualHash: "hash-current",
      latestView: {
        level: "conversation",
        conversationScope: "project",
        conversationId: "plc-1",
        effectiveHash: "hash-current",
      },
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
        cascadeKind: "codex-skills",
        effectiveHash: "hash-current",
        operationId: "cap-op-plc-conflict",
      },
      operationId: "cap-op-plc-conflict",
    });
    expect(body.invalidationHints).not.toHaveProperty("sessionName");
    expect(body.latestView).not.toHaveProperty("sessionName");
    expect(deps.events).toEqual([]);
  });

  it("broadcasts project-conversation update events without a sentinel session name", async () => {
    const deps = baseDeps({
      async mutate(input) {
        return {
          status: "applied",
          scope: input.scope,
          cascadeKind: input.request.cascadeKind,
          changedItemIds: ["skill:a"],
          effectiveHash: "hash-plc-next",
          view: {
            ...view(
              input.request.cascadeKind,
              "hash-plc-next",
              input.scope.level,
            ),
            projectName: "proj",
            conversationScope: "project",
            conversationId: "plc-1",
          },
          operationId: "cap-op-plc-update",
        };
      },
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "codex-skills",
          expectedHash: "hash-plc",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
        },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      view: {
        level: "conversation",
        conversationScope: "project",
        conversationId: "plc-1",
        effectiveHash: "hash-plc-next",
      },
      changedItemIds: ["skill:a"],
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
        cascadeKind: "codex-skills",
        itemIds: ["skill:a"],
        effectiveHash: "hash-plc-next",
        operationId: "cap-op-plc-update",
      },
      operationId: "cap-op-plc-update",
    });
    expect(body.invalidationHints).not.toHaveProperty("sessionName");
    expect(deps.events).toHaveLength(1);
    const [event] = deps.events;
    if (!event) throw new Error("Expected project-conversation update event");
    expect(event).toMatchObject({
      type: "agent-capabilities-updated",
      level: "conversation",
      projectName: "proj",
      conversationScope: "project",
      conversationId: "plc-1",
      cascadeKind: "codex-skills",
      changedItemIds: ["skill:a"],
      effectiveHash: "hash-plc-next",
      operationId: "cap-op-plc-update",
      invalidationHints: {
        conversationScope: "project",
        conversationId: "plc-1",
      },
    });
    expect(event).not.toHaveProperty("sessionName");
    expect(event.invalidationHints).not.toHaveProperty("sessionName");
  });

  it("refreshes project-conversation discovery and broadcasts direct invalidation hints", async () => {
    const deps = baseDeps();
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.POST(
      jsonRequest(
        "POST",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities/refresh",
        { cascadeKind: "codex-skills" },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      inventory: {
        cascadeKind: "codex-skills",
        sourceSignature: "codex-skills:sig",
      },
      view: {
        level: "conversation",
        cascadeKind: "codex-skills",
        effectiveHash: "hash-refresh",
      },
      invalidationHints: {
        level: "conversation",
        projectName: "proj",
        conversationScope: "project",
        conversationId: "plc-1",
        cascadeKind: "codex-skills",
        refreshDiscovery: true,
        sourceSignature: "codex-skills:sig",
      },
    });
    expect(body.invalidationHints).not.toHaveProperty("sessionName");
    expect(deps.events).toHaveLength(1);
    const [event] = deps.events;
    if (!event)
      throw new Error("Expected project-conversation discovery event");
    expect(event).toMatchObject({
      type: "agent-capabilities-discovery-updated",
      level: "conversation",
      projectName: "proj",
      conversationScope: "project",
      conversationId: "plc-1",
      cascadeKind: "codex-skills",
      sourceSignature: "codex-skills:sig",
      invalidationHints: {
        conversationScope: "project",
        conversationId: "plc-1",
      },
    });
    expect(event).not.toHaveProperty("sessionName");
    expect(event.invalidationHints).not.toHaveProperty("sessionName");
  });

  it("returns structured project-conversation persistence errors without broadcasting", async () => {
    const deps = baseDeps({
      async mutate() {
        throw new CapabilityRoutePersistenceError(
          "project conversation write failed",
        );
      },
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.PATCH(
      jsonRequest(
        "PATCH",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities",
        {
          cascadeKind: "codex-skills",
          operations: [
            { type: "set-item-enabled", itemId: "skill:a", enabled: false },
          ],
        },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "persistence_error" },
    });
    expect(deps.events).toEqual([]);
  });

  it("returns structured project-conversation discovery errors without broadcasting", async () => {
    const deps = baseDeps({
      async refreshDiscovery() {
        throw new CapabilityRouteDiscoveryError(
          "project conversation discovery failed",
        );
      },
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.POST(
      jsonRequest(
        "POST",
        "http://cc.test/api/projects/proj/conversations/plc-1/agent-capabilities/refresh",
        { cascadeKind: "codex-skills" },
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-1",
        }),
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "discovery_error" },
    });
    expect(deps.events).toEqual([]);
  });

  it("returns structured not-found errors for unknown project conversations", async () => {
    const deps = baseDeps({
      async resolveView() {
        throw new Error(
          'Conversation "plc-missing" not found in project "/projects/proj"',
        );
      },
    });
    const handlers = createProjectConversationCapabilityHandlers(deps);

    const response = await handlers.GET(
      request(
        "http://cc.test/api/projects/proj/conversations/plc-missing/agent-capabilities?cascadeKind=codex-skills",
      ),
      {
        params: Promise.resolve({
          name: "proj",
          conversationId: "plc-missing",
        }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(deps.events).toEqual([]);
  });

  it("rejects the project-conversation sentinel as a public session capability route", async () => {
    const resolveView = vi.fn();
    const handlers = createSessionCapabilityHandlers(
      baseDeps({
        resolveView: resolveView as CapabilityRouteDeps["resolveView"],
      }),
    );

    const response = await handlers.GET(
      request(
        `http://cc.test/api/projects/proj/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/agent-capabilities?cascadeKind=codex-skills`,
      ),
      {
        params: Promise.resolve({
          name: "proj",
          session: PROJECT_CONVERSATION_SESSION_SENTINEL,
        }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
    expect(resolveView).not.toHaveBeenCalled();
  });

  it("exports public project-conversation Next route handlers", async () => {
    const route =
      await import("@/app/api/projects/[name]/conversations/[conversationId]/agent-capabilities/route");
    const refreshRoute =
      await import("@/app/api/projects/[name]/conversations/[conversationId]/agent-capabilities/refresh/route");

    expect(route.dynamic).toBe("force-dynamic");
    expect(route.GET).toBeTypeOf("function");
    expect(route.PATCH).toBeTypeOf("function");
    expect(route.POST).toBeTypeOf("function");
    expect(refreshRoute.dynamic).toBe("force-dynamic");
    expect(refreshRoute.POST).toBeTypeOf("function");
  });
});
