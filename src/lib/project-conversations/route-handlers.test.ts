import { describe, it, expect, vi } from "vitest";
import {
  createProjectConversationRouteHandlers,
  type ProjectConversationRouteDeps,
} from "./route-handlers";
import {
  BackendMismatchError,
  ModelSelectionValidationError,
} from "@/lib/prompt/sdk-driver";
import { ProjectCollaborationUnsupportedError } from "./prompt-entry";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

function makeConv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  // Deliberately honors only `id` and `name` from overrides, exactly like the
  // hand-written helper it replaced (no blanket spread).
  return makeConversationState({
    id: overrides.id,
    scope: "project",
    name: overrides.name ?? "Repo chat",
    transcriptPath: "/tmp/project-conv.jsonl",
    status: "new",
    promptCount: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    open: true,
  });
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
    resolveConversationNamingContent: vi.fn(
      async () => "Whole project conversation basis",
    ),
    resolveMessageNamingContent: vi.fn(async () => "Project message basis"),
    generateAndApplyConversationName: vi.fn(
      async () => "Generated Project Name",
    ),
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
    changeConversationProfile: async () => {
      throw new Error("not used");
    },
    broadcast: (e) => {
      broadcasts.push(e);
      return { delivered: true };
    },
    ...overrides,
  };
  return {
    handlers: createProjectConversationRouteHandlers(deps),
    deps,
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

  it("createPOST forwards a profile selection and omits it when absent", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const h = harness({
      createProjectConversation: async (_p, opts) => {
        seen.push(opts as Record<string, unknown> | undefined);
        return makeConv({ id: "new-1" });
      },
    });

    await h.handlers.createPOST(
      jsonRequest({ profile: "builtin:general-implementer" }),
      ctx({ name: "demo" }),
    );
    await h.handlers.createPOST(jsonRequest({}), ctx({ name: "demo" }));

    // Normalized at the boundary; absent when the client sends none, so the
    // resolver's Standard Agent default applies (R7).
    expect(seen[0]?.profile).toEqual({
      tier: "builtin",
      id: "general-implementer",
    });
    expect(seen[1]?.profile).toBeUndefined();
  });

  it("firstPromptPOST forwards a profile selection to the creating entry", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const h = harness({
      executeProjectPromptStream: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        input.emit("done", {});
        return {
          conversationId: "new-1",
          contextTokens: null,
          contextWindowMax: null,
          compacted: false,
        };
      },
    });

    const res = await h.handlers.firstPromptPOST(
      jsonRequest({ prompt: "hi", profile: "builtin:general-reviewer" }),
      ctx({ name: "demo" }),
    );
    await readStream(res);

    expect(seen[0]?.profile).toEqual({
      tier: "builtin",
      id: "general-reviewer",
    });
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

  it("forwards complete model selections through both project prompt routes", async () => {
    const forwarded: Array<unknown> = [];
    const h = harness({
      executeProjectPromptStream: async (input) => {
        forwarded.push(input.modelSelection);
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
        jsonRequest({
          prompt: "first",
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "true", reasoning: "high" },
          },
        }),
        ctx({ name: "demo" }),
      ),
    );

    h.store.set(
      "c1",
      makeConv({ id: "c1", promptCount: 1, agentBackend: "codex" }),
    );
    await readStream(
      await h.handlers.promptPOST(
        jsonRequest({
          prompt: "next",
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.5",
            parameters: { fast: "false", reasoning: "xhigh" },
          },
        }),
        ctx({ name: "demo", conversationId: "c1" }),
      ),
    );

    expect(forwarded).toEqual([
      {
        modelId: "gpt-5.4",
        parameters: { fast: "true", reasoning: "high" },
      },
      {
        modelId: "gpt-5.5",
        parameters: { fast: "false", reasoning: "xhigh" },
      },
    ]);
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

  it("promptPOST preserves stable model-selection diagnostics in the SSE frame", async () => {
    const h = harness({
      executeProjectPromptStream: async () => {
        throw new ModelSelectionValidationError({
          code: "unsupported_combination",
          message: "The requested parameter combination is unsupported.",
          modelId: "claude-opus-5",
          parameterId: "thinking",
        });
      },
    });
    h.store.set("c1", makeConv({ id: "c1", promptCount: 1 }));

    const res = await h.handlers.promptPOST(
      jsonRequest({ prompt: "think" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );

    const text = await readStream(res);
    expect(text).toContain('"code":"unsupported_combination"');
    expect(text).toContain('"modelId":"claude-opus-5"');
    expect(text).toContain('"parameterId":"thinking"');
    expect(text).not.toContain("VALIDATION_ERROR");
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

  it("generateNamePOST generates a name from the whole project conversation", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1" }));

    const res = await h.handlers.generateNamePOST(
      jsonRequest({ source: "conversation" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Generated Project Name" });
    expect(h.deps.resolveConversationNamingContent).toHaveBeenCalledWith({
      conversationId: "c1",
      transcriptPath: "/tmp/project-conv.jsonl",
    });
    expect(h.deps.generateAndApplyConversationName).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "demo",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "c1",
      content: "Whole project conversation basis",
      trigger: "explicit",
    });
  });

  it("generateNamePOST generates a name from the addressed message", async () => {
    const h = harness();
    h.store.set("c1", makeConv({ id: "c1" }));

    const res = await h.handlers.generateNamePOST(
      jsonRequest({ source: "message", messageIndex: 2 }),
      ctx({ name: "demo", conversationId: "c1" }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Generated Project Name" });
    expect(h.deps.resolveMessageNamingContent).toHaveBeenCalledWith({
      transcriptPath: "/tmp/project-conv.jsonl",
      messageIndex: 2,
    });
    expect(h.deps.generateAndApplyConversationName).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Project message basis",
        trigger: "explicit",
      }),
    );
  });

  it.each([{ source: "unknown" }, { source: "message", messageIndex: -1 }])(
    "generateNamePOST returns 400 for malformed body %#",
    async (body) => {
      const h = harness();
      h.store.set("c1", makeConv({ id: "c1" }));

      const res = await h.handlers.generateNamePOST(
        jsonRequest(body),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(400);
      expect(h.deps.generateAndApplyConversationName).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "ghost", conversationId: "c1" },
    { name: "demo", conversationId: "missing" },
  ])("generateNamePOST returns 404 for unknown route %#", async (params) => {
    const h = harness();

    const res = await h.handlers.generateNamePOST(
      jsonRequest({ source: "conversation" }),
      ctx(params),
    );

    expect(res.status).toBe(404);
    expect(h.deps.generateAndApplyConversationName).not.toHaveBeenCalled();
  });

  it.each([
    {
      body: { source: "conversation" },
      overrides: {
        resolveConversationNamingContent: vi.fn(async () => null),
      } satisfies Partial<ProjectConversationRouteDeps>,
    },
    {
      body: { source: "message", messageIndex: 99 },
      overrides: {
        resolveMessageNamingContent: vi.fn(async () => null),
      } satisfies Partial<ProjectConversationRouteDeps>,
    },
  ])(
    "generateNamePOST returns 422 for unresolved content %#",
    async (testCase) => {
      const h = harness(testCase.overrides);
      h.store.set("c1", makeConv({ id: "c1" }));

      const res = await h.handlers.generateNamePOST(
        jsonRequest(testCase.body),
        ctx({ name: "demo", conversationId: "c1" }),
      );

      expect(res.status).toBe(422);
      expect(h.deps.generateAndApplyConversationName).not.toHaveBeenCalled();
    },
  );

  it("generateNamePOST returns 500 with the generation error", async () => {
    const h = harness({
      generateAndApplyConversationName: vi.fn(async () => {
        throw new Error("project naming failed");
      }),
    });
    h.store.set("c1", makeConv({ id: "c1" }));

    const res = await h.handlers.generateNamePOST(
      jsonRequest({ source: "conversation" }),
      ctx({ name: "demo", conversationId: "c1" }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "project naming failed" });
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
