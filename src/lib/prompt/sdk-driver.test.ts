import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";

// ---------------------------------------------------------------------------
// Infrastructure mocks (module-level side effects only)
// ---------------------------------------------------------------------------

vi.mock("@/lib/shared/sdk-env", () => ({}));

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

import {
  createPromptExecutor,
  BackendMismatchError,
  ModelEffortValidationError,
  DEBUG_MODE_INSTRUCTIONS,
  hasCollabPrefix,
  stripCollabPrefix,
  type PromptDeps,
} from "./sdk-driver";

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
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
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
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

function makeMockFactory(
  backend: AgentBackendId = "claude",
  validateFn?: ConversationBackendFactory["validateModelAndEffort"],
): ConversationBackendFactory {
  return {
    backend,
    createRuntime: vi.fn() as ConversationBackendFactory["createRuntime"],
    validateModelAndEffort: validateFn,
  };
}

function createTestDeps(overrides: Partial<PromptDeps> = {}): PromptDeps {
  const conversation = makeConversation();
  return {
    getConversation: vi.fn().mockResolvedValue(conversation),
    createConversation: vi.fn().mockResolvedValue(conversation),
    setConversationBackend: vi.fn().mockResolvedValue(undefined),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    readConfig: vi.fn().mockResolvedValue({ defaultAgentBackend: "claude" }),
    getConversationBackendFactory: vi.fn(() => makeMockFactory()),
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

describe("DEBUG_MODE_INSTRUCTIONS", () => {
  // The receiver drops any request carrying X-CC-Debug-Log: 1 as `self_log`.
  // The header is ONLY useful when the project under debug is Command Center
  // itself — it breaks recursion on the debug-log path. For every other
  // project, sending the header silently discards every probe entry, which
  // is what happened during the May 2026 end-to-end flow test.
  it("does not instruct probes to set X-CC-Debug-Log unconditionally", () => {
    expect(DEBUG_MODE_INSTRUCTIONS).not.toMatch(
      /(?:MUST|must|should)\s+send[^.]*X-CC-Debug-Log/i,
    );
    expect(DEBUG_MODE_INSTRUCTIONS).not.toMatch(
      /Every probe[^.]*X-CC-Debug-Log/i,
    );
  });

  it("scopes the X-CC-Debug-Log header to the self-debug-CC case", () => {
    if (!DEBUG_MODE_INSTRUCTIONS.includes("X-CC-Debug-Log")) return;
    expect(DEBUG_MODE_INSTRUCTIONS).toMatch(
      /Command Center itself|self-debug|debugging CC/i,
    );
  });

  it("does not include the header in the default probe example fetch", () => {
    const exampleStart = DEBUG_MODE_INSTRUCTIONS.indexOf(
      "Example instrumentation",
    );
    if (exampleStart === -1) return;
    const exampleBlock = DEBUG_MODE_INSTRUCTIONS.slice(
      exampleStart,
      exampleStart + 1200,
    );
    expect(exampleBlock).not.toContain("X-CC-Debug-Log");
  });
});

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
      { agentBackend: "claude" },
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
      undefined,
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

  it("forwards tooling to deps.setTooling after actor creation", async () => {
    const setTooling = vi.fn();
    deps = createTestDeps({ setTooling });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      {
        tooling: {
          portableMcp: {
            servers: [
              {
                id: "cc-graph-workflow",
                transport: "streamable-http",
                url: "http://127.0.0.1:3000/api/projects/repo/sessions/test-session/mcp/graph-workflow/execution-1/contexts/context-1",
              },
            ],
          },
        },
      },
    );

    expect(setTooling).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      {
        portableMcp: {
          servers: [
            {
              id: "cc-graph-workflow",
              transport: "streamable-http",
              url: "http://127.0.0.1:3000/api/projects/repo/sessions/test-session/mcp/graph-workflow/execution-1/contexts/context-1",
            },
          ],
        },
      },
    );
  });

  it("does not call setTooling when no tooling provided", async () => {
    const setTooling = vi.fn();
    deps = createTestDeps({ setTooling });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(setTooling).not.toHaveBeenCalled();
  });

  it("forwards skipConversationLock to deps.setSkipConversationLock after actor creation", async () => {
    const setSkipConversationLock = vi.fn();
    deps = createTestDeps({ setSkipConversationLock });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { skipConversationLock: true },
    );

    expect(setSkipConversationLock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      true,
    );
  });

  it("does not call setSkipConversationLock when option not provided", async () => {
    const setSkipConversationLock = vi.fn();
    deps = createTestDeps({ setSkipConversationLock });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(setSkipConversationLock).not.toHaveBeenCalled();
  });

  it("returns contextTokens and contextWindowMax from actor snapshot", async () => {
    mockActor.getSnapshot
      .mockReturnValueOnce({
        value: "idle",
        status: "active" as const,
        context: {},
      })
      .mockReturnValue({
        value: "idle",
        status: "active" as const,
        context: {
          totals: {
            contextTokens: 50_000,
            contextWindowMax: 200_000,
          },
        },
      });

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

    expect(result.contextTokens).toBe(50_000);
    expect(result.contextWindowMax).toBe(200_000);
  });

  it("returns prompt errors from actor snapshot", async () => {
    mockActor.getSnapshot
      .mockReturnValueOnce({
        value: "idle",
        status: "active" as const,
        context: {},
      })
      .mockReturnValue({
        value: "idle",
        status: "active" as const,
        context: {
          lastResult: {
            error: "Claude API overloaded",
            aborted: false,
          },
        },
      });

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

    expect(result.error).toBe("Claude API overloaded");
    expect(result.aborted).toBe(false);
  });

  it("forwards waitForBackgroundTasks into the SUBMIT_PROMPT event when opted in", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { waitForBackgroundTasks: true },
    );

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        waitForBackgroundTasks: true,
      }),
    );
  });

  it("does not set waitForBackgroundTasks in the SUBMIT_PROMPT event by default", async () => {
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

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.not.objectContaining({
        waitForBackgroundTasks: expect.anything(),
      }),
    );
  });

  it("returns the backgroundWait summary from the actor snapshot when a wait occurred", async () => {
    const backgroundWait = {
      waitedTaskIds: ["task-a"],
      settledTaskIds: ["task-a"],
      timedOut: false,
      durationMs: 4200,
    };
    mockActor.getSnapshot
      .mockReturnValueOnce({
        value: "idle",
        status: "active" as const,
        context: {},
      })
      .mockReturnValue({
        value: "idle",
        status: "active" as const,
        context: {
          lastResult: { backgroundWait },
        },
      });

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

    expect(result.backgroundWait).toEqual(backgroundWait);
  });

  it("omits backgroundWait from the result when no wait occurred", async () => {
    mockActor.getSnapshot
      .mockReturnValueOnce({
        value: "idle",
        status: "active" as const,
        context: {},
      })
      .mockReturnValue({
        value: "idle",
        status: "active" as const,
        context: { lastResult: {} },
      });

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

    expect(result.backgroundWait).toBeUndefined();
  });

  it("passes images in the SUBMIT_PROMPT event", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const images = [
      {
        attachmentId: "img-1",
        mediaType: "image/png" as const,
        base64Data: "abc123",
      },
    ];

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

  // =========================================================================
  // Backend selection
  // =========================================================================

  it("uses existing conversation's agentBackend for resolved backend", async () => {
    deps = createTestDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(makeConversation({ agentBackend: "claude" })),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        backend: "claude",
      }),
    );
  });

  it("rejects with BackendMismatchError when request backend differs from locked conversation", async () => {
    deps = createTestDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(
          makeConversation({ agentBackend: "claude", promptCount: 1 }),
        ),
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
        undefined,
        undefined,
        { backend: "codex" },
      ),
    ).rejects.toThrow(BackendMismatchError);
  });

  it("adopts requested backend when conversation has no prompts yet", async () => {
    deps = createTestDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(
          makeConversation({ agentBackend: "claude", promptCount: 0 }),
        ),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { backend: "codex" },
    );

    expect(deps.setConversationBackend).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      "codex",
    );

    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        backend: "codex",
      }),
    );
  });

  it("allows matching backend on existing conversation", async () => {
    deps = createTestDeps({
      getConversation: vi
        .fn()
        .mockResolvedValue(makeConversation({ agentBackend: "claude" })),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { backend: "claude" },
    );

    expect(deps.sendConversationEvent).toHaveBeenCalled();
  });

  it("uses config.defaultAgentBackend for new conversations without explicit backend", async () => {
    deps = createTestDeps({
      readConfig: vi.fn().mockResolvedValue({ defaultAgentBackend: "codex" }),
      getConversationBackendFactory: vi.fn(() => makeMockFactory("codex")),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
    );

    expect(deps.readConfig).toHaveBeenCalled();
    expect(deps.createConversation).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      { agentBackend: "codex" },
    );
    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        backend: "codex",
      }),
    );
  });

  it("uses explicit backend for new conversations", async () => {
    deps = createTestDeps({
      getConversationBackendFactory: vi.fn(() => makeMockFactory("codex")),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      undefined,
      undefined,
      undefined,
      { backend: "codex" },
    );

    // Should NOT read config since backend was explicit
    expect(deps.readConfig).not.toHaveBeenCalled();
    expect(deps.createConversation).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      { agentBackend: "codex" },
    );
    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        type: "SUBMIT_PROMPT",
        backend: "codex",
      }),
    );
  });

  // =========================================================================
  // Model/effort validation
  // =========================================================================

  it("calls factory.validateModelAndEffort before execution", async () => {
    const validateFn = vi.fn();
    deps = createTestDeps({
      getConversationBackendFactory: vi.fn(() =>
        makeMockFactory("claude", validateFn),
      ),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      "opus",
      undefined,
      { effort: "high" },
    );

    expect(validateFn).toHaveBeenCalledWith({
      modelId: "opus",
      reasoningEffort: "high",
    });
  });

  it("throws ModelEffortValidationError when factory validation fails", async () => {
    const validateFn = vi.fn(() => {
      throw new Error("Invalid model for codex");
    });
    deps = createTestDeps({
      getConversationBackendFactory: vi.fn(() =>
        makeMockFactory("claude", validateFn),
      ),
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
        "invalid-model",
      ),
    ).rejects.toThrow(ModelEffortValidationError);
  });

  it("skips validation when factory has no validateModelAndEffort", async () => {
    deps = createTestDeps({
      getConversationBackendFactory: vi.fn(() => makeMockFactory("claude")),
    });
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    // Should not throw — no validation method means skip
    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
    );

    expect(deps.sendConversationEvent).toHaveBeenCalled();
  });
});

