import { describe, it, expect, vi } from "vitest";
import {
  createConversationRouteHandlers,
  type ConversationRouteDeps,
} from "./lifecycle-route-handlers";
import {
  conversationCreatedEventSchema,
  conversationRenamedEventSchema,
  conversationArchivedEventSchema,
} from "@/lib/conversations/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
    name: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    ...overrides,
  } as ConversationState;
}

function makeSession(conversations: ConversationState[] = []): SessionState {
  return {
    name: "s1",
    branch: "csm/s1",
    worktreePath: "/tmp/worktree",
    archived: false,
    pinned: false,
    tddEnabled: false,
    objective: null,
    conversations,
    referenceDocuments: [],
    createdAt: "2024-01-01T00:00:00Z",
  } as unknown as SessionState;
}

function makeDeps(overrides: Partial<ConversationRouteDeps> = {}) {
  const conversation = makeConversation();
  const session = makeSession([conversation]);

  const deps: ConversationRouteDeps = {
    resolveProjectPath: vi.fn(async () => "/repos/demo"),
    getProjectDisplayName: vi.fn(() => "demo"),
    getSession: vi.fn(async () => session),
    createConversation: vi.fn(async () => conversation),
    renameConversation: vi.fn(async () => {}),
    setConversationArchived: vi.fn(async () => {}),
    broadcast: vi.fn(),
    ...overrides,
  };
  return { deps, conversation, session };
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function jsonRequest(body?: unknown): Request {
  return new Request("http://cc.test/conv", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ============================================================================
// POST_CREATE
// ============================================================================

describe("POST_CREATE — conversation-created broadcast", () => {
  it("returns 201 with the new conversation and broadcasts conversation-created", async () => {
    const { deps, conversation } = makeDeps();
    const { POST_CREATE } = createConversationRouteHandlers(deps);

    const response = await POST_CREATE(
      jsonRequest(),
      context({ name: "demo", session: "s1" }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as ConversationState;
    expect(body.id).toBe(conversation.id);

    const calls = vi.mocked(deps.broadcast).mock.calls;
    expect(calls).toHaveLength(1);
    const event = calls[0]![0] as SSEEvent;
    expect(event.type).toBe("conversation-created");
    const parsed = conversationCreatedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scope).toBe("session");
      if (parsed.data.scope === "session") {
        expect(parsed.data.projectName).toBe("demo");
        expect(parsed.data.sessionName).toBe("s1");
        expect(parsed.data.conversation.id).toBe(conversation.id);
      }
    }
  });

  it("returns 404 and does not broadcast when project is missing", async () => {
    const { deps } = makeDeps({
      resolveProjectPath: vi.fn(async () => null),
    });
    const { POST_CREATE } = createConversationRouteHandlers(deps);

    const response = await POST_CREATE(
      jsonRequest(),
      context({ name: "missing", session: "s1" }),
    );

    expect(response.status).toBe(404);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.createConversation).not.toHaveBeenCalled();
  });

  it("returns 404 and does not broadcast when session is missing", async () => {
    const { deps } = makeDeps({
      getSession: vi.fn(async () => null),
    });
    const { POST_CREATE } = createConversationRouteHandlers(deps);

    const response = await POST_CREATE(
      jsonRequest(),
      context({ name: "demo", session: "missing" }),
    );

    expect(response.status).toBe(404);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns 500 and does not broadcast when the create service throws", async () => {
    const { deps } = makeDeps({
      createConversation: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const { POST_CREATE } = createConversationRouteHandlers(deps);

    const response = await POST_CREATE(
      jsonRequest(),
      context({ name: "demo", session: "s1" }),
    );

    expect(response.status).toBe(500);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});

// ============================================================================
// PATCH_RENAME
// ============================================================================

describe("PATCH_RENAME — conversation-renamed broadcast", () => {
  it("broadcasts conversation-renamed with the new name after a successful rename", async () => {
    const { deps } = makeDeps();
    const { PATCH_RENAME } = createConversationRouteHandlers(deps);

    const response = await PATCH_RENAME(
      jsonRequest({ name: "fresh-name" }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(200);
    expect(deps.renameConversation).toHaveBeenCalledWith(
      "/repos/demo",
      "s1",
      "conv-1",
      "fresh-name",
    );

    const calls = vi.mocked(deps.broadcast).mock.calls;
    expect(calls).toHaveLength(1);
    const event = calls[0]![0] as SSEEvent;
    const parsed = conversationRenamedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("fresh-name");
      expect(parsed.data.conversationId).toBe("conv-1");
    }
  });

  it("returns 404 when the conversation is not present in the session", async () => {
    const { deps } = makeDeps({
      getSession: vi.fn(async () => makeSession([])),
    });
    const { PATCH_RENAME } = createConversationRouteHandlers(deps);

    const response = await PATCH_RENAME(
      jsonRequest({ name: "fresh-name" }),
      context({ name: "demo", session: "s1", conversationId: "missing" }),
    );

    expect(response.status).toBe(404);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.renameConversation).not.toHaveBeenCalled();
  });

  it("returns 500 and does not broadcast when the rename service throws", async () => {
    const { deps } = makeDeps({
      renameConversation: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const { PATCH_RENAME } = createConversationRouteHandlers(deps);

    const response = await PATCH_RENAME(
      jsonRequest({ name: "fresh" }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(500);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns 400 and does not broadcast when the body is invalid", async () => {
    const { deps } = makeDeps();
    const { PATCH_RENAME } = createConversationRouteHandlers(deps);

    const response = await PATCH_RENAME(
      jsonRequest({}),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(400);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.renameConversation).not.toHaveBeenCalled();
  });
});

// ============================================================================
// POST_ARCHIVE_OTHERS
// ============================================================================

describe("POST_ARCHIVE_OTHERS — bulk archive of sibling conversations", () => {
  function makeSiblingDeps(overrides: Partial<ConversationRouteDeps> = {}) {
    const kept = makeConversation({ id: "conv-keep" });
    const siblingA = makeConversation({ id: "conv-a" });
    const siblingB = makeConversation({ id: "conv-b" });
    const alreadyArchived = makeConversation({
      id: "conv-archived",
      archived: true,
    });
    const session = makeSession([kept, siblingA, siblingB, alreadyArchived]);
    const { deps } = makeDeps({
      getSession: vi.fn(async () => session),
      ...overrides,
    });
    return { deps };
  }

  it("archives every non-archived sibling, skips the target and already-archived rows", async () => {
    const { deps } = makeSiblingDeps();
    const { POST_ARCHIVE_OTHERS } = createConversationRouteHandlers(deps);

    const response = await POST_ARCHIVE_OTHERS(
      jsonRequest(),
      context({ name: "demo", session: "s1", conversationId: "conv-keep" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { archivedIds: string[] };
    expect(body.archivedIds).toEqual(["conv-a", "conv-b"]);

    const archiveCalls = vi.mocked(deps.setConversationArchived).mock.calls;
    expect(archiveCalls).toEqual([
      ["/repos/demo", "s1", "conv-a", true],
      ["/repos/demo", "s1", "conv-b", true],
    ]);

    const events = vi
      .mocked(deps.broadcast)
      .mock.calls.map((call) => call[0] as SSEEvent);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const parsed = conversationArchivedEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.archived).toBe(true);
      }
    }
    expect(
      events.map((e) => (e as { conversationId: string }).conversationId),
    ).toEqual(["conv-a", "conv-b"]);
  });

  it("returns an empty archivedIds list when the target is the only open conversation", async () => {
    const kept = makeConversation({ id: "conv-keep" });
    const { deps } = makeDeps({
      getSession: vi.fn(async () => makeSession([kept])),
    });
    const { POST_ARCHIVE_OTHERS } = createConversationRouteHandlers(deps);

    const response = await POST_ARCHIVE_OTHERS(
      jsonRequest(),
      context({ name: "demo", session: "s1", conversationId: "conv-keep" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { archivedIds: string[] };
    expect(body.archivedIds).toEqual([]);
    expect(deps.setConversationArchived).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns 404 when the target conversation is not in the session", async () => {
    const { deps } = makeSiblingDeps();
    const { POST_ARCHIVE_OTHERS } = createConversationRouteHandlers(deps);

    const response = await POST_ARCHIVE_OTHERS(
      jsonRequest(),
      context({ name: "demo", session: "s1", conversationId: "missing" }),
    );

    expect(response.status).toBe(404);
    expect(deps.setConversationArchived).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns 500 when the archive service throws mid-run", async () => {
    const { deps } = makeSiblingDeps({
      setConversationArchived: vi
        .fn(async () => {})
        .mockImplementationOnce(async () => {})
        .mockImplementationOnce(async () => {
          throw new Error("io err");
        }),
    });
    const { POST_ARCHIVE_OTHERS } = createConversationRouteHandlers(deps);

    const response = await POST_ARCHIVE_OTHERS(
      jsonRequest(),
      context({ name: "demo", session: "s1", conversationId: "conv-keep" }),
    );

    expect(response.status).toBe(500);
    // The first sibling archived successfully before the failure, so its
    // event was already broadcast — streaming clients stay consistent.
    expect(vi.mocked(deps.broadcast).mock.calls).toHaveLength(1);
  });
});

// ============================================================================
// PATCH_ARCHIVE
// ============================================================================

describe("PATCH_ARCHIVE — conversation-archived broadcast", () => {
  it("broadcasts conversation-archived with archived=true after a successful archive", async () => {
    const { deps } = makeDeps();
    const { PATCH_ARCHIVE } = createConversationRouteHandlers(deps);

    const response = await PATCH_ARCHIVE(
      jsonRequest({ archived: true }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(200);
    expect(deps.setConversationArchived).toHaveBeenCalledWith(
      "/repos/demo",
      "s1",
      "conv-1",
      true,
    );

    const calls = vi.mocked(deps.broadcast).mock.calls;
    expect(calls).toHaveLength(1);
    const event = calls[0]![0] as SSEEvent;
    const parsed = conversationArchivedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.archived).toBe(true);
      expect(parsed.data.conversationId).toBe("conv-1");
    }
  });

  it("broadcasts conversation-archived with archived=false for an unarchive", async () => {
    const { deps } = makeDeps();
    const { PATCH_ARCHIVE } = createConversationRouteHandlers(deps);

    await PATCH_ARCHIVE(
      jsonRequest({ archived: false }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    const event = vi.mocked(deps.broadcast).mock.calls[0]![0];
    expect((event as { archived: boolean }).archived).toBe(false);
  });

  it("returns 500 and does not broadcast when the service throws", async () => {
    const { deps } = makeDeps({
      setConversationArchived: vi.fn(async () => {
        throw new Error("io err");
      }),
    });
    const { PATCH_ARCHIVE } = createConversationRouteHandlers(deps);

    const response = await PATCH_ARCHIVE(
      jsonRequest({ archived: true }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(500);
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it("returns 400 and does not broadcast when the body is invalid", async () => {
    const { deps } = makeDeps();
    const { PATCH_ARCHIVE } = createConversationRouteHandlers(deps);

    const response = await PATCH_ARCHIVE(
      jsonRequest({ archived: "yes" }),
      context({ name: "demo", session: "s1", conversationId: "conv-1" }),
    );

    expect(response.status).toBe(400);
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.setConversationArchived).not.toHaveBeenCalled();
  });
});
