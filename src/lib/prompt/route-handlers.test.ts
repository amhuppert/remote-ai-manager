import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { ConversationState } from "@/lib/conversations/schemas";

import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "./route-handlers";
import { type CollaborationManager } from "@/lib/workflows/collaboration/manager";

// ---------------------------------------------------------------------------
// Mock deps (no vi.mock needed)
// ---------------------------------------------------------------------------

function createTestDeps(): PromptRouteDeps {
  const getSession = vi.fn().mockResolvedValue(testSession);
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/projects/my-project"),
    getSession,
    getConversation: vi.fn().mockResolvedValue(testConversation),
    // The active execution no longer rides the session row; the approval-gate
    // check reads it via this accessor. Fixtures still seed it on the session
    // mock, so surface whatever the current getSession mock returns.
    isConversationBusy: vi.fn().mockReturnValue(false),
    admitConversationTurn: async () => ({
      kind: "admit" as const,
      turnGeneration: 1,
    }),
    executePromptStream: vi.fn().mockResolvedValue(undefined),
    getCollaborationManager: vi.fn().mockReturnValue(makeMockManager()),
    setConversationPendingPromptText: vi.fn().mockResolvedValue(undefined),
    clearConversationPendingPromptTextIfMatches: vi
      .fn()
      .mockResolvedValue(true),
    coreConversations: {
      owns: vi.fn().mockReturnValue(false),
      prompt: vi.fn(async () => new Response("core")),
      admitCollaboration: vi.fn(async () => null),
    },
  };
}

