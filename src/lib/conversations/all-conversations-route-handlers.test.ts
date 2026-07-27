import { describe, it, expect } from "vitest";
import { createAllConversationsRouteHandlers } from "./all-conversations-route-handlers";
import type { ConversationListItem } from "./schemas";

function makeItem(id: string): ConversationListItem {
  return {
    projectName: "proj",
    projectPath: "/projects/proj",
    scope: "session" as const,
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
    archived: false,
  };
}

describe("createAllConversationsRouteHandlers GET", () => {
  it("returns items and totalCount as JSON", async () => {
    const calls: Array<{ includeArchived: boolean }> = [];
    const { GET } = createAllConversationsRouteHandlers({
      listAllConversations: async (opts) => {
        calls.push(opts);
        return {
          items: [makeItem("a"), makeItem("b")],
          totalCount: 2,
        };
      },
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/all"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: ConversationListItem[];
      totalCount: number;
    };
    expect(body.totalCount).toBe(2);
    expect(body.items.map((i) => i.conversationId)).toEqual(["a", "b"]);
    expect(calls).toEqual([{ includeArchived: false }]);
  });

  it("parses includeArchived=true from the URL search params", async () => {
    const calls: Array<{ includeArchived: boolean }> = [];
    const { GET } = createAllConversationsRouteHandlers({
      listAllConversations: async (opts) => {
        calls.push(opts);
        return { items: [], totalCount: 0 };
      },
    });

    const res = await GET(
      new Request(
        "http://localhost/api/conversations/all?includeArchived=true",
      ),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ includeArchived: true }]);
  });

  it("defaults includeArchived to false when query param is missing or empty", async () => {
    const calls: Array<{ includeArchived: boolean }> = [];
    const { GET } = createAllConversationsRouteHandlers({
      listAllConversations: async (opts) => {
        calls.push(opts);
        return { items: [], totalCount: 0 };
      },
    });

    await GET(new Request("http://localhost/api/conversations/all"));
    await GET(
      new Request("http://localhost/api/conversations/all?includeArchived="),
    );
    await GET(
      new Request(
        "http://localhost/api/conversations/all?includeArchived=false",
      ),
    );
    expect(calls).toEqual([
      { includeArchived: false },
      { includeArchived: false },
      { includeArchived: false },
    ]);
  });

  it("returns 500 with an error body when listAllConversations rejects", async () => {
    const { GET } = createAllConversationsRouteHandlers({
      listAllConversations: async () => {
        throw new Error("state-store kaboom");
      },
    });

    const res = await GET(
      new Request("http://localhost/api/conversations/all"),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/state-store kaboom/);
  });
});
