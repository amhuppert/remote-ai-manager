import { describe, expect, it, vi } from "vitest";

import type {
  AgentCapabilitiesDiscoveryUpdatedEvent,
  AgentCapabilitiesUpdatedEvent,
  AgentCapabilityCascadeKind,
  AgentCapabilityInventory,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

import {
  CapabilityRoutePersistenceError,
  createConversationCapabilityHandlers,
  createGlobalCapabilityHandlers,
  createProjectCapabilityHandlers,
  createSessionCapabilityHandlers,
  type CapabilityRouteDeps,
} from "./route-handlers";

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
});
