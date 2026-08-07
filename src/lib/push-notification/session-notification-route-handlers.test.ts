import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { withTracing } from "@/lib/logging";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { projectConversationTarget } from "@/lib/conversations/conversation-target";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { AgentNotificationOutcome } from "./dispatcher";
import {
  createSessionNotificationHandlers,
  type SessionNotificationRouteDeps,
} from "./session-notification-route-handlers";

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(
    "http://127.0.0.1/api/projects/cc/sessions/sess/notifications",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

const params = Promise.resolve({ name: "cc", session: "sess" });

function authAllows(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "valid" };
    },
  };
}

function authDenies(): AgentAuth {
  return {
    async requireToken() {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

function projectConversation(): ConversationState {
  return makeConversationState({
    id: "conv-1",
    scope: "project",
    status: "running",
    promptCount: 1,
  });
}

function makeDeps(overrides: Partial<SessionNotificationRouteDeps> = {}): {
  deps: SessionNotificationRouteDeps;
  dispatch: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn(
    async (): Promise<AgentNotificationOutcome> => ({ delivered: true }),
  );
  const deps: SessionNotificationRouteDeps = {
    auth: authAllows(),
    async resolveProjectPath() {
      return "/repos/cc";
    },
    async getSession() {
      return { sessionName: "sess" };
    },
    async getProjectConversation() {
      return projectConversation();
    },
    dispatchAgentNotification: dispatch,
    ...overrides,
  };
  return { deps, dispatch };
}

describe("POST session notifications", () => {
  it("dispatches an agent push and returns 200 on success", async () => {
    const { deps, dispatch } = makeDeps();
    const { POST } = createSessionNotificationHandlers(deps);

    const res = await POST(
      makeRequest({ title: "Done", message: "Build finished" }),
      { params },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith({
      target: { scope: "session", projectName: "cc", sessionName: "sess" },
      title: "Done",
      message: "Build finished",
    });
  });

  it("defaults the title when none is provided", async () => {
    const { deps, dispatch } = makeDeps();
    const { POST } = createSessionNotificationHandlers(deps);

    await POST(makeRequest({ message: "no title" }), { params });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.any(String),
        message: "no title",
      }),
    );
    const call = dispatch.mock.calls[0]?.[0] as { title: string };
    expect(call.title.length).toBeGreaterThan(0);
  });

  it("returns a clean 409 (not a 500) when push is unconfigured", async () => {
    const { deps } = makeDeps({
      dispatchAgentNotification: vi.fn(async () => ({
        delivered: false as const,
        reason: "Push notifications are not configured",
      })),
    });
    const { POST } = createSessionNotificationHandlers(deps);

    const res = await POST(makeRequest({ message: "hi" }), { params });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Push notifications are not configured",
    });
  });

  it("rejects a missing/invalid token with 401 and never dispatches", async () => {
    const { deps, dispatch } = makeDeps({ auth: authDenies() });
    const { POST } = createSessionNotificationHandlers(deps);

    const res = await POST(makeRequest({ message: "hi" }), { params });

    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty message", async () => {
    const { deps, dispatch } = makeDeps();
    const { POST } = createSessionNotificationHandlers(deps);

    const res = await POST(makeRequest({ message: "" }), { params });

    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 404 when the session does not exist", async () => {
    const { deps } = makeDeps({
      async getSession() {
        return null;
      },
    });
    const { POST } = createSessionNotificationHandlers(deps);

    const res = await POST(makeRequest({ message: "hi" }), { params });

    expect(res.status).toBe(404);
  });

  it("refuses the internal project sentinel in the public session position", async () => {
    const { deps, dispatch } = makeDeps();
    const lookedUpSession = vi.fn(deps.getSession);
    const { POST } = createSessionNotificationHandlers({
      ...deps,
      getSession: lookedUpSession,
    });

    const res = await POST(makeRequest({ message: "hi" }), {
      params: Promise.resolve({
        name: "cc",
        session: PROJECT_CONVERSATION_SESSION_SENTINEL,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/api/projects/cc/conversations/");
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(lookedUpSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  /**
   * The refusal above exercises the factory directly, where no request path is
   * on the trace context and the caller's fallback supplies the route. In
   * production the handler runs inside `withTracing`, the path IS available, and
   * the derived mapping wins — so this is the only place the message a real
   * client receives is observable. `notifications` is a session-LEVEL path whose
   * project counterpart is conversation-scoped; calling it session-only would
   * deny a route that exists.
   */
  it("names the conversation-scoped project route when it runs inside the tracing wrapper", async () => {
    const { deps } = makeDeps();
    const { POST } = createSessionNotificationHandlers(deps);
    const traced = withTracing(POST);

    const res = await traced(
      new Request(
        `http://cc.local/api/projects/cc/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/notifications`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "hi" }),
        },
      ),
      {
        params: Promise.resolve({
          name: "cc",
          session: PROJECT_CONVERSATION_SESSION_SENTINEL,
        }),
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(
      "/api/projects/cc/conversations/<conversationId>/notifications",
    );
    expect(body.error).not.toContain("session-only");
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });
});

describe("POST project-conversation notifications", () => {
  const projectParams = Promise.resolve({
    name: "cc",
    conversationId: "conv-1",
  });

  function makeProjectRequest(body: unknown): Request {
    return new Request(
      "http://127.0.0.1/api/projects/cc/conversations/conv-1/notifications",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  }

  it("reaches the shared dispatch with a project target and no session record", async () => {
    const { deps, dispatch } = makeDeps({
      async getSession() {
        throw new Error("a project conversation must not require a session");
      },
    });
    const { PROJECT_POST } = createSessionNotificationHandlers(deps);

    const res = await PROJECT_POST(
      makeProjectRequest({ title: "Done", message: "Build finished" }),
      { params: projectParams },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith({
      target: projectConversationTarget("cc", "conv-1"),
      title: "Done",
      message: "Build finished",
    });
  });

  it("404s when the addressed project conversation does not exist", async () => {
    const { deps, dispatch } = makeDeps({
      async getProjectConversation() {
        return null;
      },
    });
    const { PROJECT_POST } = createSessionNotificationHandlers(deps);

    const res = await PROJECT_POST(makeProjectRequest({ message: "hi" }), {
      params: projectParams,
    });

    expect(res.status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rejects a missing/invalid token with 401 and never dispatches", async () => {
    const { deps, dispatch } = makeDeps({ auth: authDenies() });
    const { PROJECT_POST } = createSessionNotificationHandlers(deps);

    const res = await PROJECT_POST(makeProjectRequest({ message: "hi" }), {
      params: projectParams,
    });

    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a clean 409 when push is unconfigured", async () => {
    const { deps } = makeDeps({
      dispatchAgentNotification: vi.fn(async () => ({
        delivered: false as const,
        reason: "Push notifications are not configured",
      })),
    });
    const { PROJECT_POST } = createSessionNotificationHandlers(deps);

    const res = await PROJECT_POST(makeProjectRequest({ message: "hi" }), {
      params: projectParams,
    });

    expect(res.status).toBe(409);
  });
});
