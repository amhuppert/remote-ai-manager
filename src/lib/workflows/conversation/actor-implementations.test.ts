import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrepareTurnInput, ExecutePromptInput } from "./types";
import type { ActorImplementationDeps } from "./actor-implementations";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/types";
import {
  _resetForTesting,
  registerConversationRuntime,
  getConversationRuntime,
  conversationRuntimeKey,
} from "./runtime-state";

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

import {
  prepareTurnForMachine,
  executePromptForMachine,
  setActorDeps,
  _resetActorDepsForTesting,
  shouldRecreateRuntime,
  buildEffectivePrompt,
  processMessage,
  mapErrorSubtype,
} from "./actor-implementations";
import { QUERY_SESSION_ERROR_CODES } from "@/lib/agent-backends/claude/query-session-errors";

// ---------------------------------------------------------------------------
// Shared mock backend runtime
// ---------------------------------------------------------------------------

const mockSendTurn = vi.fn();

function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    status: "alive",
    modelId: undefined,
    reasoningEffort: undefined,
    outputFormat: undefined,
    capabilities: {
      queueWhileRunning: false,
      askUserQuestion: true,
      preciseFork: false,
      portableMcpAtStart: false,
      portableMcpBetweenTurns: false,
      contextWindowMetrics: true,
    },
    sendTurn: mockSendTurn,
    close: vi.fn(),
    ...overrides,
  } as unknown as ConversationBackendRuntime;
}

const mockBackendRuntime = createMockBackendRuntime();

