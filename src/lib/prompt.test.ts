import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState, ConversationState } from "@/types";

// ---------------------------------------------------------------------------
// Infrastructure mocks (module-level side effects only)
// ---------------------------------------------------------------------------

vi.mock("@/lib/sdk-env", () => ({}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { createPromptExecutor, type PromptDeps } from "./prompt";

// ---------------------------------------------------------------------------
// Mock actor (simulates XState conversation actor for waitForTurnCompletion)
// ---------------------------------------------------------------------------

const mockActor = {
  getSnapshot: vi.fn(() => ({
    value: "idle",
    status: "active" as const,
    context: {},
  })),
  subscribe: vi.fn((callback: (snapshot: unknown) => void) => {
    // Simulate a transition: leave idle -> return to idle
    queueMicrotask(() => {
      callback({ value: "acquiringResources", status: "active" });
      queueMicrotask(() => {
        callback({ value: "idle", status: "active" });
      });
    });
    return { unsubscribe: vi.fn() };
  }),
  send: vi.fn(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-123",
    name: null,
    claudeSessionId: null,
    transcriptPath: null,
    status: "new" as const,
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    source: "cc" as const,
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    role: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "test-session",
    worktreePath: "/projects/repo/.worktrees/test-session",
    branchName: "csm/test-session",
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc" as const,
    objective: null,
    creationMode: "fast" as const,
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    workflow: null,
    workflowHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

function createTestDeps(overrides: Partial<PromptDeps> = {}): PromptDeps {
  const conversation = makeConversation();
  return {
    getConversation: vi.fn().mockResolvedValue(conversation),
    createConversation: vi.fn().mockResolvedValue(conversation),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    ensureConversationActor: vi.fn(async () => mockActor),
    attachPromptStream: vi.fn(),
    detachPromptStream: vi.fn(),
    sendConversationEvent: vi.fn(() => true),
    ...overrides,
  } as PromptDeps;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

let deps: PromptDeps;
let executePromptStream: ReturnType<
  typeof createPromptExecutor
>["executePromptStream"];

beforeEach(() => {
  vi.clearAllMocks();

  // Reset mock actor behavior
  mockActor.getSnapshot.mockReturnValue({
    value: "idle",
    status: "active" as const,
    context: {},
  });
  mockActor.subscribe.mockImplementation(
    (callback: (snapshot: unknown) => void) => {
      queueMicrotask(() => {
        callback({ value: "acquiringResources", status: "active" });
        queueMicrotask(() => {
          callback({ value: "idle", status: "active" });
        });
      });
      return { unsubscribe: vi.fn() };
    },
  );
});

// ===========================================================================
// Tests
// ===========================================================================

describe("executePromptStream (facade)", () => {
  it("returns conversationId for existing conversation", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const result = await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(result.conversationId).toBe("conv-123");
  });

  it("creates a new conversation when no conversationId is provided", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
    );

    expect(deps.createConversation).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
  });

  it("validates existing conversation when conversationId is provided", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(deps.getConversation).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
    );
  });

  it("throws when provided conversationId does not exist", async () => {
    deps = createTestDeps({
      getConversation: vi.fn().mockResolvedValue(null),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await expect(
      executePromptStream(
        "/projects/repo",
        makeSession(),
        "Hello",
        vi.fn(),
        "nonexistent",
      ),
    ).rejects.toThrow("Conversation not found: nonexistent");
  });

  it("ensures a conversation actor exists", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(deps.ensureConversationActor).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
    );
  });

  it("attaches and detaches the SSE stream", async () => {
    deps = createTestDeps();
    const emit = vi.fn();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      emit,
      "conv-123",
    );

    expect(deps.attachPromptStream).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.any(String), // streamId
      emit,
    );

    expect(deps.detachPromptStream).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.any(String), // streamId
    );
  });

  it("sends SUBMIT_PROMPT event to the conversation machine", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello Claude",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { autonomous: true, effort: "high" },
    );

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        promptText: "Hello Claude",
        autonomous: true,
        effort: "high",
      }),
    );
  });

  it("emits done event on successful completion", async () => {
    deps = createTestDeps();
    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      emit,
      "conv-123",
    );

    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("emits error and done when actor subscription errors", async () => {
    mockActor.subscribe.mockImplementation(
      (callback: (snapshot: unknown) => void) => {
        queueMicrotask(() => {
          callback({ value: "acquiringResources", status: "active" });
          queueMicrotask(() => {
            callback({ value: "executing", status: "error" });
          });
        });
        return { unsubscribe: vi.fn() };
      },
    );

    deps = createTestDeps();
    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      emit,
      "conv-123",
    );

    const errorEvent = events.find(([e]) => e === "error");
    expect(errorEvent).toBeTruthy();
    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("detaches stream even when an error occurs", async () => {
    deps = createTestDeps({
      ensureConversationActor: vi
        .fn()
        .mockRejectedValue(new Error("Actor creation failed")),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await expect(
      executePromptStream(
        "/projects/repo",
        makeSession(),
        "Hello",
        vi.fn(),
        "conv-123",
      ),
    ).rejects.toThrow("Actor creation failed");
  });

  it("passes images in the SUBMIT_PROMPT event", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const images = [{ mediaType: "image/png" as const, base64Data: "abc123" }];

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Look at this",
      vi.fn(),
      "conv-123",
      undefined,
      images,
    );

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        images,
      }),
    );
  });
});
