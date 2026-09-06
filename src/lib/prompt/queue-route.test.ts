import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type {
  PendingQueuedMessage,
  QueuedMessageView,
} from "@/lib/conversations/message-queue-schemas";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { ImagePayload } from "@/lib/images/schemas";
import {
  createQueueRouteHandlers,
  type QueueRouteDeps,
} from "./queue-route-handlers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testSession = {
  sessionName: "test-session",
  worktreePath: "/projects/my-project/.worktrees/test-session",
  branchName: "csm/test-session",
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  archived: false,
  finished: false,
  conversations: [],
};

const testConversation = makeConversationState({
  id: "conv-123",
  status: "running",
  role: null,
  agentBackend: "claude",
});

const sampleImage: ImagePayload = {
  attachmentId: "att-1",
  mediaType: "image/png",
  base64Data: "aGVsbG8=",
};

function makePendingEntry(
  overrides: Partial<PendingQueuedMessage> = {},
): PendingQueuedMessage {
  return {
    id: "q-1",
    content: [{ type: "text", text: "follow up" }],
    status: "pending",
    enqueuedAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
    ...overrides,
  };
}

function makeView(entry: PendingQueuedMessage): QueuedMessageView {
  return {
    id: entry.id,
    content: entry.content,
    status: entry.status,
    enqueuedAt: entry.enqueuedAt,
    updatedAt: entry.updatedAt,
    deliveredAt: entry.deliveredAt,
    cancelledAt: entry.cancelledAt,
    failedAt: entry.failedAt,
    error: entry.error,
    metadata: entry.metadata,
  };
}

const inTurnCapability: QueueCapability = {
  acceptsWhileRunning: true,
  deliveryTiming: "in_turn",
};

type QueueRowStatus = PendingQueuedMessage["status"];

function createCancelStore(initialStatus: QueueRowStatus, rowId = "q-1") {
  const row = { id: rowId, status: initialStatus };
  return {
    row,
    cancel: vi.fn(
      async (input: {
        id: string;
      }): Promise<"cancelled" | "not_found" | "not_cancellable"> => {
        if (input.id !== row.id) return "not_found";
        if (row.status !== "pending") return "not_cancellable";
        row.status = "cancelled";
        return "cancelled";
      },
    ),
  };
}

function createTestDeps(
  overrides: Partial<QueueRouteDeps> = {},
): QueueRouteDeps {
  const entry = makePendingEntry();
  const store = createCancelStore("pending");
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    getConversation: vi.fn().mockResolvedValue(testConversation),
    admitModelSelection: vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    })),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    queueMessage: vi
      .fn()
      .mockResolvedValue({ entry, deliveryTiming: "in_turn" as const }),
    queueCapabilityForBackend: vi.fn().mockReturnValue(inTurnCapability),
    toQueuedMessageView: vi.fn((e: PendingQueuedMessage) => makeView(e)),
    clearConversationPendingPromptTextIfMatches: vi
      .fn()
      .mockResolvedValue(true),
    resolveDelivery: async () => "not_found",
    ensureConversationActorAndDrain: vi.fn().mockResolvedValue(undefined),
    cancel: store.cancel,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/conversations/conv-123/queue",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function makeParams(
  name = "my-project",
  session = "test-session",
  conversationId = "conv-123",
) {
  return { params: Promise.resolve({ name, session, conversationId }) };
}

function makeDeleteRequest(): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/conversations/conv-123/queue/q-1",
    { method: "DELETE" },
  ) as unknown as NextRequest;
}