const mockFactory = {
  createRuntime: vi.fn(async () => mockBackendRuntime),
};

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(
  overrides: Partial<ActorImplementationDeps> = {},
): ActorImplementationDeps {
  return {
    acquireSessionLock: vi.fn(() => vi.fn()),
    acquireQuerySlot: vi.fn(async () => vi.fn()),
    getTranscriptPath: vi.fn(async (id: string) => `/transcripts/${id}.jsonl`),
    readConfig: vi.fn(async () => ({
      claudeTimeoutMs: 300_000,
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
    })),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    getDebugLogUrl: vi.fn(
      (id: string) =>
        `http://localhost:3000/api/debug-logs?conversationId=${id}`,
    ),
    safeAppendTranscriptEntry: vi.fn(async () => {}),
    externalizeImageBlocks: vi.fn(
      async (_id: string, blocks: unknown[]) => blocks,
    ),
    getConversationBackendFactory: vi.fn(() => mockFactory),
    registerBackendRuntime: vi.fn(),
    unregisterBackendRuntime: vi.fn(),
    buildChildEnv: vi.fn(() => ({ HOME: "/home/test" })),
    resolvePluginPaths: vi.fn(async () => []),
    createNotificationToolServer: vi.fn(() => null),
    createRoadmapToolServer: vi.fn(() => ({})),
    createWiredPlannerToolServer: vi.fn(() => ({})),
    createReferenceDocumentToolServer: vi.fn(() => ({})),
    maybeCreateCodexToolServer: vi.fn(() => null),
    getCodexToolPromptHint: vi.fn(() => ""),
    mutateConversation: vi.fn(async () => {}),
    getSessionState: vi.fn(async () => null),
    createReferenceDocument: vi.fn(async () => ({})),
    getReferenceDocuments: vi.fn(async () => []),
    readConversationMessages: vi.fn(async () => []),
    fileExists: vi.fn(() => false),
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
    ...overrides,
  } as ActorImplementationDeps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrepareTurnInput(
  overrides: Partial<PrepareTurnInput> = {},
): PrepareTurnInput {
  return {
    projectPath: "/projects/repo",
    sessionName: "test-session",
    conversationId: "conv-1",
    worktreePath: "/projects/repo/.worktrees/test-session",
    transcriptPath: null,
    ...overrides,
  };
}

function makeExecutePromptInput(
  overrides: Partial<ExecutePromptInput> = {},
): ExecutePromptInput {
  return {
    projectPath: "/projects/repo",
    projectName: "repo",
    sessionName: "test-session",
    worktreePath: "/projects/repo/.worktrees/test-session",
    conversationId: "conv-1",
    transcriptPath: "/transcripts/conv-1.jsonl",
    agentBackend: "claude",
    backendRef: null,
    forkedFrom: null,
    role: null,
    promptText: "Hello, world!",
    images: [],
    modelId: null,
    effort: null,
    autonomous: false,
    debugMode: null,
    ...overrides,
  };
}

// ===========================================================================
// Unit tests: extracted pure functions
// ===========================================================================

describe("shouldRecreateRuntime", () => {
  it("returns false when session is undefined", () => {
    expect(shouldRecreateRuntime(undefined, "model", "effort")).toBe(false);
  });

  it("returns false when session is dead", () => {
    expect(
      shouldRecreateRuntime(
        { status: "dead", modelId: "a", reasoningEffort: "low" },
        "b",
        "high",
      ),
    ).toBe(false);
  });

  it("returns false when model and effort unchanged", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        "a",
        "low",
      ),
    ).toBe(false);
  });

  it("returns true when model changed", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        "b",
        "low",
      ),
    ).toBe(true);
  });

  it("returns true when effort changed", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        "a",
        "high",
      ),
    ).toBe(true);
  });

  it("returns false when new values are undefined (no explicit override)", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        undefined,
        undefined,
      ),
    ).toBe(false);
  });

  it("returns true when outputFormat changes from undefined to defined", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          outputFormat: undefined,
        },
        "a",
        "low",
        { type: "json_schema", schema },
      ),
    ).toBe(true);
  });

  it("returns true when outputFormat changes from defined to undefined", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          outputFormat: { type: "json_schema", schema },
        },
        "a",
        "low",
        undefined,
      ),
    ).toBe(true);
  });

  it("returns true when outputFormat schema changes", () => {
    const schema1 = { type: "object", properties: { a: { type: "string" } } };
    const schema2 = { type: "object", properties: { b: { type: "number" } } };
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          outputFormat: { type: "json_schema", schema: schema1 },
        },
        "a",
        "low",
        { type: "json_schema", schema: schema2 },
      ),
    ).toBe(true);
  });

  it("returns false when outputFormat is the same object reference", () => {
    const format = {
      type: "json_schema" as const,
      schema: { type: "object", properties: { a: { type: "string" } } },
    };
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          outputFormat: format,
        },
        "a",
        "low",
        format,
      ),
    ).toBe(false);
  });

  it("returns false when both outputFormats are undefined", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          outputFormat: undefined,
        },
        "a",
        "low",
        undefined,
      ),
    ).toBe(false);
  });
});

