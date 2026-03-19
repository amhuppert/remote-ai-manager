import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState, ConversationState } from "@/types";

// ---------------------------------------------------------------------------
// Mock sdk-env side effect
// ---------------------------------------------------------------------------

vi.mock("@/lib/sdk-env", () => ({}));

// ---------------------------------------------------------------------------
// Import module under test — use factory for DI
// ---------------------------------------------------------------------------
import { createPromptExecutor, type PromptDeps } from "./prompt";
import type { QuerySession, TurnResult, TurnEmit } from "./query-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConversation(overrides: Record<string, unknown> = {}) {
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
    workflow: null,
    workflowHistory: [],
    ...overrides,
  };
}

/**
 * Create a mock QuerySession whose sendPrompt processes messages via the emit
 * callback and resolves with a TurnResult.
 */
function createMockQuerySession(
  messages: Record<string, unknown>[],
  turnResult?: Partial<TurnResult>,
): QuerySession {
  const defaultResult: TurnResult = {
    sessionId: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    contextTokens: null,
    contextWindow: null,
    contentBlocks: [],
    aborted: false,
    error: null,
    ...turnResult,
  };

  const mockQuery = {
    streamInput: vi.fn(),
    close: vi.fn(),
    [Symbol.asyncIterator]: vi.fn(),
  };

  return {
    status: "alive" as const,
    conversationId: "conv-123",
    query: mockQuery as never,
    currentTurnOptions: null,
    sendPrompt: vi.fn(
      async (_prompt: string, emit: TurnEmit): Promise<TurnResult> => {
        // Deliver messages via emit so processMessage handles them
        for (const msg of messages) {
          await emit("__raw_message", msg);
        }
        return defaultResult;
      },
    ),
    close: vi.fn(),
  };
}

const defaultConfig = {
  baseDir: "/tmp/projects",
  ignorePatterns: [],
  stateFilePath: "/tmp/cc/state.json",
  claudeTimeoutMs: 300_000,
  maxTurns: 50,
};

// ---------------------------------------------------------------------------
// Test deps factory
// ---------------------------------------------------------------------------

let updateSnapshots: SessionState[];

function createTestDeps(mockQuerySession?: QuerySession): PromptDeps {
  const conversation = makeConversation();
  const session = makeSession();
  session.conversations = [conversation];

  const mutateConversationMock = vi
    .fn()
    .mockImplementation(
      async (
        _path: string,
        _sessName: string,
        convId: string,
        _label: string,
        mutate: (c: ConversationState) => void,
      ) => {
        const c = session.conversations.find(
          (conv: ConversationState) => conv.id === convId,
        );
        if (!c) return;
        await mutate(c);
        c.lastActivityAt = new Date().toISOString();
        session.lastActivityAt = new Date().toISOString();
        updateSnapshots.push(JSON.parse(JSON.stringify(session)));
      },
    );

  return {
    readConfig: vi.fn().mockResolvedValue(defaultConfig),
    mutateConversation: mutateConversationMock,
    acquireSessionLock: vi.fn().mockReturnValue(vi.fn()),
    getConversation: vi.fn().mockResolvedValue(conversation),
    createConversation: vi.fn().mockResolvedValue(conversation),
    safeAppendTranscriptEntry: vi.fn().mockResolvedValue(undefined),
    getTranscriptPath: vi
      .fn()
      .mockResolvedValue("/tmp/cc/transcripts/conv-123.jsonl"),
    externalizeImageBlocks: vi
      .fn()
      .mockImplementation((_id: string, blocks: unknown) =>
        Promise.resolve(blocks),
      ),
    broadcast: vi.fn(),
    registerQuestion: vi.fn(),
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
    registerQuery: vi.fn(),
    unregisterQuery: vi.fn(),
    acquireQuerySlot: vi.fn().mockResolvedValue(vi.fn()),
    createInitToolServer: vi.fn(() => ({
      __mock: true,
    })) as unknown as PromptDeps["createInitToolServer"],
    createNotificationToolServer: vi.fn(() => ({
      __mock: true,
    })) as unknown as PromptDeps["createNotificationToolServer"],
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    buildChildEnv: vi.fn(() => ({})) as unknown as PromptDeps["buildChildEnv"],
    getSessionFromRegistry: vi
      .fn()
      .mockReturnValue(mockQuerySession ?? undefined),
    createQuerySession: vi
      .fn()
      .mockReturnValue(mockQuerySession ?? createMockQuerySession([])),
  };
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
  updateSnapshots = [];
});

// ===========================================================================
// Tests
// ===========================================================================

