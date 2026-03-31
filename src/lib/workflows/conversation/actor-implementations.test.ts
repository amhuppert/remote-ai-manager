import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrepareTurnInput, ExecutePromptInput } from "./types";
import type {
  ActorImplementationDeps,
  QuerySessionLike,
} from "./actor-implementations";
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
  shouldRecreateSession,
  buildEffectivePrompt,
  buildCanUseTool,
  processMessage,
  mapErrorSubtype,
} from "./actor-implementations";

// ---------------------------------------------------------------------------
// Shared mock session
// ---------------------------------------------------------------------------

const mockSendPrompt = vi.fn();
const mockQuerySession: QuerySessionLike = {
  status: "alive",
  model: undefined,
  effort: undefined,
  sendPrompt: mockSendPrompt,
  close: vi.fn(),
  query: { streamInput: vi.fn(), close: vi.fn() },
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
    getSessionFromRegistry: vi.fn(() => undefined),
    createQuerySession: vi.fn(() => mockQuerySession),
    buildChildEnv: vi.fn(() => ({ HOME: "/home/test" })),
    resolvePluginPaths: vi.fn(async () => []),
    createInitToolServer: vi.fn(() => null),
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
    fileExists: vi.fn(() => false),
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
    registerQuery: vi.fn(),
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
    claudeSessionId: null,
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

describe("shouldRecreateSession", () => {
  it("returns false when session is undefined", () => {
    expect(shouldRecreateSession(undefined, "model", "effort")).toBe(false);
  });

  it("returns false when session is dead", () => {
    expect(
      shouldRecreateSession(
        { status: "dead", model: "a", effort: "low" },
        "b",
        "high",
      ),
    ).toBe(false);
  });

  it("returns false when model and effort unchanged", () => {
    expect(
      shouldRecreateSession(
        { status: "alive", model: "a", effort: "low" },
        "a",
        "low",
      ),
    ).toBe(false);
  });

  it("returns true when model changed", () => {
    expect(
      shouldRecreateSession(
        { status: "alive", model: "a", effort: "low" },
        "b",
        "low",
      ),
    ).toBe(true);
  });

  it("returns true when effort changed", () => {
    expect(
      shouldRecreateSession(
        { status: "alive", model: "a", effort: "low" },
        "a",
        "high",
      ),
    ).toBe(true);
  });

  it("returns false when new values are undefined (no explicit override)", () => {
    expect(
      shouldRecreateSession(
        { status: "alive", model: "a", effort: "low" },
        undefined,
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

describe("buildCanUseTool", () => {
  it("allows non-AskUserQuestion tools", async () => {
    const runtime = {
      abortController: new AbortController(),
    };
    const canUseTool = buildCanUseTool(
      runtime as never,
      { projectPath: "/p", sessionName: "s", conversationId: "c" },
      false,
      vi.fn(),
    );
    const result = await canUseTool("SomeOtherTool", { input: "data" });
    expect(result.behavior).toBe("allow");
  });

  it("denies AskUserQuestion in autonomous mode", async () => {
    const runtime = {
      abortController: new AbortController(),
    };
    const canUseTool = buildCanUseTool(
      runtime as never,
      { projectPath: "/p", sessionName: "s", conversationId: "c" },
      true,
      vi.fn(),
    );
    const result = await canUseTool("AskUserQuestion", { questions: [] });
    expect(result.behavior).toBe("deny");
  });

  it("blocks for user answer in non-autonomous mode", async () => {
    const sendToMachine = vi.fn();
    const mutateConversation = vi.fn(async () => {});
    const runtime = {
      abortController: new AbortController(),
      sendToMachine,
      streamEmit: vi.fn(),
      activeQuestionResolver: undefined as
        | { resolve: (v: Record<string, string>) => void }
        | undefined,
    };

    const canUseTool = buildCanUseTool(
      runtime as never,
      { projectPath: "/p", sessionName: "s", conversationId: "c" },
      false,
      mutateConversation,
    );

    const promise = canUseTool("AskUserQuestion", {
      questions: [{ question: "Continue?" }],
    });

    // Wait for the deferred promise to be registered
    await vi.waitFor(() =>
      expect(runtime.activeQuestionResolver).toBeDefined(),
    );
    runtime.activeQuestionResolver!.resolve({ "0": "yes" });

    const result = await promise;
    expect(result.behavior).toBe("allow");
    expect(sendToMachine).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ASK_QUESTION" }),
    );
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

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();

    mockDeps = createMockDeps();
    setActorDeps(mockDeps);

    mockSendPrompt.mockResolvedValue({
      sessionId: "sdk-session-1",
      costUsd: 0.05,
      durationMs: 1500,
      numTurns: 3,
      contextTokens: 1000,
      contextWindow: 200000,
      contentBlocks: [{ type: "text", text: "Hello!" }],
      aborted: false,
      error: null,
    });
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  it("creates a new QuerySession when none exists", async () => {
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

    expect(mockDeps.createQuerySession).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("sdk-session-1");
    expect(result.costUsd).toBe(0.05);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("reuses an existing alive QuerySession", async () => {
    vi.mocked(mockDeps.getSessionFromRegistry).mockReturnValue(
      mockQuerySession,
    );

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

    expect(mockDeps.createQuerySession).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("sdk-session-1");
  });

  it("recreates session when model changes", async () => {
    const existingSession = {
      ...mockQuerySession,
      model: "claude-sonnet-4-5-20250514",
      close: vi.fn(),
    };
    vi.mocked(mockDeps.getSessionFromRegistry).mockReturnValue(existingSession);

    const input = makeExecutePromptInput({
      modelId: "claude-opus-4-20250514" as never,
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

    expect(existingSession.close).toHaveBeenCalled();
    expect(mockDeps.createQuerySession).toHaveBeenCalledTimes(1);
  });

  it("sends SDK_INIT event to machine via sendToMachine", async () => {
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

    mockSendPrompt.mockImplementation(
      async (
        _prompt: unknown,
        emit: (event: string, data: unknown) => void,
      ) => {
        emit("__raw_message", {
          type: "system",
          subtype: "init",
          session_id: "new-sdk-session",
        });
        return {
          sessionId: "new-sdk-session",
          costUsd: 0.01,
          durationMs: 500,
          numTurns: 1,
          contextTokens: 100,
          contextWindow: 200000,
          contentBlocks: [],
          aborted: false,
          error: null,
        };
      },
    );

    await executePromptForMachine(input);

    expect(sendToMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SDK_INIT",
        sessionId: "new-sdk-session",
      }),
    );
  });

  it("passes outputFormat to createQuerySession for debug phases", async () => {
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

    expect(mockDeps.createQuerySession).toHaveBeenCalledTimes(1);
    expect(result.error).toBeNull();
  });

  it("returns error result when SDK throws", async () => {
    mockSendPrompt.mockRejectedValue(new Error("SDK crashed"));

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

  it("marks result as aborted when abort signal fires", async () => {
    const abortController = new AbortController();
    mockSendPrompt.mockImplementation(async () => {
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

  it("merges additionalMcpServers from runtime state into createQuerySession", async () => {
    const mockToolServer = { name: "graph-workflow", tools: [] };
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      additionalMcpServers: { "graph-workflow": mockToolServer },
    });

    await executePromptForMachine(input);

    expect(mockDeps.createQuerySession).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(mockDeps.createQuerySession).mock
      .calls[0]![0] as Record<string, unknown>;
    const mcpServers = createCall["mcpServers"] as Record<string, unknown>;
    expect(mcpServers["graph-workflow"]).toBe(mockToolServer);
    // Standard servers should still be present
    expect(mcpServers["roadmap-tools"]).toBeDefined();
    expect(mcpServers["graph-workflow-planner"]).toBeDefined();
  });

  it("does not include additionalMcpServers when not set on runtime", async () => {
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

    expect(mockDeps.createQuerySession).toHaveBeenCalledTimes(1);
    const createCall = vi.mocked(mockDeps.createQuerySession).mock
      .calls[0]![0] as Record<string, unknown>;
    const mcpServers = createCall["mcpServers"] as Record<string, unknown>;
    expect(mcpServers["graph-workflow"]).toBeUndefined();
    // Standard servers still present
    expect(mcpServers["roadmap-tools"]).toBeDefined();
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

    const sendPromptCall = mockSendPrompt.mock.calls[0]!;
    const promptArg = sendPromptCall[0] as string;
    expect(promptArg).toContain("<debug-mode>");
    expect(promptArg).toContain("Help me debug this");
  });
});
