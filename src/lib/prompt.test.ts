import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  queryMock,
  getSessionMock,
  updateSessionMock,
  readConfigMock,
  acquireSessionLockMock,
  getConversationMock,
  createConversationMock,
  appendTranscriptEntryMock,
  getTranscriptPathMock,
  broadcastMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  readConfigMock: vi.fn(),
  acquireSessionLockMock: vi.fn(),
  getConversationMock: vi.fn(),
  createConversationMock: vi.fn(),
  appendTranscriptEntryMock: vi.fn(),
  getTranscriptPathMock: vi.fn(),
  broadcastMock: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("./state", () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}));

vi.mock("./config", () => ({
  readConfig: readConfigMock,
}));

vi.mock("./lock", () => ({
  acquireSessionLock: acquireSessionLockMock,
}));

vi.mock("./logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./conversations", () => ({
  getConversation: getConversationMock,
  createConversation: createConversationMock,
}));

vi.mock("./transcript", () => ({
  appendTranscriptEntry: appendTranscriptEntryMock,
  getTranscriptPath: getTranscriptPathMock,
}));

vi.mock("./sse-broadcaster", () => ({
  broadcast: broadcastMock,
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { executePromptStream } from "./prompt";
import type { SessionState } from "@/types";

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
    source: "csm" as const,
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
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
    source: "csm" as const,
    ...overrides,
  };
}

/** Create a mock async generator that yields the given SDK messages */
function createMockQuery(messages: Record<string, unknown>[]) {
  const generator = (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
  return generator;
}

const defaultConfig = {
  baseDir: "/tmp/projects",
  ignorePatterns: [],
  stateFilePath: "/tmp/csm/state.json",
  claudeTimeoutMs: 300_000,
  maxTurns: 50,
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

let updateSnapshots: SessionState[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  readConfigMock.mockResolvedValue(defaultConfig);
  updateSnapshots = [];

  const releaseMock = vi.fn();
  acquireSessionLockMock.mockReturnValue(releaseMock);

  const conversation = makeConversation();
  createConversationMock.mockResolvedValue(conversation);
  getConversationMock.mockResolvedValue(conversation);

  appendTranscriptEntryMock.mockResolvedValue(undefined);
  getTranscriptPathMock.mockResolvedValue(
    "/tmp/csm/transcripts/conv-123.jsonl",
  );

  const session = makeSession();
  session.conversations = [conversation];
  getSessionMock.mockImplementation(() => Promise.resolve(session));
  updateSessionMock.mockImplementation((_path: string, s: SessionState) => {
    updateSnapshots.push(JSON.parse(JSON.stringify(s)));
    return Promise.resolve();
  });
});

// ===========================================================================
// Tests
// ===========================================================================

describe("executePromptStream", () => {
  it("emits init event from system init message", async () => {
    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "sess-123", uuid: "u1" },
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([
      {
        type: "assistant",
        session_id: "sess-1",
        uuid: "u1",
        message: {
          content: [{ type: "text", text: "Hello!" }],
        },
      },
    ]);
    queryMock.mockReturnValue(mockQuery);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "Hi", emit);

    const contentEvents = events.filter(([e]) => e === "content");
    expect(contentEvents).toHaveLength(1);
    expect(contentEvents[0]![1]).toEqual({ type: "text", text: "Hello!" });
  });

  it("emits content events for tool_use blocks", async () => {
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    const events: Array<[string, unknown]> = [];
    const emit = (event: string, data: unknown) => events.push([event, data]);

    await executePromptStream("/projects/repo", makeSession(), "test", emit);

    expect(events.find(([e]) => e === "done")).toBeTruthy();
  });

  it("acquires and releases the session lock", async () => {
    const releaseMock = vi.fn();
    acquireSessionLockMock.mockReturnValue(releaseMock);
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    expect(acquireSessionLockMock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("resets conversation status to awaiting in finally block", async () => {
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const last = updateSnapshots[updateSnapshots.length - 1]!;
    expect(last.conversations[0]!.status).toBe("awaiting");
  });

  it("returns conversationId", async () => {
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    const result = await executePromptStream(
      "/projects/repo",
      makeSession(),
      "test",
      vi.fn(),
    );

    expect(result.conversationId).toBe("conv-123");
  });

  it("passes correct SDK options for new conversation", async () => {
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream(
      "/projects/repo",
      makeSession(),
      "Hello",
      vi.fn(),
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]![0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(call.prompt).toBe("Hello");
    expect(call.options.cwd).toBe("/projects/repo/.worktrees/test-session");
    expect(call.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(call.options.settingSources).toEqual(["user", "project", "local"]);
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.maxTurns).toBe(50);
    expect(call.options.persistSession).toBe(true);
    expect(call.options.resume).toBeUndefined();
  });

  it("passes resume option for existing conversation with claudeSessionId", async () => {
    const convo = makeConversation({ claudeSessionId: "existing-session-id" });
    getConversationMock.mockResolvedValue(convo);

    const session = makeSession();
    session.conversations = [convo];
    getSessionMock.mockImplementation(() => Promise.resolve(session));

    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream(
      "/projects/repo",
      session,
      "follow-up",
      vi.fn(),
      convo.id,
    );

    const call = queryMock.mock.calls[0]![0] as {
      options: Record<string, unknown>;
    };
    expect(call.options.resume).toBe("existing-session-id");
  });

  it("sets claudeSessionId from init message", async () => {
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const metadataSnapshot = updateSnapshots.find(
      (s) => s.conversations[0]!.claudeSessionId === "sess-abc-456",
    );
    expect(metadataSnapshot).toBeTruthy();
  });

  it("accumulates cost data from result message", async () => {
    const mockQuery = createMockQuery([
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
    ]);
    queryMock.mockReturnValue(mockQuery);

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
    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "sess-1", uuid: "u1" },
      {
        type: "assistant",
        session_id: "sess-1",
        uuid: "u2",
        message: { content: [{ type: "text", text: "Hello" }] },
      },
    ]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    // Should have appended entries for system and assistant messages
    expect(appendTranscriptEntryMock).toHaveBeenCalled();
    const calls = appendTranscriptEntryMock.mock.calls as Array<
      [string, { type: string }]
    >;
    const types = calls.map(([, entry]) => entry.type);
    expect(types).toContain("system");
    expect(types).toContain("assistant");
  });

  it("broadcasts running and awaiting status", async () => {
    const mockQuery = createMockQuery([]);
    queryMock.mockReturnValue(mockQuery);

    await executePromptStream("/projects/repo", makeSession(), "test", vi.fn());

    const statusCalls = broadcastMock.mock.calls as Array<
      [{ type: string; status: string }]
    >;
    const statuses = statusCalls.map(([event]) => event.status);
    expect(statuses).toContain("running");
    expect(statuses).toContain("awaiting");
  });

  it("emits error and done when SDK throws", async () => {
    const mockQuery = (async function* () {
      throw new Error("SDK process crashed");
    })();
    queryMock.mockReturnValue(mockQuery);

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
});
