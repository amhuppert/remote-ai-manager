import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { ConversationState } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { GraphWorkflowPendingApproval } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "./route-handlers";
import {
  CollaborationStartConflictError,
  type CollaborationManager,
} from "@/lib/workflows/collaboration/manager";

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
    getActiveGraphWorkflowExecution: vi.fn(async () => {
      const session = await getSession();
      return session?.graphWorkflowExecution ?? null;
    }),
    isConversationBusy: vi.fn().mockReturnValue(false),
    executePromptStream: vi.fn().mockResolvedValue(undefined),
    getCollaborationManager: vi.fn().mockReturnValue(makeMockManager()),
    setConversationPendingPromptText: vi.fn().mockResolvedValue(undefined),
    clearConversationPendingPromptTextIfMatches: vi
      .fn()
      .mockResolvedValue(true),
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

  it("dispatches /collab prompt to collaboration manager.start with originating agent and config", async () => {
    const startMock = vi.fn().mockResolvedValue({
      workflowId: "wf-77",
      status: "started",
      transcript: {
        brief: "redesign auth flow",
        imageRefs: [
          {
            index: 0,
            mediaType: "image/png",
            path: "/private/transcripts/conv-1/images/0.png",
            base64Data: "aW1hZ2UtMQ==",
          },
        ],
      },
    });
    const manager = makeMockManager({ start: startMock });
    vi.mocked(deps.getCollaborationManager).mockReturnValue(manager);
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      agentBackend: "codex",
    } as ConversationState);

    const response = await handlers.conversationPOST(
      makeRequest({
        prompt: "/collab redesign auth flow",
        images: [
          {
            attachmentId: "att-1",
            mediaType: "image/png" as const,
            base64Data: "aW1hZ2UtMQ==",
          },
          {
            attachmentId: "att-2",
            mediaType: "image/jpeg" as const,
            base64Data: "aW1hZ2UtMg==",
          },
        ],
        collab: {
          negotiationRounds: 6,
          autonomousResolutionThreshold: "blocking",
        },
      }),
      makeConvParams(),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body.workflowId).toBe("wf-77");
    expect(body.statusUrl).toContain("/collaboration/wf-77");
    expect(Object.keys(body).sort()).toEqual([
      "status",
      "statusUrl",
      "workflowId",
    ]);
    expect(deps.executePromptStream).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/projects/my-project",
        sessionName: "test-session",
        conversationId: "conv-1",
        brief: "redesign auth flow",
        negotiationRounds: 6,
        autonomousResolutionThreshold: "blocking",
        images: [
          {
            attachmentId: "att-1",
            mediaType: "image/png",
            base64Data: "aW1hZ2UtMQ==",
          },
          {
            attachmentId: "att-2",
            mediaType: "image/jpeg",
            base64Data: "aW1hZ2UtMg==",
          },
        ],
      }),
    );
  });

  it("dispatches /collab prompt with default negotiationRounds when collab body is omitted", async () => {
    const startMock = vi
      .fn()
      .mockResolvedValue({ workflowId: "wf-78", status: "started" });
    const manager = makeMockManager({ start: startMock });
    vi.mocked(deps.getCollaborationManager).mockReturnValue(manager);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab quick spike" }),
      makeConvParams(),
    );

    expect(response.status).toBe(202);
    expect(deps.executePromptStream).not.toHaveBeenCalled();
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        brief: "quick spike",
        conversationId: "conv-1",
        negotiationRounds: expect.any(Number),
        autonomousResolutionThreshold: expect.any(String),
      }),
    );
  });

  it("returns 400 when /collab prompt has no brief", async () => {
    const startMock = vi.fn();
    const manager = makeMockManager({ start: startMock });
    vi.mocked(deps.getCollaborationManager).mockReturnValue(manager);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab" }),
      makeConvParams(),
    );

    expect(response.status).toBe(400);
    expect(startMock).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.code).toBe("COLLAB_BRIEF_REQUIRED");
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

  // Submission is the user committing pendingPromptText into the conversation
  // history; if the server doesn't clear it atomically, SSE-driven session
  // refetches (triggered by the status→running transition) can re-hydrate
  // stale draft text into the input on the next navigation.
  it("clears conversation pendingPromptText only after the actor accepts the prompt", async () => {
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      pendingPromptText: "draft about to be submitted",
    } as ConversationState);
    vi.mocked(deps.executePromptStream).mockImplementation(async (...args) => {
      expect(
        deps.clearConversationPendingPromptTextIfMatches,
      ).not.toHaveBeenCalled();
      await args[7]?.onAccepted?.();
      return {
        conversationId: "conv-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const response = await handlers.conversationPOST(
      makeRequest({
        prompt: "draft about to be submitted",
        submittedPendingPromptText: "  draft about to be submitted  ",
      }),
      makeConvParams(),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-1",
      "  draft about to be submitted  ",
    );
  });

  it("preserves conversation pendingPromptText when prompt execution fails before acceptance", async () => {
    vi.mocked(deps.executePromptStream).mockRejectedValue(
      new Error("Actor creation failed"),
    );

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "draft about to be submitted" }),
      makeConvParams(),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).not.toHaveBeenCalled();
  });

  it("clears conversation pendingPromptText after accepting a /collab brief", async () => {
    const startMock = vi
      .fn()
      .mockResolvedValue({ workflowId: "wf-clear", status: "started" });
    vi.mocked(deps.getCollaborationManager).mockReturnValue(
      makeMockManager({ start: startMock }),
    );
    vi.mocked(deps.getConversation).mockResolvedValue({
      ...testConversation,
      pendingPromptText: "/collab investigate the regression",
    } as ConversationState);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab investigate the regression" }),
      makeConvParams(),
    );

    expect(response.status).toBe(202);
    expect(
      deps.clearConversationPendingPromptTextIfMatches,
    ).toHaveBeenCalledWith(
      "/projects/my-project",
      "test-session",
      "conv-1",
      "/collab investigate the regression",
    );
  });

  it("preserves a newer autosaved draft when an older submission is accepted", async () => {
    let pendingPromptText = "newer draft";
    vi.mocked(
      deps.clearConversationPendingPromptTextIfMatches,
    ).mockImplementation(
      async (_project, _session, _conversation, expected) => {
        if (pendingPromptText !== expected) return false;
        pendingPromptText = "";
        return true;
      },
    );
    vi.mocked(deps.executePromptStream).mockImplementation(async (...args) => {
      await args[7]?.onAccepted?.();
      return {
        conversationId: "conv-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "older submitted draft" }),
      makeConvParams(),
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(pendingPromptText).toBe("newer draft");
  });

  it("preserves conversation pendingPromptText when /collab start fails", async () => {
    const startMock = vi
      .fn()
      .mockRejectedValue(new Error("config unavailable"));
    vi.mocked(deps.getCollaborationManager).mockReturnValue(
      makeMockManager({ start: startMock }),
    );

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab investigate the regression" }),
      makeConvParams(),
    );

    expect(response.status).toBe(500);
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
  });

  it("returns 409 when another collaboration claims the conversation first", async () => {
    const startMock = vi
      .fn()
      .mockRejectedValue(new CollaborationStartConflictError("conv-1"));
    vi.mocked(deps.getCollaborationManager).mockReturnValue(
      makeMockManager({ start: startMock }),
    );

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "/collab investigate the regression" }),
      makeConvParams(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "COLLABORATION_START_CONFLICT",
    });
  });

  describe("approval-gate chat exception", () => {
    const GATED_CONTEXT_ID = "context-implement";

    function makeGatedSession(input: {
      executionStatus?: GraphWorkflowStatus;
      pendingApproval?: GraphWorkflowPendingApproval;
    }) {
      const execution = createWorkflowExecution({
        status: input.executionStatus ?? "running",
      });
      const contextState = execution.contextStates[GATED_CONTEXT_ID];
      if (!contextState) throw new Error("fixture missing gated context");
      contextState.status = "awaiting_approval";
      contextState.pendingApproval = input.pendingApproval ?? {
        conversationId: "conv-1",
        requestedAt: "2026-06-10T09:00:00.000Z",
        decision: null,
      };
      return sessionStateSchema.parse({
        ...testSession,
        graphWorkflowExecution: execution,
      });
    }

    beforeEach(() => {
      vi.mocked(deps.getConversation).mockResolvedValue({
        ...testConversation,
        role: "iteration",
      } as ConversationState);
    });

    it("accepts chat with a gated iteration conversation while the decision is pending", async () => {
      vi.mocked(deps.getSession).mockResolvedValue(makeGatedSession({}));

      const response = await handlers.conversationPOST(
        makeRequest({ prompt: "Why did you choose this approach?" }),
        makeConvParams(),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });

    it("returns 403 again once an approved decision is recorded", async () => {
      vi.mocked(deps.getSession).mockResolvedValue(
        makeGatedSession({
          pendingApproval: {
            conversationId: "conv-1",
            requestedAt: "2026-06-10T09:00:00.000Z",
            decision: {
              type: "approved",
              decidedAt: "2026-06-10T09:05:00.000Z",
            },
          },
        }),
      );

      const response = await handlers.conversationPOST(
        makeRequest({ prompt: "Hello" }),
        makeConvParams(),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("MANAGED_CONVERSATION");
    });

    it("returns 403 again once a rejected decision is recorded", async () => {
      vi.mocked(deps.getSession).mockResolvedValue(
        makeGatedSession({
          pendingApproval: {
            conversationId: "conv-1",
            requestedAt: "2026-06-10T09:00:00.000Z",
            decision: {
              type: "rejected",
              message: "Please use the existing helper",
              decidedAt: "2026-06-10T09:05:00.000Z",
            },
          },
        }),
      );

      const response = await handlers.conversationPOST(
        makeRequest({ prompt: "Hello" }),
        makeConvParams(),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("MANAGED_CONVERSATION");
    });

    it("returns 403 for a managed conversation that is not the gated one", async () => {
      vi.mocked(deps.getSession).mockResolvedValue(
        makeGatedSession({
          pendingApproval: {
            conversationId: "conv-validator",
            requestedAt: "2026-06-10T09:00:00.000Z",
            decision: null,
          },
        }),
      );

      const response = await handlers.conversationPOST(
        makeRequest({ prompt: "Hello" }),
        makeConvParams(),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("MANAGED_CONVERSATION");
    });

    it("returns 403 when the gating execution is no longer in flight", async () => {
      vi.mocked(deps.getSession).mockResolvedValue(
        makeGatedSession({ executionStatus: "aborted" }),
      );

      const response = await handlers.conversationPOST(
        makeRequest({ prompt: "Hello" }),
        makeConvParams(),
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("MANAGED_CONVERSATION");
    });
  });

  it("does not clear pendingPromptText when the conversation is busy", async () => {
    vi.mocked(deps.isConversationBusy).mockReturnValue(true);

    const response = await handlers.conversationPOST(
      makeRequest({ prompt: "Hello" }),
      makeConvParams(),
    );

    expect(response.status).toBe(409);
    expect(deps.setConversationPendingPromptText).not.toHaveBeenCalled();
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

  it("forwards images with attachmentId + inlineMarkerIndex to executePromptStream on conversation POST", async () => {
    const img1 = {
      attachmentId: "att-1",
      mediaType: "image/png" as const,
      base64Data: "DATA1",
      inlineMarkerIndex: 1,
    };
    const img2 = {
      attachmentId: "att-2",
      mediaType: "image/jpeg" as const,
      base64Data: "DATA2",
      inlineMarkerIndex: 2,
    };

    const response = await handlers.conversationPOST(
      makeRequest({
        prompt: "compare [Image #1] and [Image #2]",
        images: [img1, img2],
      }),
      makeConvParams(),
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
    const forwardedConversationId = callArgs[4];
    const forwardedImages = callArgs[6];
    expect(forwardedConversationId).toBe("conv-1");
    expect(forwardedImages).toEqual([img1, img2]);
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