describe("executePromptStream", () => {
  it("emits init event from system init message", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "system",
          subtype: "init",
          session_id: "sess-123",
          uuid: "u1",
        },
      ],
      { sessionId: "sess-123" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello Claude",
      emit,
    );

    expect(events.find(([e]) => e === "init")).toEqual([
      "init",
      { sessionId: "sess-123" },
    ]);
  });

  it("emits content events for text blocks", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u1",
          message: {
            content: [{ type: "text", text: "Hello!" }],
          },
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "Hi", emit);

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({ type: "text", text: "Hello!" });
  });

  it("emits content events for tool_use blocks", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u1",
          message: {
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Read a.ts",
      emit,
    );

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({
      type: "tool_use",
      name: "Read",
      input: { file_path: "a.ts" },
    });
  });

  it("emits result event for successful result", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u1",
          message: { content: [{ type: "text", text: "Done." }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          uuid: "u2",
          total_cost_usd: 0.05,
          duration_ms: 1200,
          num_turns: 3,
          result: "Done.",
          is_error: false,
        },
      ],
      { sessionId: "sess-1", costUsd: 0.05, durationMs: 1200, numTurns: 3 },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const resultEvent = events.find(([e]) => e === "result");
    expect(resultEvent).toBeTruthy();
    expect(resultEvent![1]).toEqual({
      sessionId: "sess-1",
      costUsd: 0.05,
      numTurns: 3,
    });
  });

  it("emits error event for error result", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "result",
          subtype: "error_max_turns",
          session_id: "sess-1",
          uuid: "u1",
          total_cost_usd: 0.1,
          duration_ms: 5000,
          num_turns: 50,
          is_error: true,
          errors: [],
        },
      ],
      { sessionId: "sess-1", costUsd: 0.1, numTurns: 50, error: "max turns" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const errorEvent = events.find(([e]) => e === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent![1] as { message: string }).message).toContain(
      "maximum turns",
    );
  });

  it("emits error for error_during_execution with message", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: "sess-1",
          uuid: "u1",
          total_cost_usd: 0.02,
          duration_ms: 1000,
          num_turns: 1,
          is_error: true,
          errors: ["Connection timeout", "Retry failed"],
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const errorEvent = events.find(([e]) => e === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent![1] as { message: string }).message).toBe(
      "Connection timeout; Retry failed",
    );
  });

  it("always emits done event", async () => {
    const qs = createMockQuerySession([]);
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("acquires and releases the session lock", async () => {
    const qs = createMockQuerySession([]);
    deps = createTestDeps(qs);
    const releaseMock = vi.fn();
    (deps.acquireSessionLock as ReturnType<typeof vi.fn>).mockReturnValue(
      releaseMock,
    );
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(deps.acquireSessionLock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("resets conversation status to awaiting in finally block", async () => {
    const qs = createMockQuerySession([]);
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("awaiting");
  });

  it("returns conversationId", async () => {
    const qs = createMockQuerySession([]);
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const result = await executePromptStream(
      "/projects/repo",
      makeSession(),
      "test",
      vi.fn(),
    );

    expect(result.conversationId).toBe("conv-123");
  });

  it("creates new QuerySession on first prompt (no existing session)", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "system",
          subtype: "init",
          session_id: "sess-1",
          uuid: "u1",
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    // No existing session in registry
    (deps.getSessionFromRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
    );

    expect(deps.createQuerySession).toHaveBeenCalledTimes(1);
    const callArgs = (deps.createQuerySession as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(callArgs.cwd).toBe("/projects/repo/.worktrees/test-session");
  });

  it("reuses existing alive session (no new creation)", async () => {
    const qs = createMockQuerySession([], { sessionId: "sess-1" });
    deps = createTestDeps(qs);
    // Existing alive session in registry
    (deps.getSessionFromRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
      qs,
    );
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "follow-up",
      vi.fn(),
      "conv-123",
    );

    // Should NOT create a new session
    expect(deps.createQuerySession).not.toHaveBeenCalled();
    // Should have called sendPrompt on the existing session
    expect(qs.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("creates fresh session when previous is dead", async () => {
    const deadSession = createMockQuerySession([]);
    (deadSession as { status: string }).status = "dead";

    const newSession = createMockQuerySession([], { sessionId: "sess-new" });

    deps = createTestDeps(newSession);
    (deps.getSessionFromRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
      deadSession,
    );
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "retry",
      vi.fn(),
      "conv-123",
    );

    // Should create a new session since the old one is dead
    expect(deps.createQuerySession).toHaveBeenCalledTimes(1);
  });

  it("sets claudeSessionId from TurnResult", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "system",
          subtype: "init",
          session_id: "sess-abc-456",
          uuid: "u1",
        },
        {
          type: "assistant",
          session_id: "sess-abc-456",
          uuid: "u2",
          message: { content: [{ type: "text", text: "response" }] },
        },
      ],
      { sessionId: "sess-abc-456" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const metadataSnapshot = updateSnapshots.find(
      (s) => s.conversations[0]!.claudeSessionId === "sess-abc-456",
    );
    expect(metadataSnapshot).toBeTruthy();
  });

  it("accumulates cost data from TurnResult", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u1",
          message: { content: [{ type: "text", text: "Done." }] },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          uuid: "u2",
          total_cost_usd: 0.05,
          duration_ms: 1200,
          num_turns: 3,
          result: "Done.",
          is_error: false,
        },
      ],
      {
        sessionId: "sess-1",
        costUsd: 0.05,
        durationMs: 1200,
        numTurns: 3,
      },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const costSnapshot = updateSnapshots.find(
      (s) => s.conversations[0]!.totalCostUsd !== null,
    );
    expect(costSnapshot).toBeTruthy();
    expect(costSnapshot!.conversations[0]!.totalCostUsd).toBe(0.05);
    expect(costSnapshot!.conversations[0]!.totalDurationMs).toBe(1200);
    expect(costSnapshot!.conversations[0]!.totalTurns).toBe(3);
  });

  it("appends transcript entries for messages", async () => {
    const qs = createMockQuerySession(
      [
        { type: "system", subtype: "init", session_id: "sess-1", uuid: "u1" },
        {
          type: "assistant",
          session_id: "sess-1",
          uuid: "u2",
          message: { content: [{ type: "text", text: "Hello" }] },
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(deps.safeAppendTranscriptEntry).toHaveBeenCalled();
    const calls = (deps.safeAppendTranscriptEntry as ReturnType<typeof vi.fn>)
      .mock.calls as Array<[string, { type: string }]>;
    const types = calls.map(([, entry]) => entry.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
  });

  it("broadcasts running and awaiting status", async () => {
    const qs = createMockQuerySession([]);
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const statusCalls = (deps.broadcast as ReturnType<typeof vi.fn>).mock
      .calls as Array<[{ type: string; status: string }]>;
    const statuses = statusCalls.map(([event]) => event.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("awaiting");
  });

  it("emits error and done when sendPrompt throws", async () => {
    const qs = createMockQuerySession([]);
    (qs.sendPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("SDK process crashed"),
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const errorEvent = events.find(([e]) => e === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent![1] as { message: string }).message).toContain(
      "SDK process crashed",
    );
    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("emits result text as content when SDK returns result with no assistant messages", async () => {
    const qs = createMockQuerySession(
      [
        {
          type: "system",
          subtype: "init",
          session_id: "sess-1",
          uuid: "u1",
        },
        {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          uuid: "u2",
          total_cost_usd: 0,
          duration_ms: 17,
          duration_api_ms: 0,
          num_turns: 1,
          result: "Unknown skill: frontend-design:frontend-design",
          is_error: false,
        },
      ],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({
      type: "text",
      text: "Unknown skill: frontend-design:frontend-design",
    });
  });

  it("registers raw Query in query-registry for queueMessage compat", async () => {
    const qs = createMockQuerySession(
      [{ type: "system", subtype: "init", session_id: "sess-1", uuid: "u1" }],
      { sessionId: "sess-1" },
    );
    deps = createTestDeps(qs);
    // No existing session — will create new
    (deps.getSessionFromRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(deps.registerQuery).toHaveBeenCalledWith("conv-123", qs.query);
  });

  it("passes resume option for existing conversation with claudeSessionId", async () => {
    const convo = makeConversation({ claudeSessionId: "existing-session-id" });
    const qs = createMockQuerySession([], { sessionId: "existing-session-id" });
    deps = createTestDeps(qs);
    // No existing session in registry — will create
    (deps.getSessionFromRegistry as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );
    (deps.getConversation as ReturnType<typeof vi.fn>).mockResolvedValue(convo);

    const session = makeSession();
    session.conversations = [convo];

    const executor = createPromptExecutor(deps);
    executePromptStream = executor.executePromptStream;

    await executePromptStream(
      "/projects/repo",
      session,
      "follow-up",
      vi.fn(),
      convo.id,
    );

    const callArgs = (deps.createQuerySession as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(callArgs.resume).toBe("existing-session-id");
  });
});