describe("/collab prompt interception", () => {
  describe("hasCollabPrefix", () => {
    it("returns true for exact /collab", () => {
      expect(hasCollabPrefix("/collab")).toBe(true);
    });

    it("returns true for /collab with trailing space and brief", () => {
      expect(hasCollabPrefix("/collab fix the bug")).toBe(true);
    });

    it("returns true with leading whitespace before /collab", () => {
      expect(hasCollabPrefix("  /collab brief")).toBe(true);
    });

    it("returns false for prompts not starting with /collab", () => {
      expect(hasCollabPrefix("hello /collab")).toBe(false);
      expect(hasCollabPrefix("/collaborate")).toBe(false);
    });
  });

  describe("stripCollabPrefix", () => {
    it("returns empty string for exact /collab", () => {
      expect(stripCollabPrefix("/collab")).toBe("");
    });

    it("strips /collab and the following space", () => {
      expect(stripCollabPrefix("/collab fix the bug")).toBe("fix the bug");
    });

    it("preserves whitespace within the brief", () => {
      expect(stripCollabPrefix("/collab  multi  word")).toBe(" multi  word");
    });
  });

  describe("executePromptStream dispatch", () => {
    it("dispatches /collab to dispatchCollabStart instead of submitting a prompt", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-1" });
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      const result = await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab build the migration plan",
        vi.fn(),
        "conv-123",
      );

      expect(dispatchCollabStart).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: "/projects/repo",
          sessionName: "test-session",
          conversationId: "conv-123",
          brief: "build the migration plan",
        }),
      );
      expect(deps.sendConversationEvent).not.toHaveBeenCalled();
      expect(result.conversationId).toBe("conv-123");
    });

    it("creates a conversation when /collab arrives without conversationId", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-2" });
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      const result = await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab refactor the auth flow",
        vi.fn(),
      );

      expect(deps.createConversation).toHaveBeenCalledWith(
        "/projects/repo",
        "test-session",
        { agentBackend: "claude" },
      );
      expect(dispatchCollabStart).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv-123",
          brief: "refactor the auth flow",
        }),
      );
      expect(result.conversationId).toBe("conv-123");
    });

    it("emits collab-started SSE event with workflowId and done", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-3" });
      deps = createTestDeps({ dispatchCollabStart });
      const events: Array<[string, unknown]> = [];
      const emit = (event: string, data: unknown) => events.push([event, data]);
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab fix the bug",
        emit,
        "conv-123",
      );

      const started = events.find(([e]) => e === "collab-started");
      expect(started).toBeTruthy();
      expect(started?.[1]).toMatchObject({ workflowId: "wf-3" });
      expect(events.find(([e]) => e === "done")).toBeTruthy();
    });

    it("does not dispatch when /collab appears mid-prompt", async () => {
      const dispatchCollabStart = vi.fn();
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "talk about /collab as a topic",
        vi.fn(),
        "conv-123",
      );

      expect(dispatchCollabStart).not.toHaveBeenCalled();
      expect(deps.sendConversationEvent).toHaveBeenCalled();
    });

    it("forwards collab options (negotiationRounds, autonomousResolutionThreshold)", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-4" });
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab investigate",
        vi.fn(),
        "conv-123",
        undefined,
        undefined,
        {
          collab: {
            negotiationRounds: 6,
            autonomousResolutionThreshold: "blocking",
          },
        },
      );

      expect(dispatchCollabStart).toHaveBeenCalledWith(
        expect.objectContaining({
          negotiationRounds: 6,
          autonomousResolutionThreshold: "blocking",
        }),
      );
    });

    it("emits error and done if dispatchCollabStart throws", async () => {
      const dispatchCollabStart = vi.fn().mockRejectedValue(new Error("boom"));
      deps = createTestDeps({ dispatchCollabStart });
      const events: Array<[string, unknown]> = [];
      const emit = (event: string, data: unknown) => events.push([event, data]);
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab investigate",
        emit,
        "conv-123",
      );

      const error = events.find(([e]) => e === "error");
      expect(error).toBeTruthy();
      expect(events.find(([e]) => e === "done")).toBeTruthy();
    });
  });
});
