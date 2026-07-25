import { describe, it, expect } from "vitest";
import {
  createProjectConversationRouteHandlers,
  type ProjectConversationRouteDeps,
} from "./route-handlers";
import { BackendMismatchError } from "@/lib/prompt/sdk-driver";
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

  it("forwards the submission's creation-request token on the create-and-send path only", async () => {
    const forwarded: Array<string | undefined> = [];
    const h = harness({
      executeProjectPromptStream: async (input) => {
        forwarded.push(input.creationRequestId);
        return {
          conversationId: input.conversationId ?? "new-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    });

    await readStream(
      await h.handlers.firstPromptPOST(
        jsonRequest({ prompt: "hello main", creationRequestId: "req-42" }),
        ctx({ name: "demo" }),
      ),
    );

    // The per-conversation route creates nothing, so it has no creation to
    // stamp — the client that posts there already knows its conversation id.
    h.store.set("c1", makeConv({ id: "c1", promptCount: 1 }));
    await readStream(
      await h.handlers.promptPOST(
        jsonRequest({ prompt: "next", creationRequestId: "req-42" }),
        ctx({ name: "demo", conversationId: "c1" }),
      ),
    );

    expect(forwarded).toEqual(["req-42", undefined]);
  });

  it("firstPromptPOST decides every non-OK answer before running the prompt, so a rejection creates no conversation", async () => {
    // A rejected create-and-send must leave no empty project conversation
    // behind: the user sees an error and retries, and a retry that accumulated
    // orphan conversations would be visible in the cockpit's tabs.
    // `executeProjectPromptStream` is the only path that creates the
    // conversation (see `prompt-entry.ts`), so not reaching it is the proof.
    let executions = 0;
    const h = harness({
      executeProjectPromptStream: async (input) => {
        executions += 1;
        input.emit("status", { status: "running" });
        return {
          conversationId: input.conversationId ?? "new-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    });

    const unresolvableProject = await h.handlers.firstPromptPOST(
      jsonRequest({ prompt: "hello" }),
      ctx({ name: "nope" }),
    );
    const unusableBody = await h.handlers.firstPromptPOST(
      jsonRequest({ prompt: "   " }),
      ctx({ name: "demo" }),
    );

    expect(unresolvableProject.ok).toBe(false);
    expect(unusableBody.ok).toBe(false);
    expect(executions).toBe(0);

    // The counter is live: an accepted request does reach the executor, and it
    // answers OK — so non-OK and "created nothing" coincide.
    const accepted = await h.handlers.firstPromptPOST(
      jsonRequest({ prompt: "hello" }),
      ctx({ name: "demo" }),
    );
    expect(accepted.ok).toBe(true);
    await readStream(accepted);
    expect(executions).toBe(1);
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
