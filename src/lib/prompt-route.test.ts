import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { ConversationState } from "@/types";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "./prompt-route-handlers";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): PromptRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession: vi.fn().mockResolvedValue(testSession),
    getConversation: vi.fn().mockResolvedValue(testConversation),
    isConversationBusy: vi.fn().mockReturnValue(false),
    executePromptStream: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new Request(
    "http://localhost/api/projects/my-project/sessions/test-session/prompt",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function makeParams(name = "my-project", session = "test-session") {
  return { params: Promise.resolve({ name, session }) };
}

function makeConvParams(
  name = "my-project",
  session = "test-session",
  conversationId = "conv-1",
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
  id: "conv-1",
  status: "awaiting" as const,
  createdAt: "2024-01-01T00:00:00Z",
  lastActivityAt: "2024-01-01T00:00:00Z",
  promptCount: 0,
  role: null,
  name: null,
  summary: null,
  transcriptPath: "/tmp/transcript.jsonl",
  totalCostUsd: 0,
  totalDurationMs: 0,
  totalTurns: 0,
  source: "cc",
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  contextTokens: null,
  contextWindowMax: null,
  debugMode: null,
  machineSnapshot: null,
  archived: false,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let deps: PromptRouteDeps;
let handlers: ReturnType<typeof createPromptRouteHandlers>;

beforeEach(() => {
  vi.clearAllMocks();
  deps = createTestDeps();
  handlers = createPromptRouteHandlers(deps);
});

// ===========================================================================
// API route tests
// ===========================================================================

describe("POST /api/projects/[name]/sessions/[session]/prompt", () => {
  it("returns SSE stream with text/event-stream content type on valid prompt", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "Hello Claude" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("returns 400 when prompt field is missing", async () => {
    const response = await handlers.POST(makeRequest({}), makeParams());

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(
      "Either prompt text or at least one image is required",
    );
  });

  it("returns 400 when prompt is empty string", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "   " }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain(
      "Either prompt text or at least one image is required",
    );
  });

  it("returns 404 when project is not found", async () => {
    vi.mocked(deps.resolveProjectPath).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams("unknown"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Project not found");
  });

  it("returns 404 when session is not found", async () => {
    vi.mocked(deps.getSession).mockResolvedValue(null);
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams("my-project", "unknown-session"),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Session not found");
  });

  it("does not consult conversation busy state for new-conversation POSTs", async () => {
    // The session-level POST creates a fresh conversation; there is no
    // existing conversation to be busy. The handler should not call
    // `isConversationBusy` and should proceed straight to streaming.
    const response = await handlers.POST(
      makeRequest({ prompt: "test" }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(deps.isConversationBusy).not.toHaveBeenCalled();
  });

  it("trims prompt text (whitespace-only rejected as empty)", async () => {
    const response = await handlers.POST(
      makeRequest({ prompt: "  Hello Claude  " }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });
});

// ===========================================================================
// Conversation-level prompt route tests
// ===========================================================================

describe("POST /api/projects/[name]/sessions/[session]/conversations/[conversationId]/prompt", () => {
  it("returns 403 for managed iteration conversations", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      role: "iteration",
    } as ConversationState);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe("MANAGED_CONVERSATION");
  });

  it("returns 404 when conversation is not found", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue(null);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "test" }),
      makeConvParams(),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Conversation not found");
  });

  it("returns SSE stream on valid conversation prompt", async () => {
    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello Claude" }),
      makeConvParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("returns 409 with CONVERSATION_BUSY code when conversation has an in-flight prompt", async () => {
    vi.mocked(deps.isConversationBusy).mockReturnValue(true);
    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "test" }),
      makeConvParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("CONVERSATION_BUSY");
    expect(body.error).toContain("Conversation is busy");
    expect(deps.isConversationBusy).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-1",
    );
  });

  it("allows a different conversation to start while another runs in the same session", async () => {
    // Models the new behavior: multiple conversations in the same session
    // can run concurrently. Only the targeted conversation is gated.
    vi.mocked(deps.isConversationBusy).mockImplementation(
      (_p, _s, conversationId) => conversationId === "other-conv",
    );

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });
});