describe("buildEffectivePrompt", () => {
  it("returns plain text when no images", () => {
    const result = buildEffectivePrompt(
      "hello",
      false,
      [],
      null,
      "http://debug",
    );
    expect(result).toBe("hello");
  });

  it("returns content blocks when has images", () => {
    const blocks = [
      { type: "text" as const, text: "hello" },
      { type: "image" as const, mediaType: "image/png", base64Data: "abc" },
    ];
    const result = buildEffectivePrompt(
      "hello",
      true,
      blocks,
      null,
      "http://debug",
    );
    expect(result).toEqual(blocks);
  });

  it("prepends debug instructions on first debug turn", () => {
    const debugMode = {
      active: true,
      recording: false,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [] as never[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
    };
    const result = buildEffectivePrompt(
      "help debug",
      false,
      [],
      debugMode,
      "http://debug-url",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain("<debug-mode>");
    expect(result as string).toContain("help debug");
    expect(result as string).toContain("http://debug-url");
    expect(result as string).toContain("/tmp/debug.jsonl");
  });

  it("prepends phase context when instructions already delivered", () => {
    const debugMode = {
      active: true,
      recording: false,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [] as never[],
      instructionsDelivered: true,
      phase: "hypothesizing" as const,
    };
    const result = buildEffectivePrompt(
      "help debug",
      false,
      [],
      debugMode,
      "http://debug-url",
    );
    expect(typeof result).toBe("string");
    expect(result as string).toContain("<debug-phase>");
    expect(result as string).toContain("HYPOTHESIZING");
    expect(result as string).toContain("help debug");
    expect(result as string).not.toContain("<debug-mode>");
  });

  it("does not prepend when debugMode is null", () => {
    const result = buildEffectivePrompt(
      "hello",
      false,
      [],
      null,
      "http://debug",
    );
    expect(result).toBe("hello");
  });

  it("prepends debug instructions to image content blocks", () => {
    const blocks = [
      { type: "text" as const, text: "check this" },
      { type: "image" as const, mediaType: "image/png", base64Data: "abc" },
    ];
    const debugMode = {
      active: true,
      recording: false,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [] as never[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
    };
    const result = buildEffectivePrompt(
      "check this",
      true,
      blocks,
      debugMode,
      "http://debug-url",
    );
    expect(Array.isArray(result)).toBe(true);
    const arr = result as Array<{ type: string; text?: string }>;
    expect(arr[0]!.type).toBe("text");
    expect(arr[0]!.text).toContain("<debug-mode>");
  });
});

describe("mapErrorSubtype", () => {
  it("maps error_max_turns", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_max_turns",
      num_turns: 50,
      total_cost_usd: 1.0,
      errors: [],
    } as never);
    expect(result).toContain("maximum turns");
    expect(result).toContain("50");
  });

  it("maps error_max_budget_usd", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_max_budget_usd",
      num_turns: 10,
      total_cost_usd: 5.5,
      errors: [],
    } as never);
    expect(result).toContain("budget limit");
    expect(result).toContain("$5.50");
  });

  it("maps error_during_execution with errors", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 5,
      total_cost_usd: 0.5,
      errors: ["Something broke", "Another issue"],
    } as never);
    expect(result).toBe("Something broke; Another issue");
  });

  it("maps error_during_execution with empty errors", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 5,
      total_cost_usd: 0.5,
      errors: [],
    } as never);
    expect(result).toBe("Error during execution");
  });

  it("maps error_max_structured_output_retries", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_max_structured_output_retries",
      num_turns: 3,
      total_cost_usd: 0.3,
      errors: [],
    } as never);
    expect(result).toContain("structured output retry limit");
  });

  it("maps unknown subtypes", () => {
    const result = mapErrorSubtype({
      type: "result",
      subtype: "error_something_new",
      num_turns: 1,
      total_cost_usd: 0.1,
      errors: [],
    } as never);
    expect(result).toBe("Unknown error");
  });
});

