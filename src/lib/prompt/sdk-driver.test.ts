import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";
import type {
  ConversationTurnExecution,
  ConversationTurnProjection,
  ExecuteConversationTurnInput,
} from "@/lib/workflows/conversation/manager";

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
  ConversationCommandDispatcherUnavailableError,
  DEBUG_MODE_INSTRUCTIONS,
  ASK_QUESTION_INSTRUCTIONS,
  ASK_QUESTION_INSTRUCTIONS_ENABLED,
  selectAskQuestionInstructions,
  type PromptDeps,
} from "./sdk-driver";
import {
  createConversationCommandService,
  type ConversationCommandDeps,
} from "@/lib/conversation-commands/service";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

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
  return makeConversationState({
    id: "conv-123",
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });
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
    creationMode: "normal" as const,
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
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

/**
 * Race a promise against a timeout so a hung `executePromptStream` (the bug
 * under test) surfaces as a test failure instead of stalling the whole suite.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

interface LegacyPromptTestDeps {
  ensureConversationActor(...args: unknown[]): Promise<typeof mockActor>;
  attachPromptStream(...args: unknown[]): void;
  detachPromptStream(...args: unknown[]): void;
  sendConversationEvent(...args: unknown[]): boolean;
}

type TestPromptDeps = PromptDeps & LegacyPromptTestDeps;

function projectMockTurn(): ConversationTurnProjection {
  const context = mockActor.getSnapshot().context as {
    totals?: {
      contextTokens?: number | null;
      contextWindowMax?: number | null;
    };
    lastResult?: {
      structuredOutput?: unknown;
      aborted?: boolean;
      compacted?: boolean;
      abortReason?: "timeout" | "user" | "shutdown";
      timeoutMs?: number;
      error?: string | null;
      backgroundWait?: ConversationTurnProjection["backgroundWait"];
    };
    lastError?: string | null;
  };
  return {
    contextTokens: context.totals?.contextTokens ?? null,
    contextWindowMax: context.totals?.contextWindowMax ?? null,
    structuredOutput: context.lastResult?.structuredOutput,
    aborted: context.lastResult?.aborted ?? false,
    compacted: context.lastResult?.compacted ?? false,
    ...(context.lastResult?.abortReason !== undefined
      ? { abortReason: context.lastResult.abortReason }
      : {}),
    ...(context.lastResult?.timeoutMs !== undefined
      ? { timeoutMs: context.lastResult.timeoutMs }
      : {}),
    error: context.lastResult?.error ?? context.lastError ?? null,
    ...(context.lastResult?.backgroundWait !== undefined
      ? { backgroundWait: context.lastResult.backgroundWait }
      : {}),
  };
}

function waitForMockTurnCompletion(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const initial = mockActor.getSnapshot();
    const isSettled = (value: unknown): boolean =>
      value === "idle" ||
      value === "waitingForInput" ||
      value === "debug" ||
      (typeof value === "object" && value !== null && "debug" in value);
    let sawTransition = !isSettled(initial.value);
    const subscription = mockActor.subscribe((snapshotValue) => {
      const snapshot = snapshotValue as {
        value: unknown;
        status: "active" | "done" | "error";
      };
      if (!sawTransition && !isSettled(snapshot.value)) sawTransition = true;
      if (snapshot.status === "error") {
        subscription.unsubscribe();
        reject(new Error("Conversation lifecycle errored"));
        return;
      }
      if (
        snapshot.status === "done" ||
        (sawTransition && isSettled(snapshot.value))
      ) {
        subscription.unsubscribe();
        resolve();
      }
    });
  });
}

function createTestDeps(
  overrides: Partial<TestPromptDeps> = {},
): TestPromptDeps {
  const conversation = makeConversation();
  const deps = {} as TestPromptDeps;
  Object.assign(deps, {
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
    ensureConversationLifecycle: vi.fn(async (...args: unknown[]) => {
      await deps.ensureConversationActor(...args);
    }),
    executeConversationTurn: vi.fn(
      async (
        input: ExecuteConversationTurnInput,
      ): Promise<ConversationTurnExecution> => {
        deps.attachPromptStream(
          input.projectPath,
          input.sessionName,
          input.conversationId,
          input.streamId,
          input.emit,
        );
        try {
          const accepted = deps.sendConversationEvent(
            input.projectPath,
            input.sessionName,
            input.conversationId,
            {
              type: "SUBMIT_PROMPT",
              ...input.turn,
              streamId: input.streamId,
            },
          );
          if (!accepted) {
            return {
              status: "rejected",
              reason: "not_ready",
              result: projectMockTurn(),
            };
          }
          await input.onAccepted?.();
          try {
            await waitForMockTurnCompletion();
            return { status: "completed", result: projectMockTurn() };
          } catch (err) {
            return {
              status: "failed",
              error: err instanceof Error ? err.message : "Prompt failed",
              result: projectMockTurn(),
            };
          }
        } finally {
          deps.detachPromptStream(
            input.projectPath,
            input.sessionName,
            input.conversationId,
            input.streamId,
          );
        }
      },
    ),
  });
  Object.assign(deps, overrides);
  return deps;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

let deps: TestPromptDeps;
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

describe("ASK_QUESTION_INSTRUCTIONS", () => {
  it("is a single well-formed <asking-questions> block", () => {
    expect(ASK_QUESTION_INSTRUCTIONS.startsWith("<asking-questions>")).toBe(
      true,
    );
    expect(ASK_QUESTION_INSTRUCTIONS.endsWith("</asking-questions>")).toBe(
      true,
    );
  });

  it("teaches the async cctl ask protocol, not a deleted in-process tool", () => {
    expect(ASK_QUESTION_INSTRUCTIONS).toContain("cctl ask");
    expect(ASK_QUESTION_INSTRUCTIONS).not.toContain("AskUserQuestion");
  });

  it("teaches end-turn discipline and the answer lifecycle (doc 03 §7)", () => {
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/end your turn/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/handoff note/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/next user message/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toContain("skipped");
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/batch related questions/i);
  });

  it("keeps the disabled/default variant's autonomous-denied guidance (Req 8.4)", () => {
    // Disabled lanes and non-workflow conversations must NOT be told the tool
    // is available; the existing best-judgment guidance stays verbatim.
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/denied for autonomous turns/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/best judgment/i);
  });

  it("advertises the rich option fields the panel renders", () => {
    // The panel renders per-option description, a Suggested badge, and pro/con
    // trade-off lines — agents author the payload freehand, so fields the
    // instructions don't name never get sent.
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/description/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/recommended/i);
    expect(ASK_QUESTION_INSTRUCTIONS).toMatch(/tradeoff/i);
  });
});

describe("ASK_QUESTION_INSTRUCTIONS_ENABLED (workflow lane variant, Req 8.1-8.3)", () => {
  it("is a single well-formed <asking-questions> block", () => {
    expect(
      ASK_QUESTION_INSTRUCTIONS_ENABLED.startsWith("<asking-questions>"),
    ).toBe(true);
    expect(
      ASK_QUESTION_INSTRUCTIONS_ENABLED.endsWith("</asking-questions>"),
    ).toBe(true);
  });

  it("states the tool is available and the full ask protocol (Req 8.1-8.3)", () => {
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toContain("cctl ask");
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/available/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/consequential/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/hard-to-reverse/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/ambiguous/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/batch/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/end your turn/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/resume/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toContain("skipped");
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/best judgment/i);
    // The workflow pauses the context until answered — asking is not free.
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/pause/i);
  });

  it("does not carry the autonomous-denied disclaimer of the disabled variant", () => {
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).not.toMatch(
      /denied for autonomous turns/i,
    );
  });

  it("advertises the rich option fields the panel renders", () => {
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/description/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/recommended/i);
    expect(ASK_QUESTION_INSTRUCTIONS_ENABLED).toMatch(/tradeoff/i);
  });
});

describe("selectAskQuestionInstructions", () => {
  it("returns the enabled variant when askUserQuestionsEnabled is true", () => {
    expect(selectAskQuestionInstructions(true)).toBe(
      ASK_QUESTION_INSTRUCTIONS_ENABLED,
    );
  });

  it("returns the disabled/default variant when false or undefined", () => {
    expect(selectAskQuestionInstructions(false)).toBe(
      ASK_QUESTION_INSTRUCTIONS,
    );
    expect(selectAskQuestionInstructions(undefined)).toBe(
      ASK_QUESTION_INSTRUCTIONS,
    );
  });
});

describe("waitForTurnCompletion — failure during resource acquisition", () => {
  it("resolves (does not hang) and surfaces the error when the turn collapses acquiringResources→idle in a single notification", async () => {
    const timeoutMessage =
      "Query semaphore timeout after 300000ms waiting for slot (label: prompt:test-session)";
    // The actor is already mid-turn (acquiringResources) when waiting begins —
    // SUBMIT_PROMPT was accepted synchronously. A failure during resource
    // acquisition then collapses acquiringResources→finalizingTurn→idle in a
    // single macrostep, so the subscriber observes only the settled `idle`
    // snapshot (no intermediate non-settled notification).
    mockActor.getSnapshot.mockReturnValue({
      value: "acquiringResources",
      status: "active" as const,
      context: { lastError: timeoutMessage },
    });
    mockActor.subscribe.mockImplementation(
      (callback: (snapshot: unknown) => void) => {
        queueMicrotask(() => {
          callback({
            value: "idle",
            status: "active",
            context: { lastError: timeoutMessage },
          });
        });
        return { unsubscribe: vi.fn() };
      },
    );

    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const result = await withTimeout(
      executePromptStream(
        "/projects/repo",
        makeSession(),
        "Hello",
        vi.fn(),
        "conv-123",
      ),
      1000,
    );

    expect(result.error).toContain("Query semaphore timeout");
  });
});

describe("waitForTurnCompletion — turn ends parked on a user question", () => {
  it("resolves (does not hang) when the turn settles into waitingForInput after an ask", async () => {
    // A workflow/autonomous agent that ends its turn via `cctl ask` leaves the
    // conversation machine in the top-level `waitingForInput` state — one of the
    // three settled, turn-claimable boundaries the machine documents (idle |
    // waitingForInput | debug.*). The turn IS complete; executePromptStream must
    // return so the workflow can run its post-turn park check. Before the fix,
    // isSettled omitted waitingForInput and the wait hung forever.
    mockActor.getSnapshot.mockReturnValue({
      value: "acquiringResources",
      status: "active" as const,
      context: {},
    });
    mockActor.subscribe.mockImplementation(
      (callback: (snapshot: unknown) => void) => {
        queueMicrotask(() => {
          callback({ value: "generating", status: "active" });
          queueMicrotask(() => {
            callback({ value: "waitingForInput", status: "active" });
          });
        });
        return { unsubscribe: vi.fn() };
      },
    );

    deps = createTestDeps();
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const result = await withTimeout(
      executePromptStream(
        "/projects/repo",
        makeSession(),
        "Which theme should we use?",
        vi.fn(),
        "conv-123",
      ),
      1000,
    );

    expect(result.conversationId).toBe("conv-123");
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
      { autonomous: true, effort: "high", codexFastMode: true },
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
        codexFastMode: true,
      }),
    );
  });

  it("notifies the caller only after SUBMIT_PROMPT is accepted", async () => {
    const onAccepted = vi.fn();
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello Claude",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { onAccepted },
    );

    expect(deps.sendConversationEvent).toHaveBeenCalled();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(deps.sendConversationEvent).mock.invocationCallOrder[0],
    ).toBeLessThan(onAccepted.mock.invocationCallOrder[0]!);
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

  it("fails fast with an error result instead of hanging when sendConversationEvent rejects the prompt", async () => {
    // The actor is wedged (e.g. stuck in externalExecuting after the SDK
    // subprocess died): it never fires a settling transition, so reaching
    // waitForTurnCompletion would hang forever.
    mockActor.getSnapshot.mockReturnValue({
      value: "externalExecuting",
      status: "active" as const,
      context: {},
    });
    mockActor.subscribe.mockImplementation(() => ({ unsubscribe: vi.fn() }));

    deps = createTestDeps({ sendConversationEvent: vi.fn(() => false) });
    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);
    const executor = createPromptExecutor(deps);

    const onAccepted = vi.fn();
    const result = await withTimeout(
      executor.executePromptStream(
        "/projects/repo",
        makeSession(),
        "Hello",
        emit,
        "conv-123",
        undefined,
        undefined,
        { onAccepted },
      ),
      1000,
    );

    expect(deps.sendConversationEvent).toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(events.find(([e]) => e === "error")).toBeTruthy();
    expect(events.find(([e]) => e === "done")).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
    // The SSE stream is still torn down on the fail-fast path.
    expect(deps.detachPromptStream).toHaveBeenCalled();
  });

  it("detaches stream even when an error occurs", async () => {
    const onAccepted = vi.fn();
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
        undefined,
        undefined,
        { onAccepted },
      ),
    ).rejects.toThrow("Actor creation failed");
    expect(onAccepted).not.toHaveBeenCalled();
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
                id: "transient-tool",
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
              id: "transient-tool",
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

  it("maps compacted=true from the actor snapshot's lastResult", async () => {
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
            aborted: false,
            compacted: true,
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

    expect(result.compacted).toBe(true);
  });

  it("defaults compacted to false when the actor snapshot omits it", async () => {
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

    expect(result.compacted).toBe(false);
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

  it("forwards workflow readiness waiting into the conversation lifecycle", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
      "conv-123",
      undefined,
      undefined,
      { waitForConversationReady: true },
    );

    expect(deps.executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ waitUntilReady: true }),
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
    const onAccepted = vi.fn();
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
        undefined,
        { onAccepted },
      ),
    ).rejects.toThrow(ModelEffortValidationError);
    expect(onAccepted).not.toHaveBeenCalled();
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
  // `hasCollabPrefix` / `stripCollabPrefix` unit coverage lives with their
  // owner in `@/lib/conversation-commands/parse`.
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

    it("dispatches /collab when the brief begins on the next line", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-newline" });
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab\nbuild the migration plan",
        vi.fn(),
        "conv-123",
      );

      expect(dispatchCollabStart).toHaveBeenCalledWith(
        expect.objectContaining({ brief: "build the migration plan" }),
      );
      expect(deps.sendConversationEvent).not.toHaveBeenCalled();
    });

    it("forwards ordered images through the session-level /collab dispatcher", async () => {
      const dispatchCollabStart = vi
        .fn()
        .mockResolvedValue({ workflowId: "wf-images" });
      deps = createTestDeps({ dispatchCollabStart });
      const executor = createPromptExecutor(deps);
      executePromptStream = executor.executePromptStream;
      const images = [
        {
          attachmentId: "strip",
          mediaType: "image/png" as const,
          base64Data: "strip-data",
        },
        {
          attachmentId: "inline",
          mediaType: "image/jpeg" as const,
          base64Data: "inline-data",
          inlineMarkerIndex: 1,
        },
      ];

      await executePromptStream(
        "/projects/repo",
        makeSession(),
        "/collab compare [Image #1]",
        vi.fn(),
        "conv-123",
        undefined,
        images,
      );

      expect(dispatchCollabStart).toHaveBeenCalledWith(
        expect.objectContaining({ images }),
      );
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

// ===========================================================================
// Conversation command interception (/commit, /merge)
// ===========================================================================

describe("conversation command interception", () => {
  function makeCommandDeps(
    overrides: Partial<ConversationCommandDeps> = {},
  ): ConversationCommandDeps {
    return {
      getSession: vi.fn(async () =>
        sessionStateSchema.parse({
          sessionName: "test-session",
          worktreePath: "/projects/repo/.worktrees/test-session",
          branchName: "csm/test-session",
          createdAt: "2024-01-01T00:00:00Z",
          lastActivityAt: "2024-01-01T00:00:00Z",
        }),
      ),
      hasActiveJob: vi.fn(() => false),
      hasUncommittedChanges: vi.fn(async () => true),
      collectChangeSummary: vi.fn(async () => " M src/index.ts"),
      resolveMergeTarget: vi.fn(async () => ({
        targetBranch: "main",
        targetWorktreePath: null,
      })),
      executeWorkflowTaskRun: vi.fn(async () => ({
        kind: "structured" as const,
        structuredOutput: { message: "Add API eligibility checks" },
        text: "",
        usage: {
          costUsd: null,
          durationMs: null,
          contextTokens: null,
          contextWindowMax: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
        },
        backendRef: null,
        continuationDisposition: "retain" as const,
      })),
      dispatchCommitJob: vi.fn(() => ({
        ok: true as const,
        value: { jobId: "job-commit-1" },
      })),
      dispatchMergeJob: vi.fn(() => ({
        ok: true as const,
        value: { jobId: "job-merge-1" },
      })),
      dispatchRebaseJob: vi.fn(() => ({
        ok: true as const,
        value: { jobId: "job-rebase-1" },
      })),
      appendNotice: vi.fn(async () => {}),
      beginAlignmentDraft: vi.fn(async () => ({
        authoringPrompt: "draft the charter",
        draftId: "draft-1",
      })),
      enqueueAuthoringTurn: vi.fn(async () => {}),
      runTicketCommand: vi.fn(async () => ({
        status: "created" as const,
        identifier: "repo#1",
        confirmationPersisted: true,
      })),
      getConversationRole: vi.fn(async () => null),
      ...overrides,
    };
  }

  it("invokes the command service for /commit and never enters the normal turn flow (integration)", async () => {
    const commandDeps = makeCommandDeps();
    const service = createConversationCommandService(commandDeps);
    const callOrder: string[] = [];
    deps = createTestDeps({
      dispatchConversationCommand: async (input) => {
        const outcome = await service.run(input);
        callOrder.push("service-resolved");
        return outcome;
      },
    });
    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => {
      callOrder.push(`emit:${event}`);
      events.push([event, data]);
    };
    const executor = createPromptExecutor(deps);

    const result = await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/commit focus on the API surface",
      emit,
      "conv-123",
    );

    // (a) service ran end-to-end: generation turn + commit job dispatch
    expect(commandDeps.executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    expect(commandDeps.dispatchCommitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/projects/repo",
        sessionName: "test-session",
        message: "Add API eligibility checks",
      }),
    );
    // (b) normal SUBMIT_PROMPT flow never entered — no actor, no lock path
    expect(deps.ensureConversationActor).not.toHaveBeenCalled();
    expect(deps.sendConversationEvent).not.toHaveBeenCalled();
    expect(deps.attachPromptStream).not.toHaveBeenCalled();
    // (e) done emitted only after the awaited service completed
    expect(callOrder).toEqual(["service-resolved", "emit:done"]);
    expect(events.find(([e]) => e === "done")).toBeTruthy();
    expect(result).toEqual({
      conversationId: "conv-123",
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
    });
  });

  it("passes the submitted model and effort with the command to the dispatcher", async () => {
    const dispatchConversationCommand = vi.fn(async () => ({
      status: "dispatched" as const,
      jobId: "job-1",
      usedFallback: false,
    }));
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/merge keep it short",
      vi.fn(),
      "conv-123",
      "gpt-5.6-sol",
      undefined,
      { effort: "ultra", backend: "codex" },
    );

    expect(dispatchConversationCommand).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "test-session",
      conversationId: "conv-123",
      parsed: { command: "merge", hint: "keep it short" },
      rawText: "/merge keep it short",
      modelId: "gpt-5.6-sol",
      effort: "ultra",
    });
  });

  it("reports a committed ticket identifier when its transcript confirmation could not be persisted", async () => {
    const dispatchConversationCommand = vi.fn(async () => ({
      status: "ticket_created" as const,
      identifier: "repo#12",
      confirmationPersisted: false,
    }));
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);
    const events: Array<[string, unknown]> = [];

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/ticket retry bug",
      (event, data) => events.push([event, data]),
      "conv-123",
    );

    expect(events).toContainEqual([
      "error",
      {
        message:
          "Created ticket repo#12, but its confirmation could not be saved to this conversation.",
      },
    ]);
    expect(events.at(-1)).toEqual(["done", {}]);
  });

  it("surfaces the root ticket failure when its failure notice could not be persisted", async () => {
    const dispatchConversationCommand = vi.fn(async () => ({
      status: "ticket_failed" as const,
      reason: "generation turn failed: turn timed out",
      failureNoticePersisted: false,
    }));
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);
    const events: Array<[string, unknown]> = [];

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/ticket retry bug",
      (event, data) => events.push([event, data]),
      "conv-123",
    );

    expect(dispatchConversationCommand).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual([
      "error",
      {
        message:
          "/ticket failed: generation turn failed: turn timed out — no ticket was created. The failure notice could not be saved to this conversation.",
      },
    ]);
    expect(events.at(-1)).toEqual(["done", {}]);
    expect(deps.ensureConversationActor).not.toHaveBeenCalled();
  });

  it("maps the project sentinel session to sessionName null with noticeSessionName scope", async () => {
    const dispatchConversationCommand = vi.fn(async () => ({
      status: "rejected" as const,
      reason: "no-session" as const,
    }));
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession({
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        worktreePath: "/projects/repo",
        branchName: "main",
      }),
      "/commit",
      vi.fn(),
      "conv-123",
    );

    expect(dispatchConversationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: null,
        noticeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        parsed: { command: "commit", hint: "" },
      }),
    );
    expect(deps.sendConversationEvent).not.toHaveBeenCalled();
  });

  it("creates a conversation when a command arrives without conversationId", async () => {
    const dispatchConversationCommand = vi.fn(async () => ({
      status: "dispatched" as const,
      jobId: "job-1",
      usedFallback: false,
    }));
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    const result = await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/commit",
      vi.fn(),
    );

    expect(deps.createConversation).toHaveBeenCalled();
    expect(dispatchConversationCommand).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-123" }),
    );
    expect(result.conversationId).toBe("conv-123");
  });

  it("does not intercept commands appearing mid-prompt or near-misses", async () => {
    const dispatchConversationCommand = vi.fn();
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "please /commit this later",
      vi.fn(),
      "conv-123",
    );
    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/committed the change",
      vi.fn(),
      "conv-123",
    );

    expect(dispatchConversationCommand).not.toHaveBeenCalled();
    expect(deps.sendConversationEvent).toHaveBeenCalledTimes(2);
  });

  it("leaves plain prompts on the normal SUBMIT_PROMPT flow", async () => {
    const dispatchConversationCommand = vi.fn();
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "refactor the auth flow",
      vi.fn(),
      "conv-123",
    );

    expect(dispatchConversationCommand).not.toHaveBeenCalled();
    expect(deps.ensureConversationActor).toHaveBeenCalled();
    expect(deps.sendConversationEvent).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
      "conv-123",
      expect.objectContaining({ type: "SUBMIT_PROMPT" }),
    );
  });

  it("starts /spec in a conversation and carries the native command to the SDK turn", async () => {
    const dispatchConversationCommand = vi.fn();
    deps = createTestDeps({ dispatchConversationCommand });
    const executor = createPromptExecutor(deps);

    const result = await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/spec durable audit log",
      vi.fn(),
    );

    expect(result.conversationId).toBe("conv-123");
    expect(deps.createConversation).toHaveBeenCalledTimes(1);
    expect(dispatchConversationCommand).not.toHaveBeenCalled();
    expect(deps.executeConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-123",
        turn: expect.objectContaining({
          promptText: "/spec durable audit log",
        }),
      }),
    );
  });

  it("leaves /collab on the collaboration dispatcher, not the command service", async () => {
    const dispatchConversationCommand = vi.fn();
    const dispatchCollabStart = vi
      .fn()
      .mockResolvedValue({ workflowId: "wf-9" });
    deps = createTestDeps({ dispatchConversationCommand, dispatchCollabStart });
    const executor = createPromptExecutor(deps);

    await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/collab plan the rollout",
      vi.fn(),
      "conv-123",
    );

    expect(dispatchConversationCommand).not.toHaveBeenCalled();
    expect(dispatchCollabStart).toHaveBeenCalledTimes(1);
  });

  it("emits error and done when the command dispatch throws", async () => {
    const dispatchConversationCommand = vi
      .fn()
      .mockRejectedValue(new Error("command boom"));
    deps = createTestDeps({ dispatchConversationCommand });
    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);
    const executor = createPromptExecutor(deps);

    const result = await executor.executePromptStream(
      "/projects/repo",
      makeSession(),
      "/merge",
      emit,
      "conv-123",
    );

    expect(events.find(([e]) => e === "error")?.[1]).toMatchObject({
      message: "command boom",
    });
    expect(events.find(([e]) => e === "done")).toBeTruthy();
    expect(result.error).toBe("command boom");
    expect(deps.sendConversationEvent).not.toHaveBeenCalled();
  });

  it("throws when a command arrives but no dispatcher is configured", async () => {
    deps = createTestDeps();
    const executor = createPromptExecutor(deps);

    await expect(
      executor.executePromptStream(
        "/projects/repo",
        makeSession(),
        "/commit",
        vi.fn(),
        "conv-123",
      ),
    ).rejects.toBeInstanceOf(ConversationCommandDispatcherUnavailableError);
    expect(deps.sendConversationEvent).not.toHaveBeenCalled();
  });
});
