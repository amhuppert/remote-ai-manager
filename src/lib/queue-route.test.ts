import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  resolveProjectPathMock,
  getSessionMock,
  getConversationMock,
  queueMessageMock,
} = vi.hoisted(() => ({
  resolveProjectPathMock: vi.fn(),
  getSessionMock: vi.fn(),
  getConversationMock: vi.fn(),
  queueMessageMock: vi.fn(),
}));

vi.mock("@/lib/project-resolver", () => ({
  resolveProjectPath: resolveProjectPathMock,
  getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
}));

vi.mock("@/lib/state", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/conversations", () => ({
  getConversation: getConversationMock,
}));

vi.mock("@/lib/queue-message", () => ({
  queueMessage: queueMessageMock,
}));

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

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  resolveProjectPathMock.mockResolvedValue("/projects/my-project");
  getSessionMock.mockResolvedValue(testSession);
  getConversationMock.mockResolvedValue(testConversation);
  queueMessageMock.mockResolvedValue(undefined);
});

// ===========================================================================
// Tests
// ===========================================================================

describe("POST .../conversations/[conversationId]/queue", () => {
  it("returns 404 when project not found", async () => {
    resolveProjectPathMock.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({ text: "hello" }), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session not found", async () => {
    getSessionMock.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({ text: "hello" }), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("returns 404 when conversation not found", async () => {
    getConversationMock.mockResolvedValue(null);
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({ text: "hello" }), makeParams());

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
  });

  it("returns 400 when message text is missing", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("text");
  });

  it("returns 400 when message text is empty/whitespace", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({ text: "   " }), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("text");
  });

  it("returns 409 when conversation is not running", async () => {
    getConversationMock.mockResolvedValue({
      ...testConversation,
      status: "awaiting",
    });
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(makeRequest({ text: "hello" }), makeParams());

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("NOT_RUNNING");
  });

  it("returns 200 with queued flag on success", async () => {
    const { POST } =
      await import("@/app/api/projects/[name]/sessions/[session]/conversations/[conversationId]/queue/route");
    const response = await POST(
      makeRequest({ text: "follow up" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued).toBe(true);
  });
});
