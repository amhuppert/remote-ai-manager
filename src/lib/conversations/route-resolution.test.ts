import { describe, it, expect } from "vitest";
import {
  resolveSessionRoute,
  resolveSessionConversationRoute,
  type SessionRouteDeps,
} from "./route-resolution";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

function makeConversation(id: string): ConversationState {
  return { id } as unknown as ConversationState;
}

function makeSession(conversations: ConversationState[]): SessionState {
  return { name: "s1", conversations } as unknown as SessionState;
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
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
