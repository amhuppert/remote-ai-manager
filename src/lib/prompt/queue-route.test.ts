import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  createQueueRouteHandlers,
  type QueueRouteDeps,
} from "./queue-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
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

const testConversation = {
  id: "conv-123",
  status: "running" as const,
  role: null,
};

function createTestDeps(): QueueRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    getConversation: vi.fn().mockResolvedValue(testConversation),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    queueMessage: vi.fn().mockResolvedValue(undefined),
    setConversationPendingPromptText: vi.fn().mockResolvedValue(undefined),
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

  it("returns 400 when message text is missing", async () => {
    const response = await handlers.POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("text");
  });

  it("returns 400 when message text is empty/whitespace", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "   " }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("text");
  });

  it("returns 409 when conversation is not running", async () => {
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
  });

  it("returns 200 with queued flag on success", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
  });

  it("clears conversation pendingPromptText before queueing", async () => {
    const response = await handlers.POST(
      makeRequest({ text: "queued draft" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.setConversationPendingPromptText).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-123",
      null,
    );
  });

  it("does not clear pendingPromptText when conversation is not running", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      status: "awaiting",
    } as ConversationState);
    const response = await handlers.POST(
      makeRequest({ text: "hello" }),
      makeParams(),
    );

    expect(response.status).toBe(409);
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
  });
});