describe("processMessage", () => {
  it("handles system init message", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});

    await processMessage(
      { type: "system", subtype: "init", session_id: "sess-1" } as never,
      "conv-1",
      emit,
      [],
      appendEntry,
    );

    expect(emit).toHaveBeenCalledWith("init", { sessionId: "sess-1" });
    expect(appendEntry).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ type: "system" }),
    );
  });

  it("handles assistant text messages", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});
    const contentBlocks: unknown[] = [];

    await processMessage(
      {
        type: "assistant",
        uuid: "msg-1",
        message: { content: [{ type: "text", text: "Hello!" }] },
      } as never,
      "conv-1",
      emit,
      contentBlocks as never,
      appendEntry,
    );

    expect(emit).toHaveBeenCalledWith("content", {
      type: "text",
      text: "Hello!",
    });
    expect(contentBlocks).toHaveLength(1);
    expect(appendEntry).toHaveBeenCalled();
  });

  it("handles assistant tool_use messages", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});
    const contentBlocks: unknown[] = [];

    await processMessage(
      {
        type: "assistant",
        uuid: "msg-2",
        message: {
          content: [
            { type: "tool_use", name: "ReadFile", input: { path: "/foo" } },
          ],
        },
      } as never,
      "conv-1",
      emit,
      contentBlocks as never,
      appendEntry,
    );

    expect(emit).toHaveBeenCalledWith(
      "content",
      expect.objectContaining({ type: "tool_use", name: "ReadFile" }),
    );
    expect(contentBlocks).toHaveLength(1);
  });

  it("handles result success", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});

    await processMessage(
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        total_cost_usd: 0.05,
        num_turns: 3,
        result: null,
      } as never,
      "conv-1",
      emit,
      [],
      appendEntry,
    );

    expect(emit).toHaveBeenCalledWith(
      "result",
      expect.objectContaining({
        sessionId: "sess-1",
        costUsd: 0.05,
        numTurns: 3,
      }),
    );
  });

  it("handles result error", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});

    await processMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        num_turns: 1,
        total_cost_usd: 0.01,
        errors: ["Something failed"],
      } as never,
      "conv-1",
      emit,
      [],
      appendEntry,
    );

    expect(emit).toHaveBeenCalledWith("error", {
      message: "Something failed",
    });
  });

  it("adds result text to contentBlocks when empty", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});
    const contentBlocks: unknown[] = [];

    await processMessage(
      {
        type: "result",
        subtype: "success",
        session_id: "sess-1",
        total_cost_usd: 0.01,
        num_turns: 1,
        result: "Final answer",
      } as never,
      "conv-1",
      emit,
      contentBlocks as never,
      appendEntry,
    );

    expect(contentBlocks).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith("content", {
      type: "text",
      text: "Final answer",
    });
  });
});

// ===========================================================================
// Integration tests: prepareTurnForMachine
// ===========================================================================

