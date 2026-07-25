import { describe, it, expect } from "vitest";
import {
  createProjectConversationRouteHandlers,
  type ProjectConversationRouteDeps,
} from "./route-handlers";
import { BackendMismatchError } from "@/lib/prompt/sdk-driver";
import { ProjectCollaborationUnsupportedError } from "./prompt-entry";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";

function makeConv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return {
    id: overrides.id,
    scope: "project",
    name: overrides.name ?? "Repo chat",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
  };
}

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getRequest(): Request {
  return new Request("http://test/", { method: "GET" });
}

function harness(overrides?: Partial<ProjectConversationRouteDeps>) {
  const broadcasts: SSEEvent[] = [];
  const store = new Map<string, ConversationState>();
  const deps: ProjectConversationRouteDeps = {
    resolveProjectPath: async (name) => (name === "demo" ? "/repo" : null),
    getProjectDisplayName: () => "demo",
    createProjectConversation: async (_p, opts) => {
      const conv = makeConv({
        id: "new-1",
        ...(opts?.name ? { name: opts.name } : {}),
        ...(opts?.agentBackend ? { agentBackend: opts.agentBackend } : {}),
      });
      store.set(conv.id, conv);
      return conv;
    },
    getProjectConversation: async (_p, id) => store.get(id) ?? null,
    listProjectConversations: async () => [...store.values()],
    readConversationMessagesWithSeq: async () => [],
    renameProjectConversation: async (_p, id, name) => {
      const c = store.get(id);
      if (c) c.name = name;
    },
    setProjectConversationArchived: async (_p, id, archived) => {
      const c = store.get(id);
      if (c) c.archived = archived;
    },
    setProjectConversationOpen: async (_p, id, open) => {
      const c = store.get(id);
      if (c) c.open = open;
    },
    markProjectConversationRead: async (_p, id) => {
      const c = store.get(id);
      if (c) c.unread = false;
    },
    executeProjectPromptStream: async (input) => {
      input.emit("status", { status: "running" });
      return {
        conversationId: input.conversationId ?? "new-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    },
    isConversationBusy: () => false,
    broadcast: (e) => {
      broadcasts.push(e);
      return { delivered: true };
    },
    ...overrides,
  };
  return {
    handlers: createProjectConversationRouteHandlers(deps),
    broadcasts,
    store,
  };
}

async function readStream(res: Response): Promise<string> {
  return await new Response(res.body).text();
}

describe("project conversation route handlers", () => {
  it("createPOST returns 201 with the record and broadcasts scope=project conversation-created", async () => {
    const h = harness();
    const res = await h.handlers.createPOST(
      jsonRequest({ name: "Refactor" }),
      ctx({ name: "demo" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as ConversationState;
    expect(body.scope).toBe("project");
    expect(body.name).toBe("Refactor");
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0]?.type).toBe("conversation-created");
    expect((h.broadcasts[0] as { scope?: string }).scope).toBe("project");
  });

  it("createPOST returns 404 for an unknown project", async () => {
    const h = harness();
    const res = await h.handlers.createPOST(
      jsonRequest({}),
      ctx({ name: "ghost" }),
    );
    expect(res.status).toBe(404);
  });

  it("listGET returns the project's conversations and 404 for an unknown project", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1", name: "Alpha" }));
    h.store.set("c2", makeConv({ id: "c2", name: "Beta" }));
    const res = await h.handlers.listGET(getRequest(), ctx({ name: "demo" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationState[];
    expect(body.map((c) => c.id).sort()).toEqual(["c1", "c2"]);

    const ghost = await h.handlers.listGET(
      getRequest(),
      ctx({ name: "ghost" }),
    );
    expect(ghost.status).toBe(404);
  });

  it("messagesGET returns seq-sorted transcript messages for the conversation", async () => {
    const h = harness({
      readConversationMessagesWithSeq: async () => [
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          timestamp: null,
          seq: 1,
        },
        {
          role: "user",
          content: [{ type: "text", text: "first" }],
          timestamp: null,
          seq: 0,
        },
      ],
    });
    h.store.set("c1", makeConv({ id: "c1" }));
    const res = await h.handlers.messagesGET(
      getRequest(),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ seq: number }>;
    expect(body.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("messagesGET returns 404 for an unknown conversation", async () => {
    const h = harness();
    const res = await h.handlers.messagesGET(
      getRequest(),
      ctx({ name: "demo", conversationId: "missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("firstPromptPOST streams text/event-stream and emits status events during the turn", async () => {
    const h = harness();
    const res = await h.handlers.firstPromptPOST(
      jsonRequest({ prompt: "hello main" }),
      ctx({ name: "demo" }),
    );
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await readStream(res);
    expect(text).toContain("event: status");
    expect(text).toContain('"status":"running"');
  });

  it("promptPOST maps a backend mismatch to the SSE BACKEND_MISMATCH frame", async () => {
    const h = harness({
      executeProjectPromptStream: async () => {
        throw new BackendMismatchError("claude", "codex");
      },
    });
    h.store.set("c1", makeConv({ id: "c1", promptCount: 1 }));
    const res = await h.handlers.promptPOST(
      jsonRequest({ prompt: "switch", backend: "codex" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    const text = await readStream(res);
    expect(text).toContain('"code":"BACKEND_MISMATCH"');
  });

  // The boundary's `/collab` refusal has to reach the client as an explicit,
  // coded error. Before the refusal existed the turn was delegated and failed
  // deep in the collaboration manager, so the SSE frame carried the raw
  // `Session "__project__" not found` message (R1.2, R1.3).
  it("promptPOST maps a project /collab refusal to a coded SSE frame", async () => {
    const h = harness({
      executeProjectPromptStream: async () => {
        throw new ProjectCollaborationUnsupportedError();
      },
    });
    h.store.set("c1", makeConv({ id: "c1", promptCount: 1 }));
    const res = await h.handlers.promptPOST(
      jsonRequest({ prompt: "/collab redesign the sidebar" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    const text = await readStream(res);
    expect(text).toContain('"code":"PROJECT_COLLABORATION_UNSUPPORTED"');
    expect(text).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(text).toContain("event: done");
  });

  it("promptPOST returns 404 for an unknown conversation", async () => {
    const h = harness();
    const res = await h.handlers.promptPOST(
      jsonRequest({ prompt: "x" }),
      ctx({ name: "demo", conversationId: "missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("promptPOST returns 409 when the conversation is busy", async () => {
    const h = harness({ isConversationBusy: () => true });
    h.store.set("c1", makeConv({ id: "c1" }));
    const res = await h.handlers.promptPOST(
      jsonRequest({ prompt: "x" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    expect(res.status).toBe(409);
  });

  it("renamePATCH returns {ok:true} and broadcasts scope=project conversation-renamed", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1" }));
    const res = await h.handlers.renamePATCH(
      jsonRequest({ name: "Renamed" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(h.broadcasts[0]?.type).toBe("conversation-renamed");
    expect((h.broadcasts[0] as { scope?: string }).scope).toBe("project");
  });

  it("archivePATCH broadcasts scope=project conversation-archived", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1" }));
    const res = await h.handlers.archivePATCH(
      jsonRequest({ archived: true }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(h.broadcasts[0]?.type).toBe("conversation-archived");
    expect((h.broadcasts[0] as { archived?: boolean }).archived).toBe(true);
  });

  it("openPATCH broadcasts the project-only conversation-open event", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1" }));
    const res = await h.handlers.openPATCH(
      jsonRequest({ open: false }),
      ctx({ name: "demo", conversationId: "c1" }),
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(h.broadcasts[0]?.type).toBe("conversation-open");
    expect((h.broadcasts[0] as { open?: boolean; scope?: string }).open).toBe(
      false,
    );
    expect((h.broadcasts[0] as { scope?: string }).scope).toBe("project");
  });

  it("markReadPOST clears unread and broadcasts a scope=project conversation-unread event", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1", unread: true }));

    const res = await h.handlers.markReadPOST(
      new Request("http://test/", { method: "POST" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );

    expect(await res.json()).toEqual({ ok: true });
    expect(h.store.get("c1")?.unread).toBe(false);
    expect(h.broadcasts[0]?.type).toBe("conversation-unread");
    expect((h.broadcasts[0] as { unread?: boolean }).unread).toBe(false);
    expect((h.broadcasts[0] as { scope?: string }).scope).toBe("project");
  });

  it("markReadPOST returns 404 for an unknown project or conversation", async () => {
    const h = harness();
    const unknownProject = await h.handlers.markReadPOST(
      new Request("http://test/", { method: "POST" }),
      ctx({ name: "ghost", conversationId: "c1" }),
    );
    expect(unknownProject.status).toBe(404);

    const unknownConvo = await h.handlers.markReadPOST(
      new Request("http://test/", { method: "POST" }),
      ctx({ name: "demo", conversationId: "missing" }),
    );
    expect(unknownConvo.status).toBe(404);
  });
});
