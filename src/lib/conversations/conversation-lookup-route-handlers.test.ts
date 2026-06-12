import { describe, it, expect } from "vitest";
import { createConversationLookupRouteHandlers } from "./conversation-lookup-route-handlers";
import type { ConversationListItem } from "./schemas";

function makeItem(id: string, archived = false): ConversationListItem {
  return {
    projectName: "proj",
    projectPath: "/projects/proj",
    sessionName: "main",
    worktreePath: "/projects/proj/.worktrees/main",
    conversationId: id,
    conversationName: id,
    summary: null,
    firstPromptSnippet: null,
    backend: "claude",
    backendRef: null,
    transcriptPath: null,
    debugLogPath: null,
    status: "new",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived,
  };
}

function makeContext(conversationId: string) {
  return { params: Promise.resolve({ conversationId }) };
}

describe("createConversationLookupRouteHandlers GET", () => {
  it("returns 200 with the found conversation list item", async () => {
    const calls: string[] = [];
    const { GET } = createConversationLookupRouteHandlers({
      findConversationById: async (id) => {
        calls.push(id);
        return makeItem("abc123");
      },
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/abc123"),
      makeContext("abc123"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationListItem;
    expect(body.conversationId).toBe("abc123");
    expect(body.projectName).toBe("proj");
    expect(body.sessionName).toBe("main");
    expect(calls).toEqual(["abc123"]);
  });

  it("returns an archived conversation (archived deep links must resolve)", async () => {
    const { GET } = createConversationLookupRouteHandlers({
      findConversationById: async () => makeItem("old", true),
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/old"),
      makeContext("old"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationListItem;
    expect(body.archived).toBe(true);
  });

  it("returns 404 with the conversation_not_found body when no match exists", async () => {
    const { GET } = createConversationLookupRouteHandlers({
      findConversationById: async () => null,
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/missing"),
      makeContext("missing"),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "conversation_not_found" });
  });

  it("returns 404 when the conversationId param is empty", async () => {
    let called = false;
    const { GET } = createConversationLookupRouteHandlers({
      findConversationById: async () => {
        called = true;
        return null;
      },
    });

    const res = await GET(new Request("http://localhost/api/conversations/"), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });

  it("returns 500 with an error body when the finder rejects", async () => {
    const { GET } = createConversationLookupRouteHandlers({
      findConversationById: async () => {
        throw new Error("state-store kaboom");
      },
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/abc123"),
      makeContext("abc123"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state-store kaboom/);
  });
});