describe("prepareTurnForMachine", () => {
  let mockDeps: ActorImplementationDeps;

  beforeEach(() => {
    _resetForTesting();
    mockDeps = createMockDeps();
    setActorDeps(mockDeps);
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  it("acquires session lock and query slot", async () => {
    const releaseLock = vi.fn();
    const releaseSlot = vi.fn();
    vi.mocked(mockDeps.acquireSessionLock).mockReturnValue(releaseLock);
    vi.mocked(mockDeps.acquireQuerySlot).mockResolvedValue(releaseSlot);

    const input = makePrepareTurnInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await prepareTurnForMachine(input);

    expect(mockDeps.acquireSessionLock).toHaveBeenCalledWith(
      input.projectPath,
      input.sessionName,
    );
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${input.sessionName}`,
    );
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");

    const runtime = getConversationRuntime(key);
    expect(runtime?.releaseSessionLock).toBe(releaseLock);
    expect(runtime?.releaseQuerySlot).toBe(releaseSlot);
  });

  it("returns existing transcript path when already set", async () => {
    const input = makePrepareTurnInput({
      transcriptPath: "/existing/path.jsonl",
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await prepareTurnForMachine(input);

    expect(result.transcriptPath).toBe("/existing/path.jsonl");
    expect(mockDeps.getTranscriptPath).not.toHaveBeenCalled();
  });

  it("creates transcript path when not set", async () => {
    const input = makePrepareTurnInput({ transcriptPath: null });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await prepareTurnForMachine(input);

    expect(mockDeps.getTranscriptPath).toHaveBeenCalledWith("conv-1");
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");
  });

  it("throws when runtime state is not registered", async () => {
    const input = makePrepareTurnInput();
    await expect(prepareTurnForMachine(input)).rejects.toThrow(
      /No runtime state/,
    );
  });

  it("skips session lock acquisition when skipSessionLock is set on runtime", async () => {
    const releaseSlot = vi.fn();
    vi.mocked(mockDeps.acquireQuerySlot).mockResolvedValue(releaseSlot);

    const input = makePrepareTurnInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      skipSessionLock: true,
    });

    const result = await prepareTurnForMachine(input);

    // Session lock should NOT be acquired
    expect(mockDeps.acquireSessionLock).not.toHaveBeenCalled();
    // Query slot should still be acquired
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${input.sessionName}`,
    );
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");

    // Runtime should NOT have a releaseSessionLock
    const runtime = getConversationRuntime(key);
    expect(runtime?.releaseSessionLock).toBeUndefined();
    expect(runtime?.releaseQuerySlot).toBe(releaseSlot);
  });
});

// ===========================================================================
// Integration tests: executePromptForMachine
// ===========================================================================

describe("executePromptForMachine", () => {
  let mockDeps: ActorImplementationDeps;

  const defaultTurnResult: ConversationBackendTurnResult = {
    backendRef: { backend: "claude", sessionId: "sdk-session-1" },
    costUsd: 0.05,
    durationMs: 1500,
    numTurns: 3,
    contextTokens: 1000,
    contextWindowMax: 200000,
    contentBlocks: [{ type: "text", text: "Hello!" }],
    aborted: false,
    error: null,
  };

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();

    mockDeps = createMockDeps();
    setActorDeps(mockDeps);

    mockSendTurn.mockResolvedValue(defaultTurnResult);
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  it("creates a new backend runtime when none exists", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
    expect(result.costUsd).toBe(0.05);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("reuses an existing alive backend runtime", async () => {
    const existingRuntime = createMockBackendRuntime();
    (existingRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultTurnResult,
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: existingRuntime,
    });

    const result = await executePromptForMachine(input);

    // Should NOT create a new runtime
    expect(mockFactory.createRuntime).not.toHaveBeenCalled();
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
  });

  it("recreates runtime when model changes", async () => {
    const existingRuntime = createMockBackendRuntime({
      modelId: "claude-sonnet-4-5-20250514",
    });

    const input = makeExecutePromptInput({
      modelId: "claude-opus-4-20250514",
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: existingRuntime,
    });

    await executePromptForMachine(input);

    expect(existingRuntime.close).toHaveBeenCalled();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("sends BACKEND_INIT event to machine via onEvent callback", async () => {
    const sendToMachine = vi.fn();
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      sendToMachine,
    });

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        // Simulate a provider_event with system init message
        await turnInput.onEvent?.({
          type: "provider_event",
          payload: {
            type: "system",
            subtype: "init",
            session_id: "new-sdk-session",
          },
        });
        return {
          ...defaultTurnResult,
          backendRef: {
            backend: "claude" as const,
            sessionId: "new-sdk-session",
          },
        };
      },
    );

    await executePromptForMachine(input);

    expect(sendToMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "BACKEND_INIT",
        backendRef: { backend: "claude", sessionId: "new-sdk-session" },
      }),
    );
  });

  it("recreates runtime when outputFormat changes", async () => {
    const existingRuntime = createMockBackendRuntime({
      outputFormat: undefined,
    });

    const schema = { type: "object", properties: { name: { type: "string" } } };
    const input = makeExecutePromptInput({
      outputFormat: { type: "json_schema", schema },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: existingRuntime,
    });

    await executePromptForMachine(input);

    expect(existingRuntime.close).toHaveBeenCalled();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("recreates runtime when outputFormat is removed", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const existingRuntime = createMockBackendRuntime({
      outputFormat: { type: "json_schema" as const, schema },
    });

    const input = makeExecutePromptInput({
      outputFormat: undefined,
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: existingRuntime,
    });

    await executePromptForMachine(input);

    expect(existingRuntime.close).toHaveBeenCalled();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("passes outputFormat to factory.createRuntime for debug phases", async () => {
    const input = makeExecutePromptInput({
      debugMode: {
        active: true,
        recording: false,
        logFilePath: "/tmp/.debug/logs.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
      },
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(result.error).toBeNull();
  });

  it("returns error result when backend throws", async () => {
    mockSendTurn.mockRejectedValue(new Error("SDK crashed"));

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await executePromptForMachine(input);

    expect(result.error).toBe("SDK crashed");
    expect(result.aborted).toBe(false);
  });

  it("retries once with a fresh runtime when prompt delivery never reached backend", async () => {
    const staleSendTurn = vi.fn();
    const staleRuntime = createMockBackendRuntime({ sendTurn: staleSendTurn });
    staleSendTurn.mockImplementation(async () => {
      (staleRuntime as unknown as { status: string }).status = "dead";
      const error = new Error("QuerySession died before prompt delivery");
      (error as Error & { code?: string }).code =
        QUERY_SESSION_ERROR_CODES.promptNotDelivered;
      throw error;
    });

    const freshSendTurn = vi.fn();
    const freshRuntime = createMockBackendRuntime({ sendTurn: freshSendTurn });
    freshSendTurn.mockResolvedValue({
      ...defaultTurnResult,
      backendRef: {
        backend: "claude" as const,
        sessionId: "sdk-session-retry",
      },
      contentBlocks: [{ type: "text" as const, text: "Recovered turn" }],
    });
    mockFactory.createRuntime.mockResolvedValue(freshRuntime);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: staleRuntime,
    });

    const result = await executePromptForMachine(input);

    expect(staleSendTurn).toHaveBeenCalledTimes(1);
    expect(staleRuntime.close).toHaveBeenCalledTimes(1);
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(freshSendTurn).toHaveBeenCalledTimes(1);
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sdk-session-retry",
    });
    expect(result.error).toBeNull();
    expect(result.contentBlocks).toEqual([
      { type: "text", text: "Recovered turn" },
    ]);
  });

  it("marks result as aborted when abort signal fires", async () => {
    const abortController = new AbortController();
    mockSendTurn.mockImplementation(async () => {
      abortController.abort();
      throw new Error("aborted");
    });

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, { abortController });

    const result = await executePromptForMachine(input);

    expect(result.aborted).toBe(true);
  });

  it("merges tooling overrides from runtime state into factory.createRuntime", async () => {
    const mockToolServer = { name: "graph-workflow", tools: [] };
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      tooling: { claudeSdkServers: { "graph-workflow": mockToolServer } },
    });

    await executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      claudeSdkServers?: Record<string, unknown>;
    };
    expect(tooling.claudeSdkServers?.["graph-workflow"]).toBe(mockToolServer);
    // Standard servers should still be present
    expect(tooling.claudeSdkServers?.["roadmap-tools"]).toBeDefined();
    expect(tooling.claudeSdkServers?.["graph-workflow-planner"]).toBeDefined();
  });

  it("does not include tooling overrides when not set on runtime", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      claudeSdkServers?: Record<string, unknown>;
    };
    expect(tooling.claudeSdkServers?.["graph-workflow"]).toBeUndefined();
    // Standard servers still present
    expect(tooling.claudeSdkServers?.["roadmap-tools"]).toBeDefined();
  });

  it("propagates structuredOutput from TurnResult to PromptActorResult", async () => {
    const structuredData = {
      hypotheses: [
        { id: "H1", description: "test", instrumentationPlan: "add log" },
      ],
      reproductionSteps: ["step 1", "step 2"],
    };

    mockSendTurn.mockResolvedValue({
      ...defaultTurnResult,
      structuredOutput: structuredData,
    });

    const input = makeExecutePromptInput({
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await executePromptForMachine(input);

    expect(result.structuredOutput).toEqual(structuredData);
  });

  it("prepends debug instructions on first debug turn", async () => {
    const input = makeExecutePromptInput({
      promptText: "Help me debug this",
      debugMode: {
        active: true,
        recording: false,
        logFilePath: "/tmp/.debug/logs.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const sendTurnCall = mockSendTurn.mock.calls[0]! as unknown[];
    const turnInput = sendTurnCall[0] as ConversationBackendTurnInput;
    expect(turnInput.promptText).toContain("<debug-mode>");
    expect(turnInput.promptText).toContain("Help me debug this");
  });
});