function makeDeleteParams(
  messageId = "q-1",
  name = "my-project",
  session = "test-session",
  conversationId = "conv-123",
) {
  return {
    params: Promise.resolve({ name, session, conversationId, messageId }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: QueueRouteDeps;
let handlers: ReturnType<typeof createQueueRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createQueueRouteHandlers(deps);
});

// ===========================================================================
// Tests
// ===========================================================================

describe("POST .../conversations/[conversationId]/queue", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
    expect(deps.queueMessage).not.toHaveBeenCalled();
  });

  it("returns 404 when session not found", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 when conversation not found", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
  });

  it("accepts a text-only payload and queues it", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
    expect(body.deliveryTiming).toBe("in_turn");
    expect(body.message.id).toBe("q-1");
    expect(deps.queueMessage).toHaveBeenCalledWith({
      projectPath: "/projects/my-project",
      sessionName: "test-session",
      conversationId: "conv-123",
      text: "follow up",
      images: undefined,
      backend: "claude",
    });
  });

  it("accepts an image-only payload and queues it", async () => {
    const response = await handlers.POST(
      makeRequest({ images: [sampleImage] }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
    expect(deps.queueMessage).toHaveBeenCalledWith({
      projectPath: "/projects/my-project",
      sessionName: "test-session",
      conversationId: "conv-123",
      text: undefined,
      images: [sampleImage],
      backend: "claude",
    });
  });

  it("accepts a text+image payload and queues it", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "with picture", images: [sampleImage] }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.queueMessage).toHaveBeenCalledWith({
      projectPath: "/projects/my-project",
      sessionName: "test-session",
      conversationId: "conv-123",
      text: "with picture",
      images: [sampleImage],
      backend: "claude",
    });
  });

  it("forwards one complete model selection to durable queue persistence", async () => {
    const modelSelection = {
      modelId: "claude-opus-5",
      parameters: { effort: "xhigh", thinking: "true" },
    };

    const response = await handlers.POST(
      makeRequest({ text: "follow up", modelSelection }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.queueMessage).toHaveBeenCalledWith({
      projectPath: "/projects/my-project",
      sessionName: "test-session",
      conversationId: "conv-123",
      text: "follow up",
      modelSelection,
      backend: "claude",
    });
  });

  it("canonicalizes a complete selection before durable queue persistence", async () => {
    const requestedSelection = {
      modelId: "composer",
      parameters: { fast: "true" },
    };
    const canonicalSelection = {
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    };
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      agentBackend: "cursor",
    });
    vi.mocked(deps.admitModelSelection).mockResolvedValue({
      ok: true,
      modelSelection: canonicalSelection,
    });

    const response = await handlers.POST(
      makeRequest({ text: "follow up", modelSelection: requestedSelection }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.admitModelSelection).toHaveBeenCalledWith({
      backend: "cursor",
      projectPath: "/projects/my-project",
      modelSelection: requestedSelection,
    });
    expect(deps.queueMessage).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: canonicalSelection }),
    );
  });

  it("rejects a catalog-invalid selection before durable queue persistence", async () => {
    vi.mocked(deps.admitModelSelection).mockResolvedValue({
      ok: false,
      code: "unsupported_combination",
      message: "The requested parameter combination is unsupported.",
      modelId: "claude-opus-5",
      parameterId: "thinking",
    });

    const response = await handlers.POST(
      makeRequest({
        text: "follow up",
        modelSelection: {
          modelId: "claude-opus-5",
          parameters: { effort: "max", thinking: "false" },
        },
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The requested parameter combination is unsupported.",
      code: "unsupported_combination",
      modelId: "claude-opus-5",
      parameterId: "thinking",
    });
    expect(deps.queueMessage).not.toHaveBeenCalled();
  });

  it("returns 400 EMPTY_MESSAGE when the payload has neither text nor images", async () => {
    const response = await handlers.POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("EMPTY_MESSAGE");
    expect(deps.queueMessage).not.toHaveBeenCalled();
  });

  it("returns 400 EMPTY_MESSAGE when text is whitespace-only and no images", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "   " }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("EMPTY_MESSAGE");
    expect(deps.queueMessage).not.toHaveBeenCalled();
  });

  it("returns 403 NON_INTERACTIVE_CONVERSATION for a workflow-role conversation", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      role: "iteration",
    } as ConversationState);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("NON_INTERACTIVE_CONVERSATION");
    expect(deps.queueMessage).not.toHaveBeenCalled();
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).not.toHaveBeenCalled();
  });

  it("returns 409 NOT_RUNNING when the conversation is not running", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      status: "awaiting",
    } as ConversationState);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("NOT_RUNNING");
    expect(deps.queueMessage).not.toHaveBeenCalled();
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).not.toHaveBeenCalled();
    expect(deps.ensureConversationActorAndDrain).not.toHaveBeenCalled();
  });

  it("returns 422 UNSUPPORTED_BACKEND when the backend cannot accept while running", async () => {
    vi.mocked(deps.queueCapabilityForBackend).mockReturnValue({
      acceptsWhileRunning: false,
      deliveryTiming: "next_turn",
    });
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("UNSUPPORTED_BACKEND");
    expect(deps.queueMessage).not.toHaveBeenCalled();
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).not.toHaveBeenCalled();
  });

  it("returns the queued view and deliveryTiming from the queueMessage result", async () => {
    const entry = makePendingEntry({ id: "q-99" });
    vi.mocked(deps.queueMessage).mockResolvedValue({
      entry,
      deliveryTiming: "next_turn",
    });
    const response = await handlers.POST(
      makeRequest({ text: "queued draft" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      queued: true,
      message: makeView(entry),
      deliveryTiming: "next_turn",
    });
    expect(deps.toQueuedMessageView).toHaveBeenCalledWith(entry);
  });

  it("nudges a post-enqueue drain so a row enqueued as the turn ends is not stranded", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.ensureConversationActorAndDrain).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-123",
    );
    // The nudge must run against the committed row, so only after the enqueue.
    const enqueueOrder = vi.mocked(deps.queueMessage).mock
      .invocationCallOrder[0]!;
    const drainOrder = vi.mocked(deps.ensureConversationActorAndDrain).mock
      .invocationCallOrder[0]!;
    expect(drainOrder).toBeGreaterThan(enqueueOrder);
  });

  it("still returns the queued response when the post-enqueue drain fails", async () => {
    vi.mocked(deps.ensureConversationActorAndDrain).mockRejectedValue(
      new Error("actor load failed"),
    );

    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
  });

  it("clears only the exact submitted pending prompt after queueing", async () => {
    const response = await handlers.POST(
      makeRequest({
        text: "queued draft",
        submittedPendingPromptText: "  queued draft  ",
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-123",
      "  queued draft  ",
    );
    const enqueueOrder = vi.mocked(deps.queueMessage).mock
      .invocationCallOrder[0]!;
    const clearOrder = vi.mocked(
      deps.clearConversationPendingPromptTextIfMatches,
    ).mock.invocationCallOrder[0]!;
    expect(clearOrder).toBeGreaterThan(enqueueOrder);
  });
});

