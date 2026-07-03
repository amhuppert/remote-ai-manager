import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AgentAuth } from "@/lib/agent-gateway/token";
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
  };
}

function authDenies(): AgentAuth {
  return {
    async requireToken() {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    },
  };
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
      projectName: "cc",
      sessionName: "sess",
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
});