function makeMockManager(
  overrides: Partial<CollaborationManager> = {},
): CollaborationManager {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ workflowId: "wf-test-1", status: "started" }),
    resume: vi.fn(),
    stop: vi.fn(),
    getEnvelope: vi.fn(),
    listActive: vi.fn(),
    listAll: vi.fn(),
    ...overrides,
  } as unknown as CollaborationManager;
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
  // Free: no non-prompt turn holds it. The production decoder always supplies
  // this, so a fake that omits it would test a shape that cannot occur.
  owner: null,
  turnGeneration: 0,
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
  pendingPromptText: null,
  forkedFrom: null,
  contextTokens: null,
  contextWindowMax: null,
  debugMode: null,
  archived: false,
  agentBackend: "claude" as const,
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
    expect(
      vi.mocked(deps.executePromptStream).mock.calls[0]?.[7]?.inputOrigin,
    ).toBe("user");
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

  it("dispatches /collab prompt via executePromptStream collab options instead of rejecting", async () => {
    const executeMock = vi.fn().mockResolvedValue({
      conversationId: "conv-new",
      contextTokens: null,
      contextWindowMax: null,
    });
    deps.executePromptStream = executeMock;
    handlers = createPromptRouteHandlers(deps);

    const response = await handlers.POST(
      makeRequest({
        prompt: "/collab investigate the regression",
        collab: {
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        },
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(executeMock).toHaveBeenCalledTimes(1);
    const callArgs = executeMock.mock.calls[0]!;
    expect(callArgs[2]).toBe("/collab investigate the regression");
    const callOptions = callArgs[7];
    expect(callOptions).toMatchObject({
      collab: {
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      },
    });
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

  it("leaves a run seat's refusal to the core, whatever the old engine's gates say", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      role: "iteration",
    } as ConversationState);
    vi.mocked(deps.coreConversations.owns).mockReturnValue(true);

    await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(deps.coreConversations.prompt).toHaveBeenCalledOnce();
  });

  // A collaboration occupies the conversation for minutes or hours. Admitting
  // a prompt alongside it would interleave two turns in one transcript and
  // leave the collaboration unable to prove, on resume, that the conversation
  // is still the one it claimed.
  it("refuses a prompt while a collaboration holds the conversation", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      owner: { kind: "collaboration", workflowId: "wf-7", attemptEpoch: 1 },
    } as ConversationState);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("CONVERSATION_OWNED");
    expect(body.error).toContain("wf-7");
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

  it("hands a prompt for a conversation the shared core runs to the core, not the conversation actor", async () => {
    vi.mocked(deps.coreConversations.owns).mockReturnValue(true);
    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(await response.text()).toBe("core");
    expect(deps.coreConversations.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/projects/my-project",
        target: {
          scope: "session",
          projectName: "my-project",
          sessionName: "test-session",
          conversationId: "conv-1",
        },
        body: expect.objectContaining({ prompt: "Hello" }),
      }),
    );
    expect(deps.executePromptStream).not.toHaveBeenCalled();
    expect(deps.isConversationBusy).not.toHaveBeenCalled();
  });

  it("starts Collaboration Mode from a /collab prompt on a conversation the shared core runs", async () => {
    vi.mocked(deps.coreConversations.owns).mockReturnValue(true);
    const startMock = vi
      .fn()
      .mockResolvedValue({ workflowId: "wf-core", status: "started" });
    vi.mocked(deps.getCollaborationManager).mockReturnValue(
      makeMockManager({ start: startMock }),
    );
    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab design the cache" }),
      makeConvParams(),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ workflowId: "wf-core" });
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        brief: "design the cache",
      }),
    );
    expect(deps.coreConversations.prompt).not.toHaveBeenCalled();
  });

  it("holds /collab on a core conversation where the core would hold a claim", async () => {
    vi.mocked(deps.coreConversations.owns).mockReturnValue(true);
    vi.mocked(deps.coreConversations.admitCollaboration).mockResolvedValue(
      Response.json(
        { error: "Exit debug mode first", code: "DEBUG_MODE_ACTIVE" },
        { status: 409 },
      ),
    );
    const startMock = vi.fn();
    vi.mocked(deps.getCollaborationManager).mockReturnValue(
      makeMockManager({ start: startMock }),
    );
    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab design the cache" }),
      makeConvParams(),
    );
    expect(response.status).toBe(409);
    expect(startMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Image payload forwarding
// ===========================================================================

describe("image payload forwarding", () => {
  const validImagePayload = {
    attachmentId: "att-1",
    mediaType: "image/png" as const,
    base64Data: "BASE64DATA",
    inlineMarkerIndex: 1,
  };

  it("accepts new image payload shape (attachmentId + inlineMarkerIndex) and forwards to executePromptStream on session POST", async () => {
    const response = await handlers.POST(
      makeRequest({
        prompt: "look at [Image #1]",
        images: [validImagePayload],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);

    const stream = response.body;
    if (stream) {
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain
      }
    }

    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(deps.executePromptStream).mock.calls[0]!;
    const forwardedImages = callArgs[6];
    expect(forwardedImages).toEqual([validImagePayload]);
  });

  it("accepts images with no inlineMarkerIndex (strip-only attachments)", async () => {
    const stripOnly = {
      attachmentId: "att-strip",
      mediaType: "image/png" as const,
      base64Data: "STRIP",
    };

    const response = await handlers.POST(
      makeRequest({
        prompt: "describe these",
        images: [stripOnly],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);

    const stream = response.body;
    if (stream) {
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain
      }
    }

    const callArgs = vi.mocked(deps.executePromptStream).mock.calls[0]!;
    const forwardedImages = callArgs[6];
    expect(forwardedImages).toEqual([stripOnly]);
  });

  it("rejects image payloads missing attachmentId with 400", async () => {
    const response = await handlers.POST(
      makeRequest({
        prompt: "hi",
        images: [
          {
            mediaType: "image/png",
            base64Data: "BASE64",
            inlineMarkerIndex: 1,
          },
        ],
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(deps.executePromptStream).not.toHaveBeenCalled();
  });

  it("rejects image payloads with non-positive inlineMarkerIndex with 400", async () => {
    const response = await handlers.POST(
      makeRequest({
        prompt: "hi",
        images: [
          {
            attachmentId: "att-1",
            mediaType: "image/png",
            base64Data: "BASE64",
            inlineMarkerIndex: 0,
          },
        ],
      }),
      makeParams(),
    );

    expect(response.status).toBe(400);
    expect(deps.executePromptStream).not.toHaveBeenCalled();
  });

  it("accepts request with images but empty prompt text", async () => {
    const response = await handlers.POST(
      makeRequest({
        prompt: "",
        images: [validImagePayload],
      }),
      makeParams(),
    );

    expect(response.status).toBe(200);
  });
});