describe("DELETE .../conversations/[conversationId]/queue/[messageId]", () => {
  it("cancels a pending entry", async () => {
    const store = createCancelStore("pending");
    deps = createTestDeps({
      cancel: store.cancel,
    });
    handlers = createQueueRouteHandlers(deps);

    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ cancelled: true, id: "q-1" });
    expect(store.cancel).toHaveBeenCalledWith({
      projectPath: "/projects/my-project",
      sessionName: "test-session",
      conversationId: "conv-123",
      id: "q-1",
    });
    expect(store.row.status).toBe("cancelled");
  });

  it("returns 409 NOT_CANCELLABLE for an already-delivered entry", async () => {
    const store = createCancelStore("delivered");
    deps = createTestDeps({
      cancel: store.cancel,
    });
    handlers = createQueueRouteHandlers(deps);

    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("NOT_CANCELLABLE");
    expect(store.row.status).toBe("delivered");
  });

  it("does not reclaim a delivering row from a cancellation request", async () => {
    const store = createCancelStore("delivering");
    deps = createTestDeps({
      cancel: store.cancel,
    });
    handlers = createQueueRouteHandlers(deps);

    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("NOT_CANCELLABLE");
    expect(store.row.status).toBe("delivering");
  });

  it("returns 404 when the queued message does not exist", async () => {
    const store = createCancelStore("pending", "other-id");
    deps = createTestDeps({
      cancel: store.cancel,
    });
    handlers = createQueueRouteHandlers(deps);

    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams("missing-id"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Queued message not found");
  });

  it("returns 404 when the project is not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);
    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is not found", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(null);
    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("returns 404 when the conversation is not found", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue(null);
    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it("returns 403 NON_INTERACTIVE_CONVERSATION for a workflow-role conversation", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      role: "iteration",
    } as ConversationState);
    const response = await handlers.DELETE(
      makeDeleteRequest(),
      makeDeleteParams(),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("NON_INTERACTIVE_CONVERSATION");
    expect(deps.cancel).not.toHaveBeenCalled();
  });
});

describe("queue/[messageId] route shell", () => {
  it("exports a DELETE handler function", async () => {
    const shell =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/[messageId]/route");
    expect(typeof shell.DELETE).toBe("function");
    expect(shell.dynamic).toBe("force-dynamic");
  });
});
