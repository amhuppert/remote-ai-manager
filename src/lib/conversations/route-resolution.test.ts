import { describe, it, expect } from "vitest";
import {
  resolveSessionRoute,
  resolveSessionConversationRoute,
  type SessionRouteDeps,
} from "./route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { withTracing } from "@/lib/logging";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";

function makeConversation(id: string): ConversationState {
  return { id } as unknown as ConversationState;
}

function makeSession(conversations: ConversationState[]): SessionState {
  return { name: "s1", conversations } as unknown as SessionState;
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

/**
 * Run `fn` the way a real request runs it: inside `withTracing`, which is what
 * puts the request path on the trace context. Faking the context by hand would
 * assert the refusal's arithmetic without proving the production wiring that
 * supplies its input.
 */
async function runTracedRequest<T>(
  pathname: string,
  fn: () => Promise<T>,
): Promise<T> {
  const captured: T[] = [];
  const handler = withTracing<undefined>(async () => {
    captured.push(await fn());
    return new Response(null, { status: 204 });
  });
  await handler(new Request(`http://127.0.0.1${pathname}`), undefined);
  const [value] = captured;
  if (value === undefined) throw new Error("traced handler never ran");
  return value;
}

function makeDeps(overrides: Partial<SessionRouteDeps> = {}): SessionRouteDeps {
  const session = makeSession([makeConversation("conv-1")]);
  return {
    resolveProjectPath: async () => "/repos/demo",
    getSession: async () => session,
    ...overrides,
  };
}

describe("resolveSessionRoute", () => {
  it("resolves project path and session, decoding the session slug", async () => {
    let askedFor: string | undefined;
    const session = makeSession([]);
    const deps = makeDeps({
      getSession: async (_path, sessionName) => {
        askedFor = sessionName;
        return session;
      },
    });

    const result = await resolveSessionRoute(
      deps,
      context({ name: "demo", session: "feature%2Fx" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projectPath).toBe("/repos/demo");
      expect(result.value.sessionName).toBe("feature/x");
      expect(result.value.session).toBe(session);
    }
    expect(askedFor).toBe("feature/x");
  });

  it("returns 404 when the project is unknown", async () => {
    const deps = makeDeps({ resolveProjectPath: async () => null });
    const result = await resolveSessionRoute(
      deps,
      context({ name: "missing", session: "s1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("returns 404 when the session is missing", async () => {
    const deps = makeDeps({ getSession: async () => null });
    const result = await resolveSessionRoute(
      deps,
      context({ name: "demo", session: "missing" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });
});

describe("resolveSessionRoute sentinel refusal", () => {
  it("refuses the internal project sentinel in the public session position", async () => {
    let lookedUpSession = false;
    const deps = makeDeps({
      getSession: async () => {
        lookedUpSession = true;
        return makeSession([]);
      },
    });

    const result = await resolveSessionRoute(
      deps,
      context({
        name: "demo",
        session: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: "conv-1",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A client error, not a misleading "Session not found".
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain("/api/projects/demo/conversations/conv-1");
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    // Refusal happens before any session lookup — nothing to find.
    expect(lookedUpSession).toBe(false);
  });

  it("refuses the sentinel even when it arrives percent-encoded", async () => {
    const result = await resolveSessionRoute(
      makeDeps(),
      context({
        name: "demo",
        session: encodeURIComponent(PROJECT_CONVERSATION_SESSION_SENTINEL),
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  /**
   * R1.2 names the route for THE ENDPOINT that was addressed. Pointing a
   * `/read` request at the conversation base names a route that does not
   * perform the requested operation, which is the misdirection the criterion
   * exists to prevent.
   */
  it("names the project route for the addressed endpoint, not the conversation base", async () => {
    for (const leaf of ["read", "prompt", "messages", "context-artifacts/a1"]) {
      const result = await runTracedRequest(
        `/api/projects/demo/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/conversations/conv-1/${leaf}`,
        () =>
          resolveSessionRoute(
            makeDeps(),
            context({
              name: "demo",
              session: PROJECT_CONVERSATION_SESSION_SENTINEL,
              conversationId: "conv-1",
            }),
          ),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toContain(
        `/api/projects/demo/conversations/conv-1/${leaf}`,
      );
      expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });

  it("says session-only rather than naming a project route that does not exist", async () => {
    const result = await runTracedRequest(
      `/api/projects/demo/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/conversations/conv-1/fork`,
      () =>
        resolveSessionRoute(
          makeDeps(),
          context({
            name: "demo",
            session: PROJECT_CONVERSATION_SESSION_SENTINEL,
            conversationId: "conv-1",
          }),
        ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    const body = (await result.response.json()) as { error: string };
    expect(body.error).toContain("fork");
    expect(body.error).toContain("session-only");
    expect(body.error).not.toContain(
      "/api/projects/demo/conversations/conv-1/fork",
    );
    expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
  });

  /**
   * A session-LEVEL request carries no conversation id, so the fallback has
   * nothing specific to offer and the derived mapping decides the message. These
   * operations have project-level counterparts, so refusing them as session-only
   * denies a route that is implemented.
   */
  it("names the project-level route for a session-level operation that has one", async () => {
    for (const operation of ["commands", "files", "diff"]) {
      const result = await runTracedRequest(
        `/api/projects/demo/sessions/${PROJECT_CONVERSATION_SESSION_SENTINEL}/${operation}`,
        () =>
          resolveSessionRoute(
            makeDeps(),
            context({
              name: "demo",
              session: PROJECT_CONVERSATION_SESSION_SENTINEL,
            }),
          ),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as { error: string };
      expect(body.error).toContain(`/api/projects/demo/${operation}`);
      expect(body.error).not.toContain("session-only");
      expect(body.error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });
});

describe("resolveSessionConversationRoute", () => {
  it("resolves the conversation found inside the session", async () => {
    const conversation = makeConversation("conv-1");
    const deps = makeDeps({
      getSession: async () => makeSession([conversation]),
    });

    const result = await resolveSessionConversationRoute(
      deps,
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.conversation).toBe(conversation);
      expect(result.value.conversationId).toBe("conv-1");
      expect(result.value.session).toBeDefined();
    }
  });

  it("returns 404 when the conversation is absent from the session", async () => {
    const deps = makeDeps({ getSession: async () => makeSession([]) });
    const result = await resolveSessionConversationRoute(
      deps,
      context({ name: "demo", session: "s1", conversationId: "ghost" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it("propagates an upstream project 404 without checking the conversation", async () => {
    let lookedUpSession = false;
    const deps = makeDeps({
      resolveProjectPath: async () => null,
      getSession: async () => {
        lookedUpSession = true;
        return makeSession([]);
      },
    });
    const result = await resolveSessionConversationRoute(
      deps,
      context({ name: "missing", session: "s1", conversationId: "conv-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
    expect(lookedUpSession).toBe(false);
  });
});
