import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrepareTurnInput, ExecutePromptInput } from "./types";
import type { ActorImplementationDeps } from "./actor-implementations";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ClaudeRuntimeCapabilityConfig } from "@/lib/agent-capabilities/claude-runtime-translator";
import type { CodexRuntimeCapabilityConfig } from "@/lib/agent-capabilities/codex-runtime-translator";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  _resetForTesting,
  registerConversationRuntime,
  getConversationRuntime,
  conversationRuntimeKey,
} from "./runtime-state";

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
  prepareTurnForMachine,
  executePromptForMachine,
  runTaskRunTurnForMachine,
  setActorDeps,
  _resetActorDepsForTesting,
  shouldRecreateRuntime,
  buildEffectivePrompt,
  processMessage,
  mapErrorSubtype,
  resolveBackendTurnSettings,
  resolveBackendTimeoutMs,
  shouldBuildRuntimeSyntheticSeed,
} from "./actor-implementations";
import type { ActorConfig } from "./actor-implementations";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { RunTaskRunInput } from "./types";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { QUERY_SESSION_ERROR_CODES } from "@/lib/agent-backends/claude/query-session-errors";
import { computeEffectiveConfigHash } from "@/lib/mcp/runtime-apply";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import {
  ASK_QUESTION_INSTRUCTIONS,
  ASK_QUESTION_INSTRUCTIONS_ENABLED,
  CC_CLI_INSTRUCTIONS,
} from "@/lib/prompt/sdk-driver";
import type { AlignmentInjection } from "@/lib/session-alignment/render";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

// ---------------------------------------------------------------------------
// Shared mock backend runtime
// ---------------------------------------------------------------------------

const mockSendTurn = vi.fn();

function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    backend: "claude" as const,
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
  validateModelAndEffort: vi.fn(),
};

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(
  overrides: Partial<ActorImplementationDeps> = {},
): ActorImplementationDeps {
  return {
    acquireConversationLock: vi.fn(() => vi.fn()),
    acquireQuerySlot: vi.fn(async () => vi.fn()),
    getTranscriptPath: vi.fn(async (id: string) => `/transcripts/${id}.jsonl`),
    readConfig: vi.fn(async () => ({
      claudeTimeoutMs: 300_000,
      defaultModel: "opus",
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
      defaultEffort: undefined,
    })),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    getDebugLogUrl: vi.fn(
      (id: string) =>
        `http://localhost:3000/api/debug-logs?conversationId=${id}`,
    ),
    safeAppendTranscriptEntry: vi.fn(async () => {}),
    saveTranscriptImage: vi.fn(
      async (
        _id: string,
        index: number,
        mediaType: string,
      ): Promise<string> => {
        const ext = mediaType.split("/")[1] ?? "bin";
        return `/persisted/${index}.${ext}`;
      },
    ),
    getNextImageIndex: vi.fn(async () => 1),
    getConversationBackendFactory: vi.fn(() => mockFactory),
    registerBackendRuntime: vi.fn(),
    unregisterBackendRuntime: vi.fn(),
    buildChildEnv: vi.fn(() => ({ HOME: "/home/test" })),
    resolvePluginPaths: vi.fn(async () => []),
    getCodexToolPromptHint: vi.fn(() => ""),
    mutateConversation: vi.fn(async () => {}),
    getSessionState: vi.fn(async () => null),
    getActiveAlignmentInjection: vi.fn(async () => null),
    getActiveAlignmentVersion: vi.fn(async () => null),
    createReferenceDocument: vi.fn(async () => ({})),
    getReferenceDocuments: vi.fn(async () => []),
    readConversationMessages: vi.fn(async () => []),
    fileExists: vi.fn(() => false),
    registerAbortController: vi.fn(),
    unregisterAbortController: vi.fn(),
    applyMcpAtTurnStart: vi.fn(
      async (_input: {
        projectPath: string;
        sessionName: string;
        conversationId: string;
        backend: "claude" | "codex";
      }) => ({
        conversationId: "conv-1",
        backend: "claude" as const,
        disposition: "applied_now" as const,
        effectiveConfigHash: "hash-1",
      }),
    ),
    applyCapabilityAtTurnStart: vi.fn(async () => ({})),
    applyCapabilityWhenIdle: vi.fn(async () => ({})),
    composeClaudeCapabilityConfigForConversation: vi.fn(async () => undefined),
    composeCodexCapabilityConfigForConversation: vi.fn(async () => undefined),
    composeCapabilityConfigForProjectConversation: vi.fn(async () => undefined),
    composePortableMcpForConversation: vi.fn(
      async (args: {
        projectName: string;
        sessionName: string;
        transientPortableMcp?: { servers: Array<Record<string, unknown>> };
      }) => ({
        servers: [
          {
            id: "gateway-alpha",
            transport: "streamable-http" as const,
            url: `http://localhost:3000/api/projects/${args.projectName}/sessions/${args.sessionName}/mcp`,
          },
          ...(args.transientPortableMcp?.servers ?? []),
        ],
      }),
    ),
    executeAgentCall: defaultExecuteAgentCall,
    markQueuedDelivered: vi.fn(async () => {}),
    markQueuedPending: vi.fn(async () => {}),
    markQueuedFailed: vi.fn(async () => {}),
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
    streamId: "stream-1",
    modelId: null,
    effort: null,
    autonomous: false,
    debugMode: null,
    ...overrides,
  };
}

function makeProjectExecutePromptInput(
  overrides: Partial<ExecutePromptInput> = {},
): ExecutePromptInput {
  return makeExecutePromptInput({
    conversationScope: "project",
    sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    worktreePath: "/projects/repo",
    ...overrides,
  });
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

  it("returns true when an existing model/effort changes to undefined", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        undefined,
        undefined,
      ),
    ).toBe(true);
  });

  it("returns false when runtime and desired model/effort are both undefined", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: undefined, reasoningEffort: undefined },
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

  it("returns true when the alignment version advanced (3 -> 4)", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          alignmentVersion: 3,
        },
        "a",
        "low",
        undefined,
        4,
      ),
    ).toBe(true);
  });

  it("returns false when the alignment version is unchanged (3 === 3)", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          alignmentVersion: 3,
        },
        "a",
        "low",
        undefined,
        3,
      ),
    ).toBe(false);
  });

  it("returns false when both alignment versions are null", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          alignmentVersion: null,
        },
        "a",
        "low",
        undefined,
        null,
      ),
    ).toBe(false);
  });

  it("returns true when the charter was deactivated (3 -> null)", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          alignmentVersion: 3,
        },
        "a",
        "low",
        undefined,
        null,
      ),
    ).toBe(true);
  });

  it("returns true when a charter became active (null -> 3)", () => {
    expect(
      shouldRecreateRuntime(
        {
          status: "alive",
          modelId: "a",
          reasoningEffort: "low",
          alignmentVersion: null,
        },
        "a",
        "low",
        undefined,
        3,
      ),
    ).toBe(true);
  });

  it("treats a missing runtime alignmentVersion as null (no recreate when desired is null)", () => {
    expect(
      shouldRecreateRuntime(
        { status: "alive", modelId: "a", reasoningEffort: "low" },
        "a",
        "low",
        undefined,
        null,
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
      ".debug/conv/instrumentation.json",
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
      ".debug/conv/instrumentation.json",
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
      reproductionSteps: [] as string[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = buildEffectivePrompt(
      "help debug",
      false,
      [],
      debugMode,
      "http://debug-url",
      ".debug/conv/instrumentation.json",
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
      reproductionSteps: [] as string[],
      instructionsDelivered: true,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = buildEffectivePrompt(
      "help debug",
      false,
      [],
      debugMode,
      "http://debug-url",
      ".debug/conv/instrumentation.json",
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
      ".debug/conv/instrumentation.json",
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
      reproductionSteps: [] as string[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = buildEffectivePrompt(
      "check this",
      true,
      blocks,
      debugMode,
      "http://debug-url",
      ".debug/conv/instrumentation.json",
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

// ===========================================================================
// Unit tests: resolveBackendTurnSettings
// ===========================================================================

describe("resolveBackendTurnSettings", () => {
  const baseConfig: ActorConfig = {
    claudeTimeoutMs: 300_000,
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };

  it("returns Claude config.defaultModel when backend is claude", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "opus",
      effectiveEffort: undefined,
    });
  });

  it("returns explicit model over Claude default", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(
      resolveBackendTurnSettings("claude", config, "sonnet", null),
    ).toEqual({ effectiveModel: "sonnet", effectiveEffort: undefined });
  });

  it("returns Claude defaultEffort when backend is claude", () => {
    const config = {
      ...baseConfig,
      defaultModel: "opus",
      defaultEffort: "high",
    };
    expect(resolveBackendTurnSettings("claude", config, null, null)).toEqual({
      effectiveModel: "opus",
      effectiveEffort: "high",
    });
  });

  it("returns Codex config defaults when backend is codex", () => {
    const config = {
      ...baseConfig,
      codex: { model: "o3", reasoningEffort: "high" },
    };
    expect(resolveBackendTurnSettings("codex", config, null, null)).toEqual({
      effectiveModel: "o3",
      effectiveEffort: "high",
    });
  });

  it("returns explicit over Codex defaults", () => {
    const config = {
      ...baseConfig,
      codex: { model: "o3", reasoningEffort: "high" },
    };
    expect(resolveBackendTurnSettings("codex", config, "gpt-5", "low")).toEqual(
      { effectiveModel: "gpt-5", effectiveEffort: "low" },
    );
  });

  it("returns undefined for Codex when no config and no explicit", () => {
    expect(resolveBackendTurnSettings("codex", baseConfig, null, null)).toEqual(
      { effectiveModel: undefined, effectiveEffort: undefined },
    );
  });

  it("does not fall back to Claude defaults for Codex backend", () => {
    const config = { ...baseConfig, defaultModel: "opus" };
    expect(resolveBackendTurnSettings("codex", config, null, null)).toEqual({
      effectiveModel: undefined,
      effectiveEffort: undefined,
    });
  });
});

// ===========================================================================
// Unit tests: resolveBackendTimeoutMs
// ===========================================================================

describe("resolveBackendTimeoutMs", () => {
  const baseConfig: ActorConfig = {
    claudeTimeoutMs: 300_000,
    maxTurns: 50,
    idleQuerySessionTtlMs: 300_000,
  };

  it("returns claudeTimeoutMs for claude backend", () => {
    expect(resolveBackendTimeoutMs("claude", baseConfig)).toBe(300_000);
  });

  it("returns codex timeoutMs unchanged when configured", () => {
    const config = { ...baseConfig, codex: { timeoutMs: 120_000 } };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(120_000);
  });

  it("returns 0 (no timeout) for codex when timeoutMs is empty", () => {
    const config = { ...baseConfig, codex: {} };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(0);
  });

  it("returns 0 (no timeout) when codex timeoutMs is null", () => {
    const config = { ...baseConfig, codex: { timeoutMs: null } };
    expect(resolveBackendTimeoutMs("codex", config)).toBe(0);
  });

  it("returns 0 (no timeout) when codex config is undefined", () => {
    expect(resolveBackendTimeoutMs("codex", baseConfig)).toBe(0);
  });
});

// ===========================================================================
// Unit tests: shouldBuildRuntimeSyntheticSeed
// ===========================================================================

describe("shouldBuildRuntimeSyntheticSeed", () => {
  const forkedFromBase = {
    sourceConversationId: "src",
    messageIndex: 1,
    sourceBackend: "claude",
    sourceBackendRef: null,
    forkLocator: null,
    forkMode: null,
  };

  it("returns false for a new (non-forked) conversation", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: null,
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("returns false for Claude native fork (backendRef populated)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, forkMode: "native" },
        backendRef: { backend: "claude", sessionId: "s" },
        agentBackend: "claude",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("returns false for Claude synthetic fallback — seed already in pendingPromptText", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, forkMode: "synthetic" },
        backendRef: null,
        agentBackend: "claude",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(false);
  });

  it("returns false for Claude case 3 (user fork at index 0)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: {
          ...forkedFromBase,
          messageIndex: 0,
          sourceBackend: null,
          sourceBackendRef: null,
        },
        backendRef: null,
        agentBackend: "claude",
        transcriptPath: null,
      }),
    ).toBe(false);
  });

  it("returns true for non-Claude fork with a transcript and no backendRef", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: { ...forkedFromBase, sourceBackend: "codex" },
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: "/p.jsonl",
      }),
    ).toBe(true);
  });

  it("returns false for non-Claude case 3 (no transcript)", () => {
    expect(
      shouldBuildRuntimeSyntheticSeed({
        forkedFrom: {
          ...forkedFromBase,
          messageIndex: 0,
          sourceBackend: null,
          sourceBackendRef: null,
        },
        backendRef: null,
        agentBackend: "codex",
        transcriptPath: null,
      }),
    ).toBe(false);
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

  it("maps assistant thinking and redacted_thinking blocks into thinking content blocks", async () => {
    const emit = vi.fn();
    const appendEntry = vi.fn(async () => {});
    const contentBlocks: unknown[] = [];

    await processMessage(
      {
        type: "assistant",
        uuid: "msg-think",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "Two candidates: a regression, or a stale selector.",
              signature: "sig-abc",
            },
            { type: "redacted_thinking", data: "encrypted-blob" },
            { type: "text", text: "The component is correct." },
          ],
        },
      } as never,
      "conv-1",
      emit,
      contentBlocks as never,
      appendEntry,
    );

    // Reasoning is surfaced as distinct thinking blocks, in order, ahead of the
    // answer — streamed live AND persisted to the transcript (not dropped).
    expect(emit).toHaveBeenCalledWith("content", {
      type: "thinking",
      text: "Two candidates: a regression, or a stale selector.",
    });
    expect(emit).toHaveBeenCalledWith("content", {
      type: "thinking",
      text: "",
      redacted: true,
    });
    expect(contentBlocks).toEqual([
      {
        type: "thinking",
        text: "Two candidates: a regression, or a stale selector.",
      },
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "The component is correct." },
    ]);

    expect(appendEntry).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        role: "assistant",
        content: [
          {
            type: "thinking",
            text: "Two candidates: a regression, or a stale selector.",
          },
          { type: "thinking", text: "", redacted: true },
          { type: "text", text: "The component is correct." },
        ],
      }),
    );
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

  it("acquires conversation lock and query slot", async () => {
    const releaseLock = vi.fn();
    const releaseSlot = vi.fn();
    vi.mocked(mockDeps.acquireConversationLock).mockReturnValue(releaseLock);
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

    expect(mockDeps.acquireConversationLock).toHaveBeenCalledWith(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${input.sessionName}`,
    );
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");

    const runtime = getConversationRuntime(key);
    expect(runtime?.releaseConversationLock).toBe(releaseLock);
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

  it("skips conversation lock acquisition when skipConversationLock is set on runtime", async () => {
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
      skipConversationLock: true,
    });

    const result = await prepareTurnForMachine(input);

    // Conversation lock should NOT be acquired
    expect(mockDeps.acquireConversationLock).not.toHaveBeenCalled();
    // Query slot should still be acquired
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${input.sessionName}`,
    );
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");

    // Runtime should NOT have a releaseConversationLock
    const runtime = getConversationRuntime(key);
    expect(runtime?.releaseConversationLock).toBeUndefined();
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
    compacted: false,
    error: null,
  };

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();

    mockDeps = createMockDeps();
    setActorDeps(mockDeps);

    mockSendTurn.mockResolvedValue(defaultTurnResult);
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
    mockFactory.validateModelAndEffort.mockImplementation(() => {});
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
    expect(mockFactory.validateModelAndEffort).toHaveBeenCalledWith({
      modelId: "opus",
      reasoningEffort: undefined,
    });
    expect(result.backendRef).toEqual({
      backend: "claude",
      sessionId: "sdk-session-1",
    });
    expect(result.costUsd).toBe(0.05);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("reuses an existing alive backend runtime", async () => {
    const existingRuntime = createMockBackendRuntime({ modelId: "opus" });
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
    expect(mockFactory.validateModelAndEffort).toHaveBeenCalledWith({
      modelId: "opus",
      reasoningEffort: undefined,
    });
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

  describe("pre-turn readiness gate", () => {
    it("recreates the runtime (resume-preserving) before streamInput when readiness asks for it, then delivers", async () => {
      const reusedPrepare = vi.fn().mockResolvedValue({
        status: "recreate-runtime",
        reason: "rebind_failed",
      });
      const reusedSendTurn = vi.fn();
      const reused = createMockBackendRuntime({
        modelId: "opus",
        prepareForTurnStart: reusedPrepare,
        sendTurn: reusedSendTurn,
      });

      const freshSendTurn = vi.fn().mockResolvedValue(defaultTurnResult);
      const freshPrepare = vi.fn().mockResolvedValue({ status: "ready" });
      const fresh = createMockBackendRuntime({
        modelId: "opus",
        prepareForTurnStart: freshPrepare,
        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(fresh);

      const input = makeExecutePromptInput({
        backendRef: { backend: "claude", sessionId: "sdk-session-resume" },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        input.sessionName,
        input.conversationId,
      );
      registerConversationRuntime(key, {
        abortController: new AbortController(),
        backendRuntime: reused,
      });

      const result = await executePromptForMachine(input);

      // Reused runtime failed readiness → recreated once, retried → ready.
      expect(reusedPrepare).toHaveBeenCalledTimes(1);
      expect(reused.close).toHaveBeenCalledTimes(1);
      expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
      expect(freshPrepare).toHaveBeenCalledTimes(1);
      // The original runtime never delivered; the fresh one did.
      expect(reusedSendTurn).not.toHaveBeenCalled();
      expect(freshSendTurn).toHaveBeenCalledTimes(1);
      expect(result.error).toBeNull();

      // Resume continuity: the recreated runtime resumes the same session.
      expect(mockFactory.createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          persistedRef: { backend: "claude", sessionId: "sdk-session-resume" },
        }),
      );
    });

    it("fails the prompt before streamInput when readiness fails twice (no delivery)", async () => {
      const reusedPrepare = vi.fn().mockResolvedValue({
        status: "recreate-runtime",
        reason: "rebind_failed",
      });
      const reusedSendTurn = vi.fn();
      const reused = createMockBackendRuntime({
        modelId: "opus",
        prepareForTurnStart: reusedPrepare,
        sendTurn: reusedSendTurn,
      });

      const freshPrepare = vi.fn().mockResolvedValue({
        status: "recreate-runtime",
        reason: "still_broken",
      });
      const freshSendTurn = vi.fn();
      const fresh = createMockBackendRuntime({
        modelId: "opus",
        prepareForTurnStart: freshPrepare,
        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(fresh);

      const input = makeExecutePromptInput();
      const key = conversationRuntimeKey(
        input.projectPath,
        input.sessionName,
        input.conversationId,
      );
      registerConversationRuntime(key, {
        abortController: new AbortController(),
        backendRuntime: reused,
      });

      const result = await executePromptForMachine(input);

      expect(reusedPrepare).toHaveBeenCalledTimes(1);
      expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
      expect(freshPrepare).toHaveBeenCalledTimes(1);
      // Neither runtime ever delivered a turn.
      expect(reusedSendTurn).not.toHaveBeenCalled();
      expect(freshSendTurn).not.toHaveBeenCalled();
      expect(result.error).toContain("runtime unrecoverable");
    });
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
    // The Claude backend natively validates the schema and returns a
    // populated structuredOutput; mirror that here so the shared
    // structured-output gate pass-through path runs cleanly.
    mockSendTurn.mockResolvedValueOnce({
      ...defaultTurnResult,
      structuredOutput: {},
    });

    const input = makeExecutePromptInput({
      debugMode: {
        active: true,
        recording: false,
        logFilePath: "/tmp/.debug/logs.jsonl",
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: false,
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

  it("uses config-derived Codex model and effort for actor-side validation", async () => {
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        claudeTimeoutMs: 300_000,
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
        codex: { model: "gpt-5.4", reasoningEffort: "high" },
      })),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(mockFactory.validateModelAndEffort).toHaveBeenCalledWith({
      modelId: "gpt-5.4",
      reasoningEffort: "high",
    });
  });

  it("returns a failed result when actor-side validation rejects config-derived defaults", async () => {
    const streamEmit = vi.fn();
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        claudeTimeoutMs: 300_000,
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
        codex: { model: "gpt-5.4", reasoningEffort: "max" },
      })),
    });
    setActorDeps(mockDeps);
    mockFactory.validateModelAndEffort.mockImplementation(() => {
      throw new Error('Invalid Codex reasoning effort: "max"');
    });

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await executePromptForMachine(input);

    expect(result.error).toBe('Invalid Codex reasoning effort: "max"');
    expect(mockDeps.safeAppendTranscriptEntry).not.toHaveBeenCalled();
    expect(mockFactory.createRuntime).not.toHaveBeenCalled();
    expect(streamEmit).toHaveBeenCalledWith("error", {
      message: 'Invalid Codex reasoning effort: "max"',
    });
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

  it("drains Claude capability idle work when a caller turn fails", async () => {
    const applyCapabilityWhenIdle = vi.fn(async () => ({}));
    mockDeps = createMockDeps({ applyCapabilityWhenIdle });
    setActorDeps(mockDeps);
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
    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
    expect(applyCapabilityWhenIdle).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      worktreePath: input.worktreePath,
      backend: "claude",
    });
  });

  it("retries once with a fresh runtime when prompt delivery never reached backend", async () => {
    const staleSendTurn = vi.fn();
    const staleRuntime = createMockBackendRuntime({
      sendTurn: staleSendTurn,
      modelId: "opus",
    });
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

  it("marks timeout-driven aborts with timeout metadata", async () => {
    vi.useFakeTimers();
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        claudeTimeoutMs: 25,
        defaultModel: "opus",
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
        defaultEffort: undefined,
      })),
    });
    setActorDeps(mockDeps);
    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) =>
        new Promise<ConversationBackendTurnResult>((_, reject) => {
          turnInput.signal.addEventListener(
            "abort",
            () => reject(new Error("closed while running")),
            { once: true },
          );
        }),
    );

    try {
      const input = makeExecutePromptInput();
      const key = conversationRuntimeKey(
        input.projectPath,
        input.sessionName,
        input.conversationId,
      );
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });

      const resultPromise = executePromptForMachine(input);

      await vi.advanceTimersByTimeAsync(25);
      const result = await resultPromise;

      expect(result.aborted).toBe(true);
      expect(result.abortReason).toBe("timeout");
      expect(result.timeoutMs).toBe(25);
      expect(result.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a fresh abort controller when a previous turn left the runtime controller aborted", async () => {
    const staleAbortController = new AbortController();
    staleAbortController.abort();

    let capturedSignal: AbortSignal | undefined;
    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        capturedSignal = turnInput.signal;
        return defaultTurnResult;
      },
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: staleAbortController,
    });

    const result = await executePromptForMachine(input);
    const runtime = getConversationRuntime(key);

    expect(result.aborted).toBe(false);
    expect(capturedSignal?.aborted).toBe(false);
    expect(runtime?.abortController).not.toBe(staleAbortController);
    expect(runtime?.abortController.signal.aborted).toBe(false);
    expect(mockDeps.registerAbortController).toHaveBeenCalledWith(
      input.conversationId,
      runtime?.abortController,
    );
  });

  it("aborts the controller before closing the runtime when the safety-net timeout fires", async () => {
    vi.mocked(mockDeps.readConfig).mockResolvedValue({
      claudeTimeoutMs: 30,
      defaultModel: "opus",
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
      defaultEffort: undefined,
    });

    const events: string[] = [];
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });

    const closingRuntime = createMockBackendRuntime({
      close: vi.fn(() => {
        events.push(
          abortController.signal.aborted ? "close-after-abort" : "close",
        );
      }),
    });
    mockFactory.createRuntime.mockResolvedValueOnce(closingRuntime);

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await new Promise<void>((_resolve, reject) => {
          turnInput.signal.addEventListener("abort", () => {
            reject(new Error("QuerySession closed while turn was in progress"));
          });
        });
        throw new Error("unreachable");
      },
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, { abortController });

    await executePromptForMachine(input);

    expect(events).toContain("abort");
    expect(events).toContain("close-after-abort");
    expect(events.indexOf("abort")).toBeLessThan(
      events.indexOf("close-after-abort"),
    );
    expect(events).not.toContain("close");
  });

  it("merges portable MCP tooling overrides from runtime state into factory.createRuntime", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "transient-tool",
              transport: "streamable-http",
              url: "http://127.0.0.1:3000/api/projects/project/sessions/session/mcp/graph-workflow/execution-1/contexts/context-1",
            },
          ],
        },
      },
    });

    await executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      portableMcp?: { servers: Array<{ id: string }> };
    };
    expect(tooling.portableMcp?.servers.map((server) => server.id)).toEqual(
      expect.arrayContaining(["gateway-alpha", "transient-tool"]),
    );
  });

  it("delegates portable MCP composition to composePortableMcpForConversation with full conversation identity", async () => {
    const transient = {
      servers: [
        {
          id: "transient-tool",
          transport: "streamable-http" as const,
          url: "http://127.0.0.1:3000/graph",
        },
      ],
    };

    const input = makeExecutePromptInput({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "sess-a",
      conversationId: "conv-xyz",
      worktreePath: "/projects/repo/.worktrees/sess-a",
      agentBackend: "claude",
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      tooling: { portableMcp: transient },
    });

    await executePromptForMachine(input);

    expect(mockDeps.composePortableMcpForConversation).toHaveBeenCalledTimes(1);
    expect(mockDeps.composePortableMcpForConversation).toHaveBeenCalledWith({
      backend: "claude",
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "sess-a",
      conversationId: "conv-xyz",
      worktreePath: "/projects/repo/.worktrees/sess-a",
      transientPortableMcp: transient,
    });
  });

  it("passes the composed portable MCP result through to factory.createRuntime tooling", async () => {
    const composed = {
      servers: [
        {
          id: "gateway-alpha",
          transport: "streamable-http" as const,
          url: "http://localhost:3000/api/projects/repo/sessions/sess/mcp",
        },
        {
          id: "disabled-by-session",
          transport: "stdio" as const,
          command: "/bin/echo",
          enabled: false,
        },
      ],
    };
    mockDeps = createMockDeps({
      composePortableMcpForConversation: vi.fn(async () => composed),
    });
    setActorDeps(mockDeps);

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

    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      portableMcp?: { servers: Array<{ id: string }> };
    };
    expect(tooling.portableMcp).toBe(composed);
  });

  it("applies MCP at turn start on a reused runtime before sendTurn", async () => {
    const reusedRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
    });
    const applyMcpAtTurnStart = vi.fn(async () => ({
      conversationId: "conv-1",
      backend: "codex" as const,
      disposition: "applied_now" as const,
      effectiveConfigHash: "hash-codex",
    }));
    mockDeps = createMockDeps({ applyMcpAtTurnStart });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: reusedRuntime,
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "server-1",
              transport: "stdio",
              command: "node",
            },
          ],
        },
      },
    });

    await executePromptForMachine(input);

    expect(applyMcpAtTurnStart).toHaveBeenCalledTimes(1);
    expect(applyMcpAtTurnStart).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      sessionName: "test-session",
      conversationId: "conv-1",
      backend: "codex",
    });
    expect(applyMcpAtTurnStart.mock.invocationCallOrder[0]).toBeLessThan(
      (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    );
  });

  it("fails fast when turn-start MCP apply is rejected on a reused runtime", async () => {
    const streamEmit = vi.fn();
    const reusedRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    const applyMcpAtTurnStart = vi.fn(async () => ({
      conversationId: "conv-1",
      backend: "codex" as const,
      disposition: "rejected" as const,
      effectiveConfigHash: "hash-codex",
      error: "server-1: unsupported field",
    }));
    mockDeps = createMockDeps({ applyMcpAtTurnStart });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: reusedRuntime,
      streamEmit,
      tooling: {
        portableMcp: {
          servers: [
            {
              id: "server-1",
              transport: "stdio",
              command: "node",
            },
          ],
        },
      },
    });

    const result = await executePromptForMachine(input);

    expect(reusedRuntime.sendTurn).not.toHaveBeenCalled();
    expect(result.error).toContain(
      "Failed to apply portable MCP configuration",
    );
    expect(result.error).toContain("server-1: unsupported field");
    expect(streamEmit).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        message: expect.stringContaining(
          "Failed to apply portable MCP configuration",
        ),
      }),
    );
  });

  it("seeds lastAppliedConfigHash from the created runtime portable MCP so the next turn can no-op", async () => {
    const composed = {
      servers: [
        {
          id: "gateway-alpha",
          transport: "streamable-http" as const,
          url: "http://localhost:3000/api/projects/repo/sessions/test-session/mcp",
        },
        {
          id: "server-1",
          transport: "stdio" as const,
          command: "node",
        },
      ],
    };
    const conversationState = {} as {
      mcpRuntime?: {
        lastAppliedConfigHash?: string;
        pendingConfigHash?: string;
        pendingServerKeys?: string[];
        lastApplyDisposition?: string;
        lastApplyError?: string;
      };
    };
    const mutateConversation = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        _conversationId: string,
        _label: string,
        mutate: (conversation: typeof conversationState) => void,
      ) => {
        mutate(conversationState);
      },
    );
    const applyMcpAtTurnStart = vi.fn(async () => {
      if (conversationState.mcpRuntime?.lastAppliedConfigHash === undefined) {
        throw new Error("expected seeded hash before reused turn");
      }
      return {
        conversationId: "conv-1",
        backend: "claude" as const,
        disposition: "applied_now" as const,
        effectiveConfigHash: conversationState.mcpRuntime.lastAppliedConfigHash,
      };
    });
    const reusedRuntime = createMockBackendRuntime({ modelId: "opus" });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultTurnResult,
    );
    mockFactory.createRuntime.mockResolvedValue(reusedRuntime);
    mockDeps = createMockDeps({
      composePortableMcpForConversation: vi.fn(async () => composed),
      mutateConversation,
      applyMcpAtTurnStart,
    });
    setActorDeps(mockDeps);

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

    const expectedHash = computeEffectiveConfigHash(composed);
    expect(conversationState.mcpRuntime?.lastAppliedConfigHash).toBe(
      expectedHash,
    );
    expect(conversationState.mcpRuntime?.lastApplyDisposition).toBe(
      "applied_now",
    );

    vi.clearAllMocks();
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: reusedRuntime,
    });

    await executePromptForMachine(input);

    expect(applyMcpAtTurnStart).toHaveBeenCalledTimes(1);
    expect(reusedRuntime.sendTurn).toHaveBeenCalledTimes(1);
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
      portableMcp?: { servers: Array<{ id: string }> };
    };
    expect(tooling.portableMcp?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "gateway-alpha" }),
      ]),
    );
  });

  it("seeds Claude capability config + persists runtime state for new runtimes", async () => {
    const seededConfig: ClaudeRuntimeCapabilityConfig = {
      enabledPlugins: {},
      skillOverrides: { "skill-alpha": "on" },
      disabledAgentNames: [],
      agentSuppressionStrategy: {
        kind: "permission-layer",
        applyPoint: "next-conversation",
        interceptedToolNames: ["Task"],
      },
    };
    const seededRuntimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "claude-skills": {
          appliedHash: "hash-claude-skills",
          lastApplyStatus: "applied",
        },
      },
    };
    const composeClaudeCapabilityConfigForConversation: ActorImplementationDeps["composeClaudeCapabilityConfigForConversation"] =
      vi.fn(async () => ({
        config: seededConfig,
        runtimeState: seededRuntimeState,
      }));
    let capturedSeed: AgentCapabilityRuntimeApplicationState | undefined;
    const mutateConversation: ActorImplementationDeps["mutateConversation"] =
      vi.fn(
        async (_projectPath, _sessionName, _conversationId, label, mutate) => {
          if (label === "prompt.seedCapabilityRuntime") {
            const stub = {} as ConversationState;
            mutate(stub);
            capturedSeed = stub.agentCapabilitiesRuntime;
          }
        },
      );

    mockDeps = createMockDeps({
      composeClaudeCapabilityConfigForConversation,
      mutateConversation,
    });
    setActorDeps(mockDeps);

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

    expect(composeClaudeCapabilityConfigForConversation).toHaveBeenCalledTimes(
      1,
    );
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      claudeCapabilityConfig?: ClaudeRuntimeCapabilityConfig;
    };
    expect(tooling.claudeCapabilityConfig).toBe(seededConfig);
    expect(capturedSeed).toBe(seededRuntimeState);
    const labels = (
      mutateConversation as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[3]);
    expect(labels).toContain("prompt.seedCapabilityRuntime");
  });

  it("delivers seeded Codex capability config at first turn start before sendTurn", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const seededConfig: CodexRuntimeCapabilityConfig = {
      config: {
        verifiedSkillConfig: { "skill-alpha": false },
      } as unknown as CodexRuntimeCapabilityConfig["config"],
    };
    const seededRuntimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "codex-skills": {
          pendingHash: "hash-codex-skills",
          pendingItemIds: ["skill-alpha"],
          lastApplyStatus: "staged-next-turn",
        },
      },
    };
    const composeCodexCapabilityConfigForConversation: ActorImplementationDeps["composeCodexCapabilityConfigForConversation"] =
      vi.fn(async () => ({
        config: seededConfig,
        runtimeState: seededRuntimeState,
      }));
    const applyCapabilityAtTurnStart = vi.fn<
      ActorImplementationDeps["applyCapabilityAtTurnStart"]
    >(async () => ({}));

    mockDeps = createMockDeps({
      composeCodexCapabilityConfigForConversation,
      applyCapabilityAtTurnStart,
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(composeCodexCapabilityConfigForConversation).toHaveBeenCalledTimes(
      1,
    );
    expect(applyCapabilityAtTurnStart).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "test-session",
      conversationId: "conv-1",
      worktreePath: "/projects/repo/.worktrees/test-session",
      backend: "codex",
    });
    expect(applyCapabilityAtTurnStart.mock.invocationCallOrder[0]).toBeLessThan(
      (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    );
  });

  it("does not persist capability runtime state when compose returns undefined", async () => {
    const mutateConversation: ActorImplementationDeps["mutateConversation"] =
      vi.fn(async () => {});
    mockDeps = createMockDeps({
      composeClaudeCapabilityConfigForConversation: vi.fn(
        async () => undefined,
      ),
      mutateConversation,
    });
    setActorDeps(mockDeps);

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

    const labels = (
      mutateConversation as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[3]);
    expect(labels).not.toContain("prompt.seedCapabilityRuntime");
  });

  it("seeds Claude project-conversation capability config from the project composer", async () => {
    const seededConfig: ClaudeRuntimeCapabilityConfig = {
      enabledPlugins: { "plugin-alpha": true },
      skillOverrides: { "skill-alpha": "on" },
      disabledAgentNames: [],
      agentSuppressionStrategy: {
        kind: "permission-layer",
        applyPoint: "next-conversation",
        interceptedToolNames: ["Task"],
      },
    };
    const seededRuntimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "claude-skills": {
          appliedHash: "hash-claude-skills",
          lastApplyStatus: "applied",
        },
      },
    };
    const composeCapabilityConfigForProjectConversation = vi.fn(async () => ({
      backend: "claude" as const,
      config: seededConfig,
      runtimeState: seededRuntimeState,
    }));
    let capturedSeed: AgentCapabilityRuntimeApplicationState | undefined;
    const mutateConversation: ActorImplementationDeps["mutateConversation"] =
      vi.fn(
        async (_projectPath, _sessionName, _conversationId, label, mutate) => {
          if (label === "prompt.seedCapabilityRuntime") {
            const stub = {} as ConversationState;
            mutate(stub);
            capturedSeed = stub.agentCapabilitiesRuntime;
          }
        },
      );

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
      mutateConversation,
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(composeCapabilityConfigForProjectConversation).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      conversationId: "conv-1",
    });
    expect(
      mockDeps.composeClaudeCapabilityConfigForConversation,
    ).not.toHaveBeenCalled();
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      claudeCapabilityConfig?: ClaudeRuntimeCapabilityConfig;
    };
    expect(tooling.claudeCapabilityConfig).toBe(seededConfig);
    expect(capturedSeed).toBe(seededRuntimeState);
  });

  it("seeds Codex project-conversation capability config and applies turn start with project identity", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const seededConfig: CodexRuntimeCapabilityConfig = {
      config: {
        verifiedSkillConfig: { "skill-alpha": false },
      } as unknown as CodexRuntimeCapabilityConfig["config"],
    };
    const seededRuntimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "codex-skills": {
          pendingHash: "hash-codex-skills",
          pendingItemIds: ["skill-alpha"],
          lastApplyStatus: "staged-next-turn",
        },
      },
    };
    const composeCapabilityConfigForProjectConversation = vi.fn(async () => ({
      backend: "codex" as const,
      config: seededConfig,
      runtimeState: seededRuntimeState,
    }));
    const applyCapabilityAtTurnStart = vi.fn<
      ActorImplementationDeps["applyCapabilityAtTurnStart"]
    >(async () => ({}));

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
      applyCapabilityAtTurnStart,
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      codexCapabilityConfig?: CodexRuntimeCapabilityConfig;
    };
    expect(tooling.codexCapabilityConfig).toBe(seededConfig);
    expect(applyCapabilityAtTurnStart).toHaveBeenCalledWith({
      conversationScope: "project",
      projectPath: "/projects/repo",
      projectName: "repo",
      conversationId: "conv-1",
      worktreePath: "/projects/repo",
      backend: "codex",
    });
    expect(applyCapabilityAtTurnStart.mock.invocationCallOrder[0]).toBeLessThan(
      (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    );
  });

  it("does not switch a project-conversation backend from the project composer result", async () => {
    const composeCapabilityConfigForProjectConversation = vi.fn(async () => ({
      backend: "codex" as const,
      config: {
        config: {},
      } as CodexRuntimeCapabilityConfig,
      runtimeState: { cascades: {} },
    }));

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(mockDeps.getConversationBackendFactory).toHaveBeenCalledWith(
      "claude",
    );
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(createCall["persistedRef"]).toBeNull();
    expect(createCall["tooling"]).not.toHaveProperty("codexCapabilityConfig");
  });

  it("emits a non-blocking diagnostic when project-conversation composition fails", async () => {
    const streamEmit = vi.fn();
    const composeCapabilityConfigForProjectConversation = vi.fn(async () => {
      throw new Error("cascade failed");
    });

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await executePromptForMachine(input);

    expect(result.error).toBeNull();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(streamEmit).toHaveBeenCalledWith("error", {
      message:
        "Project conversation capability configuration could not be fully composed: cascade failed",
    });
  });

  it("emits non-blocking diagnostics returned by project-conversation composition", async () => {
    const streamEmit = vi.fn();
    const diagnostics: AgentCapabilityDiagnostic[] = [
      {
        severity: "error",
        code: "claude-skill-discovery-failed",
        message: "Claude skill discovery failed",
        cascadeKind: "claude-skills",
        backend: "claude",
      },
    ];
    const composeCapabilityConfigForProjectConversation = vi.fn(async () => ({
      kind: "diagnostics-only" as const,
      backend: "claude" as const,
      diagnostics,
    }));

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await executePromptForMachine(input);

    expect(result.error).toBeNull();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(createCall["tooling"]).not.toHaveProperty("claudeCapabilityConfig");
    expect(streamEmit).toHaveBeenCalledWith("error", {
      message:
        "Project conversation capability configuration issue: Claude skill discovery failed",
    });
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
        reproductionSteps: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: false,
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

  it("substitutes an absolute manifest path under the worktree into debug prompts", async () => {
    const worktreePath = "/projects/repo/.worktrees/test-session";
    const conversationId = "conv-abs-manifest";
    const input = makeExecutePromptInput({
      worktreePath,
      conversationId,
      promptText: "Help me debug this",
      debugMode: {
        active: true,
        recording: false,
        logFilePath: `${worktreePath}/.debug/${conversationId}/logs.jsonl`,
        enteredAt: "2024-01-01T00:00:00Z",
        hypotheses: [],
        reproductionSteps: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
        fixSummary: null,
        verificationSteps: [],
        lastTurnFailed: false,
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
    const expectedAbsManifest = `${worktreePath}/.debug/${conversationId}/instrumentation.json`;
    expect(turnInput.promptText).toContain(expectedAbsManifest);
    expect(turnInput.promptText).not.toMatch(
      /(?<![A-Za-z0-9/_.-])\.debug\/conv-abs-manifest\/instrumentation\.json/,
    );
  });

  it("writes system, assistant, and result transcript entries for non-Claude backends", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({
          type: "backend_init",
          backendRef: { backend: "codex" as const, threadId: "thread-1" },
        });
        await turnInput.onEvent({
          type: "content",
          block: { type: "text", text: "Codex says hello" },
        });
        return {
          ...defaultTurnResult,
          backendRef: { backend: "codex" as const, threadId: "thread-1" },
          contentBlocks: [{ type: "text" as const, text: "Codex says hello" }],
        };
      },
    );
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const systemEntry = calls.find(
      ([, entry]) => (entry as { type?: string }).type === "system",
    );
    const assistantEntry = calls.find(
      ([, entry]) => (entry as { role?: string }).role === "assistant",
    );
    const resultEntry = calls.find(
      ([, entry]) => (entry as { type?: string }).type === "result",
    );
    expect(systemEntry).toBeDefined();
    expect(systemEntry![1]).toEqual(
      expect.objectContaining({
        type: "system",
        raw: {
          subtype: "init",
          backend: "codex",
          thread_id: "thread-1",
        },
      }),
    );
    expect(assistantEntry).toBeDefined();
    expect((assistantEntry![1] as { content: unknown }).content).toEqual([
      { type: "text", text: "Codex says hello" },
    ]);
    expect(resultEntry).toBeDefined();
    expect(resultEntry![1]).toEqual(
      expect.objectContaining({
        type: "result",
        raw: expect.objectContaining({
          backend: "codex",
          backendRef: { backend: "codex", threadId: "thread-1" },
          aborted: false,
          error: null,
        }),
      }),
    );
  });

  it("does not write extra assistant transcript for Claude backends", async () => {
    const input = makeExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const assistantEntries = calls.filter(
      ([, entry]) => (entry as { role?: string }).role === "assistant",
    );
    expect(assistantEntries).toHaveLength(0);
  });

  it("writes only a result transcript entry when no non-Claude content blocks were produced", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
      contentBlocks: [],
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const assistantEntries = calls.filter(
      ([, entry]) => (entry as { role?: string }).role === "assistant",
    );
    const resultEntries = calls.filter(
      ([, entry]) => (entry as { type?: string }).type === "result",
    );
    expect(assistantEntries).toHaveLength(0);
    expect(resultEntries).toHaveLength(1);
  });

  it("writes assistant and result transcript entries for aborted non-Claude turns with partial content", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
      contentBlocks: [{ type: "text", text: "Partial Codex output" }],
      aborted: true,
      error: null,
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const assistantEntries = calls.filter(
      ([, entry]) => (entry as { role?: string }).role === "assistant",
    );
    const resultEntries = calls.filter(
      ([, entry]) => (entry as { type?: string }).type === "result",
    );
    expect(assistantEntries).toHaveLength(1);
    expect(resultEntries).toHaveLength(1);
    expect(resultEntries[0]![1]).toEqual(
      expect.objectContaining({
        raw: expect.objectContaining({
          aborted: true,
          backendRef: { backend: "codex", threadId: "thread-1" },
        }),
      }),
    );
  });

  it("emits an SSE error when a non-Claude runtime returns turnResult.error without an earlier error event", async () => {
    const streamEmit = vi.fn();
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, threadId: "thread-1" },
      error: "Codex failed after streaming",
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    await executePromptForMachine(input);

    const errorEvents = streamEmit.mock.calls.filter(
      ([event]) => event === "error",
    );
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]![1]).toEqual({
      message: "Codex failed after streaming",
    });
  });

  it("does not emit a duplicate SSE error when the runtime already emitted one", async () => {
    const streamEmit = vi.fn();
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({
          type: "error",
          message: "Codex failed after streaming",
        });
        return {
          ...defaultTurnResult,
          backendRef: { backend: "codex" as const, threadId: "thread-1" },
          error: "Codex failed after streaming",
        };
      },
    );
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    await executePromptForMachine(input);

    const errorEvents = streamEmit.mock.calls.filter(
      ([event]) => event === "error",
    );
    expect(errorEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------
  // Shared structured-output gate — both streaming conversation_turn
  // and single-shot task_run paths must funnel structured-output
  // extraction and validation through applyStructuredOutputGate so
  // workflows see one normalized outcome.
  // ---------------------------------------------------------------
  it("consumes the shared gate's parsed structuredOutput when the backend leaves it unset and the gate parses it from text", async () => {
    mockSendTurn.mockResolvedValueOnce({
      ...defaultTurnResult,
      contentBlocks: [{ type: "text", text: '{"answer":42}' }],
      structuredOutput: undefined,
    });

    const input = makeExecutePromptInput({
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
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

    expect(result.structuredOutput).toEqual({ answer: 42 });
    expect(result.error).toBeNull();
  });

  it("surfaces a schema_validation failure from the shared gate as PromptActorResult.error when the backend's structuredOutput violates the schema", async () => {
    const streamEmit = vi.fn();
    mockSendTurn.mockResolvedValueOnce({
      ...defaultTurnResult,
      contentBlocks: [{ type: "text", text: "shape mismatch" }],
      structuredOutput: { answer: "forty-two" },
    });

    const input = makeExecutePromptInput({
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await executePromptForMachine(input);

    expect(result.error).toMatch(/structured output failed validation/i);
    expect(result.aborted).toBe(false);
    const errorEvents = streamEmit.mock.calls.filter(
      ([event]) => event === "error",
    );
    expect(errorEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------
  // Task 6.1 parity — the conversation actor must route every turn
  // through the shared AgentCall primitive instead of calling
  // backendRuntime.sendTurn() directly. The injected dep stays on
  // the call path so test code can assert primitive composition
  // without falling back to vi.mock on internal modules.
  // ---------------------------------------------------------------
  it("routes the conversation turn through deps.executeAgentCall (Task 6.1 parity)", async () => {
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    setActorDeps(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
      } as unknown as Partial<ActorImplementationDeps>),
    );

    const input = makeExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request, facadeDeps] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "conversation_turn",
      prompt: "Hello, world!",
      backend: "claude",
      writeCapability: "write_capable",
    });
    expect(typeof facadeDeps.resolveConversationRuntime).toBe("function");
  });

  // ---------------------------------------------------------------
  // Document feedback threading (Task 7.1). With a documentFeedback payload
  // the user turn records a document_feedback block (card-only, no duplicate
  // prose block) and the agent-facing prompt is derived from the payload when
  // no explicit text is supplied. Without the payload the turn is unchanged.
  // ---------------------------------------------------------------
  it("records a document_feedback block and derives agent text from the payload when no explicit text is supplied", async () => {
    const fbItem = {
      docPath: "design.md",
      path: "design.md",
      headingLabel: "Prompt pipeline",
      line: 42,
      quote: "the exact passage to review",
      note: "please reconsider this section",
    };
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const appendSpy = vi.fn<
      ActorImplementationDeps["safeAppendTranscriptEntry"]
    >(async () => {});
    setActorDeps(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
        safeAppendTranscriptEntry: appendSpy,
      } as unknown as Partial<ActorImplementationDeps>),
    );

    const input = makeExecutePromptInput({
      promptText: "",
      documentFeedback: { items: [fbItem] },
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

    // Agent-facing prompt is derived from the payload and embeds each item's
    // quote, path, heading, and line.
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    const prompt = (request as { prompt: string }).prompt;
    expect(prompt).toContain(fbItem.path);
    expect(prompt).toContain(fbItem.headingLabel);
    expect(prompt).toContain("L42");
    expect(prompt).toContain(fbItem.quote);
    expect(prompt).toContain(fbItem.note);

    // The user turn's transcript content is the document_feedback card only —
    // no duplicate prose text block.
    const userEntry = appendSpy.mock.calls
      .map((c) => c[1] as { type: string; content: unknown })
      .find((e) => e.type === "user");
    expect(userEntry?.content).toEqual([
      { type: "document_feedback", items: [fbItem] },
    ]);
  });

  it("leaves the user turn unchanged (text only, no feedback block) when documentFeedback is absent", async () => {
    const appendSpy = vi.fn<
      ActorImplementationDeps["safeAppendTranscriptEntry"]
    >(async () => {});
    setActorDeps(createMockDeps({ safeAppendTranscriptEntry: appendSpy }));

    const input = makeExecutePromptInput({ promptText: "Hello, world!" });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    await executePromptForMachine(input);

    const userEntry = appendSpy.mock.calls
      .map((c) => c[1] as { type: string; content: unknown })
      .find((e) => e.type === "user");
    expect(userEntry?.content).toEqual([
      { type: "text", text: "Hello, world!" },
    ]);
  });

  // A drained queued batch can coalesce a normal text message with a feedback
  // message (both non-command). The user text is genuine prompt text (the queue
  // dropped the feedback prose at enqueue), so the agent must receive BOTH the
  // user text AND the derived feedback prose, and the transcript must record the
  // user text block alongside the document_feedback card — neither is dropped.
  // (Requirement 8.2, 8.4)
  it("drained mixed batch delivers user text + derived feedback to the agent and records both in the transcript", async () => {
    const fbItem = {
      docPath: "design.md",
      path: "design.md",
      headingLabel: "Prompt pipeline",
      line: 42,
      quote: "the exact passage to review",
      note: "please reconsider this section",
    };
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const appendSpy = vi.fn<
      ActorImplementationDeps["safeAppendTranscriptEntry"]
    >(async () => {});
    setActorDeps(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
        safeAppendTranscriptEntry: appendSpy,
      } as unknown as Partial<ActorImplementationDeps>),
    );

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({ type: "input_accepted" });
        return defaultTurnResult;
      },
    );

    const input = makeExecutePromptInput({
      promptText: "also handle the empty-state case",
      documentFeedback: { items: [fbItem] },
      queuedDelivery: { messageIds: ["m1", "m2"], deliveryAttemptId: "att-1" },
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

    // Agent receives the user's text AND the derived feedback prose.
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    const prompt = (request as { prompt: string }).prompt;
    expect(prompt).toContain("also handle the empty-state case");
    expect(prompt).toContain(fbItem.path);
    expect(prompt).toContain(fbItem.headingLabel);
    expect(prompt).toContain("L42");
    expect(prompt).toContain(fbItem.quote);
    expect(prompt).toContain(fbItem.note);

    // The transcript records the user text block AND the document_feedback card.
    const userEntry = appendSpy.mock.calls
      .map((c) => c[1] as { type: string; content: unknown })
      .find((e) => e.type === "user");
    expect(userEntry?.content).toEqual([
      { type: "text", text: "also handle the empty-state case" },
      { type: "document_feedback", items: [fbItem] },
    ]);
  });

  // ---------------------------------------------------------------
  // Background-task wait threading (Task 4.1). The opt-in flag must
  // flow ExecutePromptInput → ConversationBackendTurnInput, and the
  // backgroundWait summary must flow the turn result → PromptActorResult.
  // Uses the real executeAgentCall facade so the full down/up path runs
  // through production code rather than a mock.
  // ---------------------------------------------------------------
  it("threads waitForBackgroundTasks down to the turn input and the backgroundWait summary back up", async () => {
    const capturedTurnInput: { value: ConversationBackendTurnInput | null } = {
      value: null,
    };
    const backgroundWait = {
      waitedTaskIds: ["task-a"],
      settledTaskIds: ["task-a"],
      timedOut: false,
      durationMs: 1234,
    };
    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        capturedTurnInput.value = turnInput;
        return { ...defaultTurnResult, backgroundWait };
      },
    );

    const input = makeExecutePromptInput({ waitForBackgroundTasks: true });
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });

    const result = await executePromptForMachine(input);

    expect(capturedTurnInput.value?.waitForBackgroundTasks).toBe(true);
    expect(result.backgroundWait).toEqual(backgroundWait);
  });

  it("leaves waitForBackgroundTasks unset and omits backgroundWait for a non-opted-in turn", async () => {
    const capturedTurnInput: { value: ConversationBackendTurnInput | null } = {
      value: null,
    };
    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        capturedTurnInput.value = turnInput;
        return { ...defaultTurnResult };
      },
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

    expect(capturedTurnInput.value?.waitForBackgroundTasks).toBeUndefined();
    expect(result.backgroundWait).toBeUndefined();
  });

  // ---------------------------------------------------------------
  // Image flow: server-side cumulative numbering + persisted paths.
  // ---------------------------------------------------------------
  describe("image attachment flow", () => {
    it("assigns server indices, persists images by index, rewrites markers, and forwards imageRefs to the backend", async () => {
      const saveTranscriptImage = vi.fn(
        async (
          _id: string,
          index: number,
          mediaType: string,
        ): Promise<string> => {
          const ext = mediaType.split("/")[1] ?? "bin";
          return `/persisted/${index}.${ext}`;
        },
      );
      const getNextImageIndex = vi.fn(async () => 5);

      mockDeps = createMockDeps({
        saveTranscriptImage,
        getNextImageIndex,
      });
      setActorDeps(mockDeps);

      const input = makeExecutePromptInput({
        promptText: "look at [Image #1] and [Image #2]",
        images: [
          {
            attachmentId: "att-a",
            mediaType: "image/png",
            base64Data: "AAAA",
            inlineMarkerIndex: 1,
          },
          {
            attachmentId: "att-b",
            mediaType: "image/jpeg",
            base64Data: "BBBB",
            inlineMarkerIndex: 2,
          },
          {
            attachmentId: "att-c",
            mediaType: "image/webp",
            base64Data: "CCCC",
          },
        ],
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

      expect(getNextImageIndex).toHaveBeenCalledWith(input.conversationId);

      expect(saveTranscriptImage).toHaveBeenCalledTimes(3);
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        1,
        input.conversationId,
        5,
        "image/png",
        "AAAA",
      );
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        2,
        input.conversationId,
        6,
        "image/jpeg",
        "BBBB",
      );
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        3,
        input.conversationId,
        7,
        "image/webp",
        "CCCC",
      );

      const sendTurnCall = mockSendTurn.mock.calls[0]! as unknown[];
      const turnInput = sendTurnCall[0] as ConversationBackendTurnInput;
      expect(turnInput.promptText).toBe("look at [Image #5] and [Image #6]");
      expect(turnInput.imageRefs).toEqual([
        {
          index: 5,
          mediaType: "image/png",
          path: "/persisted/5.png",
          base64Data: "AAAA",
        },
        {
          index: 6,
          mediaType: "image/jpeg",
          path: "/persisted/6.jpeg",
          base64Data: "BBBB",
        },
        {
          index: 7,
          mediaType: "image/webp",
          path: "/persisted/7.webp",
          base64Data: "CCCC",
        },
      ]);

      const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
      const userEntry = calls.find(
        ([, entry]) => (entry as { role?: string }).role === "user",
      );
      expect(userEntry).toBeDefined();
      const content = (userEntry![1] as { content: unknown[] }).content;
      expect(content).toEqual([
        { type: "text", text: "look at " },
        {
          type: "image_marker",
          index: 5,
          mediaType: "image/png",
          imagePath: "/persisted/5.png",
        },
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: "/persisted/5.png",
        },
        { type: "text", text: " and " },
        {
          type: "image_marker",
          index: 6,
          mediaType: "image/jpeg",
          imagePath: "/persisted/6.jpeg",
        },
        {
          type: "image_ref",
          mediaType: "image/jpeg",
          imagePath: "/persisted/6.jpeg",
        },
        {
          type: "image_marker",
          index: 7,
          mediaType: "image/webp",
          imagePath: "/persisted/7.webp",
        },
        {
          type: "image_ref",
          mediaType: "image/webp",
          imagePath: "/persisted/7.webp",
        },
      ]);
    });

    it("does not call getNextImageIndex when there are no images", async () => {
      const getNextImageIndex = vi.fn(async () => 1);
      mockDeps = createMockDeps({ getNextImageIndex });
      setActorDeps(mockDeps);

      const input = makeExecutePromptInput({ images: [] });
      const key = conversationRuntimeKey(
        input.projectPath,
        input.sessionName,
        input.conversationId,
      );
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });

      await executePromptForMachine(input);

      expect(getNextImageIndex).not.toHaveBeenCalled();

      const sendTurnCall = mockSendTurn.mock.calls[0]! as unknown[];
      const turnInput = sendTurnCall[0] as ConversationBackendTurnInput;
      expect(turnInput.imageRefs).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // Queued-delivery transcript policy: for queued turns the single
  // coalesced user transcript entry is appended only AFTER backend
  // acceptance (`input_accepted`), and the claimed queue rows are
  // marked delivered only after that append succeeds. If acceptance
  // never happens, no user entry is appended and the rows return to
  // pending. (Requirements 2.4, 4.1, 4.2, 7.2, 7.3, 8.2)
  // ---------------------------------------------------------------
  describe("queued-delivery transcript policy", () => {
    function userAppendCalls() {
      return vi
        .mocked(mockDeps.safeAppendTranscriptEntry)
        .mock.calls.filter(
          ([, entry]) => (entry as { role?: string }).role === "user",
        );
    }

    it("appends exactly one user transcript entry after backend acceptance and marks rows delivered", async () => {
      const appendOrder: string[] = [];
      mockDeps = createMockDeps({
        safeAppendTranscriptEntry: vi.fn(async (_id, entry) => {
          if ((entry as { role?: string }).role === "user") {
            appendOrder.push("append");
          }
        }),
        markQueuedDelivered: vi.fn(async () => {
          appendOrder.push("markDelivered");
        }),
      });
      setActorDeps(mockDeps);

      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      const input = makeExecutePromptInput({
        promptText: "queued follow-up",
        queuedDelivery: {
          messageIds: ["m1", "m2"],
          deliveryAttemptId: "att-1",
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

      const userCalls = userAppendCalls();
      expect(userCalls).toHaveLength(1);
      expect((userCalls[0]![1] as { id?: string }).id).toBe("m1");
      expect((userCalls[0]![1] as { content: unknown }).content).toEqual([
        { type: "text", text: "queued follow-up" },
      ]);

      expect(mockDeps.markQueuedDelivered).toHaveBeenCalledTimes(1);
      expect(mockDeps.markQueuedDelivered).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        ids: ["m1", "m2"],
        deliveryAttemptId: "att-1",
      });
      expect(mockDeps.markQueuedPending).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedFailed).not.toHaveBeenCalled();

      // Append must happen before the rows are marked delivered.
      expect(appendOrder).toEqual(["append", "markDelivered"]);
    });

    it("does not append a second user entry when input_accepted fires more than once", async () => {
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      const input = makeExecutePromptInput({
        promptText: "queued follow-up",
        queuedDelivery: {
          messageIds: ["m1"],
          deliveryAttemptId: "att-1",
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

      expect(userAppendCalls()).toHaveLength(1);
      expect(mockDeps.markQueuedDelivered).toHaveBeenCalledTimes(1);
    });

    it("appends nothing and returns rows to pending when acceptance never happens (turn completes without input_accepted)", async () => {
      mockSendTurn.mockResolvedValue(defaultTurnResult);

      const input = makeExecutePromptInput({
        promptText: "queued follow-up",
        queuedDelivery: {
          messageIds: ["m1", "m2"],
          deliveryAttemptId: "att-1",
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

      expect(userAppendCalls()).toHaveLength(0);
      expect(mockDeps.markQueuedDelivered).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedPending).toHaveBeenCalledTimes(1);
      expect(mockDeps.markQueuedPending).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          ids: ["m1", "m2"],
          deliveryAttemptId: "att-1",
        }),
      );
    });

    it("appends nothing and returns rows to pending when the turn throws before acceptance", async () => {
      mockSendTurn.mockRejectedValue(new Error("backend dispatch failed"));

      const input = makeExecutePromptInput({
        promptText: "queued follow-up",
        queuedDelivery: {
          messageIds: ["m1"],
          deliveryAttemptId: "att-1",
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

      expect(userAppendCalls()).toHaveLength(0);
      expect(mockDeps.markQueuedDelivered).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedPending).toHaveBeenCalledTimes(1);
      expect(mockDeps.markQueuedPending).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["m1"],
          deliveryAttemptId: "att-1",
        }),
      );
    });

    it("does not return rows to pending after a successful delivery", async () => {
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      const input = makeExecutePromptInput({
        promptText: "queued follow-up",
        queuedDelivery: {
          messageIds: ["m1"],
          deliveryAttemptId: "att-1",
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

      expect(mockDeps.markQueuedDelivered).toHaveBeenCalledTimes(1);
      expect(mockDeps.markQueuedPending).not.toHaveBeenCalled();
    });

    it("normal (non-queued) turns append exactly one user entry at dispatch and never touch queue marks", async () => {
      mockSendTurn.mockResolvedValue(defaultTurnResult);

      const input = makeExecutePromptInput({ promptText: "normal prompt" });
      const key = conversationRuntimeKey(
        input.projectPath,
        input.sessionName,
        input.conversationId,
      );
      registerConversationRuntime(key, {
        abortController: new AbortController(),
      });

      await executePromptForMachine(input);

      const userCalls = userAppendCalls();
      expect(userCalls).toHaveLength(1);
      expect((userCalls[0]![1] as { id?: string }).id).toBe(input.streamId);
      expect((userCalls[0]![1] as { content: unknown }).content).toEqual([
        { type: "text", text: "normal prompt" },
      ]);
      expect(mockDeps.markQueuedDelivered).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedPending).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedFailed).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// Integration tests: alignment charter injection into the per-turn seam
// ===========================================================================

describe("executePromptForMachine alignment injection", () => {
  let mockDeps: ActorImplementationDeps;

  const turnResult: ConversationBackendTurnResult = {
    backendRef: { backend: "claude", sessionId: "sdk-session-align" },
    costUsd: 0.01,
    durationMs: 100,
    numTurns: 1,
    contextTokens: 100,
    contextWindowMax: 200000,
    contentBlocks: [{ type: "text", text: "ok" }],
    aborted: false,
    compacted: false,
    error: null,
  };

  function makeSessionState(
    overrides: Partial<SessionState> = {},
  ): SessionState {
    return sessionStateSchema.parse({
      sessionName: "test-session",
      worktreePath: "/projects/repo/.worktrees/test-session",
      branchName: "csm/test-session",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      creationMode: "normal",
      ...overrides,
    });
  }

  /** The `sessionInstructions` array passed to the single createRuntime call. */
  function capturedSessionInstructions(): string[] {
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    return createCall["sessionInstructions"] as string[];
  }

  /** The `alignmentVersion` passed to the single createRuntime call. */
  function capturedAlignmentVersion(): number | null {
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    return createCall["alignmentVersion"] as number | null;
  }

  function registerFreshRuntime(input: ExecutePromptInput): void {
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
    });
  }

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    mockSendTurn.mockResolvedValue(turnResult);
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
    mockFactory.validateModelAndEffort.mockImplementation(() => {});
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  const injection: AlignmentInjection = {
    version: 3,
    contentHash: "h",
    text: "GOVERNING TEXT for the active charter",
  };

  it("injects the active charter governing section for a normal attended session", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => injection),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(injection.text);
    expect(instructions).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBe(3);
    expect(mockDeps.getActiveAlignmentInjection).toHaveBeenCalledWith(
      input.projectPath,
      input.sessionName,
    );
  });

  it("injects the one-line cctl CLI nudge into every session's instructions", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(CC_CLI_INSTRUCTIONS);
    expect(CC_CLI_INSTRUCTIONS).not.toContain("\n");
  });

  it("injects the /align suggestion when a normal session has no active charter", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBeNull();
  });

  it("injects neither the charter nor the suggestion for an optimistic session", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () =>
        makeSessionState({ creationMode: "optimistic" }),
      ),
      getActiveAlignmentInjection: vi.fn(async () => injection),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).not.toContain(injection.text);
    expect(instructions).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBeNull();
    expect(mockDeps.getActiveAlignmentInjection).not.toHaveBeenCalled();
  });

  it("injects neither the charter nor the suggestion on an autonomous turn", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => injection),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ autonomous: true });
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).not.toContain(injection.text);
    expect(instructions).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBeNull();
    expect(mockDeps.getActiveAlignmentInjection).not.toHaveBeenCalled();
  });

  it("selects the enabled ask-question variant when askUserQuestionsEnabled is true", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput({ askUserQuestionsEnabled: true });
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(ASK_QUESTION_INSTRUCTIONS_ENABLED);
    expect(instructions).not.toContain(ASK_QUESTION_INSTRUCTIONS);
  });

  it("keeps the default ask-question variant when the flag is unset", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(ASK_QUESTION_INSTRUCTIONS);
    expect(instructions).not.toContain(ASK_QUESTION_INSTRUCTIONS_ENABLED);
  });

  it("injects neither the charter nor the suggestion for a project conversation", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => null),
      getActiveAlignmentInjection: vi.fn(async () => injection),
    });
    setActorDeps(mockDeps);

    const input = makeProjectExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).not.toContain(injection.text);
    expect(instructions).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBeNull();
    expect(mockDeps.getActiveAlignmentInjection).not.toHaveBeenCalled();
  });

  it("never injects the removed <objective> tag and leaves reference docs passive", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => injection),
      getReferenceDocuments: vi.fn(async () => [
        { filePath: "docs/spec.md", description: "the spec" },
      ]),
    });
    setActorDeps(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions.some((s) => s.includes("<objective>"))).toBe(false);
    const referenceBlock = instructions.find((s) =>
      s.includes("## Reference Documents"),
    );
    expect(referenceBlock).toBeDefined();
    expect(referenceBlock).toContain("Read them when relevant");
    expect(referenceBlock).not.toContain(injection.text);
  });

  it("recreates a live runtime and records the new seen-version when the active version advanced", async () => {
    const recordedMutations: Array<{ label: string; version: number | null }> =
      [];
    const mutateConversation = vi.fn(
      async (
        _projectPath: string,
        _sessionName: string,
        _conversationId: string,
        label: string,
        mutate: (c: ConversationState) => void,
      ) => {
        const conversationState = {
          lastSeenAlignmentVersion: null,
        } as unknown as ConversationState;
        mutate(conversationState);
        recordedMutations.push({
          label,
          version: conversationState.lastSeenAlignmentVersion,
        });
      },
    );

    // The charter advanced to version 4: the active injection and the cheap
    // version accessor both report 4, while the live runtime still carries 3.
    const advancedInjection: AlignmentInjection = { ...injection, version: 4 };
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => advancedInjection),
      getActiveAlignmentVersion: vi.fn(async () => 4),
      mutateConversation,
    });
    setActorDeps(mockDeps);

    const staleClose = vi.fn();
    const staleRuntime = createMockBackendRuntime({
      modelId: "opus",
      alignmentVersion: 3,
      close: staleClose,
    });
    const freshRuntime = createMockBackendRuntime({
      modelId: "opus",
      alignmentVersion: 4,
    });
    (freshRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      turnResult,
    );
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

    await executePromptForMachine(input);

    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(mockDeps.unregisterBackendRuntime).toHaveBeenCalledWith(
      input.conversationId,
    );
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(capturedAlignmentVersion()).toBe(4);

    const seenRecording = recordedMutations.find(
      (m) => m.label === "prompt.recordSeenAlignmentVersion",
    );
    expect(seenRecording).toBeDefined();
    expect(seenRecording?.version).toBe(4);
  });

  it("reuses a live runtime when the active version is unchanged", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => injection),
      getActiveAlignmentVersion: vi.fn(async () => 3),
    });
    setActorDeps(mockDeps);

    const reusedClose = vi.fn();
    const reusedRuntime = createMockBackendRuntime({
      modelId: "opus",
      alignmentVersion: 3,
      close: reusedClose,
    });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      turnResult,
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    registerConversationRuntime(key, {
      abortController: new AbortController(),
      backendRuntime: reusedRuntime,
    });

    await executePromptForMachine(input);

    expect(reusedClose).not.toHaveBeenCalled();
    expect(mockDeps.unregisterBackendRuntime).not.toHaveBeenCalled();
    expect(mockFactory.createRuntime).not.toHaveBeenCalled();
    expect(reusedRuntime.sendTurn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Integration tests (8.1): guaranteed propagation to already-running runtimes
// ===========================================================================

describe("executePromptForMachine alignment propagation to live runtimes", () => {
  const BAKED_VERSION = 1;
  const ADVANCED_VERSION = 2;
  const NEW_CHARTER_TEXT =
    "<session-charter>\nThis governs the session; conflicts resolve via its hierarchy and active decisions.\nMission: deliver guaranteed per-turn propagation.\n</session-charter>";

  function makeNormalSession(): SessionState {
    return sessionStateSchema.parse({
      sessionName: "test-session",
      worktreePath: "/projects/repo/.worktrees/test-session",
      branchName: "csm/test-session",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      creationMode: "normal",
    });
  }

  function capturedCreateInput(): Record<string, unknown> {
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    return (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
  }

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    mockFactory.validateModelAndEffort.mockImplementation(() => {});
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  // The load-bearing regression (R7.3): a baked-once injection would reuse the
  // live runtime and never deliver the advanced charter. Version-gated
  // recreation must close the stale runtime and rebuild instructions carrying
  // the new charter — for BOTH backend runtime types — while preserving
  // conversation continuity (the recreated runtime resumes the same session).
  for (const backend of ["claude", "codex"] as const) {
    it(`recreates an already-running ${backend} runtime with the advanced charter and preserves continuity`, async () => {
      const advancedInjection: AlignmentInjection = {
        version: ADVANCED_VERSION,
        contentHash: "hash-v2",
        text: NEW_CHARTER_TEXT,
      };
      const recordedSeen: Array<number | null> = [];
      const mutateConversation = vi.fn(
        async (
          _projectPath: string,
          _sessionName: string,
          _conversationId: string,
          label: string,
          mutate: (c: ConversationState) => void,
        ) => {
          if (label !== "prompt.recordSeenAlignmentVersion") return;
          const c = {
            lastSeenAlignmentVersion: null,
          } as unknown as ConversationState;
          mutate(c);
          recordedSeen.push(c.lastSeenAlignmentVersion);
        },
      );

      const mockDeps = createMockDeps({
        getSessionState: vi.fn(async () => makeNormalSession()),
        getActiveAlignmentVersion: vi.fn(async () => ADVANCED_VERSION),
        getActiveAlignmentInjection: vi.fn(async () => advancedInjection),
        mutateConversation,
      });
      setActorDeps(mockDeps);

      // The continuity handle for the live session: the recreated runtime must
      // resume it via persistedRef so conversation history is not lost. The
      // backend ref is discriminated — Claude resumes by sessionId, Codex by
      // threadId.
      const continuityRef =
        backend === "claude"
          ? ({ backend: "claude", sessionId: "sdk-claude-live" } as const)
          : ({ backend: "codex", threadId: "thread-codex-live" } as const);

      // An already-running runtime whose instructions were baked at the PRIOR
      // charter version — the "baked once" state this regression guards against.
      const staleClose = vi.fn();
      const staleRuntime = createMockBackendRuntime({
        backend,
        modelId: "opus",
        alignmentVersion: BAKED_VERSION,
        close: staleClose,
      });

      const freshSendTurn = vi.fn().mockResolvedValue({
        backendRef: continuityRef,
        costUsd: 0.01,
        durationMs: 100,
        numTurns: 1,
        contextTokens: 100,
        contextWindowMax: 200000,
        contentBlocks: [{ type: "text", text: "ok" }],
        aborted: false,
        compacted: false,
        error: null,
      } satisfies ConversationBackendTurnResult);
      const freshRuntime = createMockBackendRuntime({
        backend,
        modelId: "opus",
        alignmentVersion: ADVANCED_VERSION,
        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(freshRuntime);

      // Pin the model so model/effort/outputFormat all match the live runtime
      // (config-derived codex model would otherwise resolve to undefined and
      // trigger a model-change recreation) — isolating the alignment version as
      // the SOLE recreation trigger this regression exercises.
      const input = makeExecutePromptInput({
        agentBackend: backend,
        backendRef: continuityRef,
        modelId: "opus",
      });
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

      // Recreated, not reused.
      expect(staleClose).toHaveBeenCalledTimes(1);
      expect(mockDeps.unregisterBackendRuntime).toHaveBeenCalledWith(
        input.conversationId,
      );
      expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);

      // Rebuilt instructions carry the NEW charter governing section + version.
      const createInput = capturedCreateInput();
      expect(createInput["sessionInstructions"] as string[]).toContain(
        NEW_CHARTER_TEXT,
      );
      expect(createInput["alignmentVersion"]).toBe(ADVANCED_VERSION);

      // Continuity: the recreated runtime resumes the same backend session.
      expect(createInput["persistedRef"]).toEqual(continuityRef);
      expect(freshSendTurn).toHaveBeenCalledTimes(1);
      expect(result.backendRef).toEqual(continuityRef);

      // Stale detection: the conversation records the version it actually ran with.
      expect(recordedSeen).toContain(ADVANCED_VERSION);
    });
  }
});

// ===========================================================================
// Integration tests: runTaskRunTurnForMachine (task_run branch)
// ===========================================================================

describe("runTaskRunTurnForMachine", () => {
  function makeRunTaskRunInput(
    overrides: Partial<RunTaskRunInput> = {},
  ): RunTaskRunInput {
    return {
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "test-session",
      worktreePath: "/projects/repo/.worktrees/test-session",
      conversationId: "conv-1",
      agentBackend: "claude",
      backendRef: null,
      promptText: "do the task",
      modelId: null,
      effort: null,
      ...overrides,
    };
  }

  function makeMockTaskRunner(
    runImpl: (req: AgentTaskRequest) => Promise<AgentTaskResult>,
  ): AgentTaskRunner {
    return {
      backend: "claude" as const,
      run: vi.fn(runImpl),
    };
  }

  let mockDeps: ActorImplementationDeps;

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetActorDepsForTesting();
    _resetForTesting();
  });

  it("task_run WITHOUT outputFormat: persists exactly one assistant TranscriptMessage and forwards content blocks", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "task complete",
      usage: { inputTokens: 100, outputTokens: 20 },
      error: null,
      timedOut: false,
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    setActorDeps(mockDeps);

    const input = makeRunTaskRunInput();
    const result = await runTaskRunTurnForMachine(input);

    const appendCalls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock
      .calls;
    expect(appendCalls).toHaveLength(1);

    const [conversationId, entry, broadcastMeta] = appendCalls[0]!;
    expect(conversationId).toBe("conv-1");
    expect((entry as { role?: string }).role).toBe("assistant");
    expect((entry as { type?: string }).type).toBe("assistant");
    expect((entry as { content?: unknown }).content).toEqual([
      { type: "text", text: "task complete" },
    ]);
    expect(broadcastMeta).toEqual({
      projectName: "repo",
      sessionName: "test-session",
    });

    expect(result.contentBlocks).toEqual([
      { type: "text", text: "task complete" },
    ]);
    expect(result.error).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("task_run WITH outputFormat: routes outputSchema through applyStructuredOutputGate, persists one assistant entry, and exposes the parsed structuredOutput", async () => {
    const runner = makeMockTaskRunner(async (req) => {
      expect(req.outputSchema).toEqual({
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      });
      return {
        backendRef: null,
        text: '{"result":"ok"}',
        usage: null,
        error: null,
        timedOut: false,
      };
    });

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    setActorDeps(mockDeps);

    const input = makeRunTaskRunInput({
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
        },
      },
    });

    const result = await runTaskRunTurnForMachine(input);

    const appendCalls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock
      .calls;
    expect(appendCalls).toHaveLength(1);
    expect((appendCalls[0]![1] as { role?: string }).role).toBe("assistant");

    expect(result.structuredOutput).toEqual({ result: "ok" });
    expect(result.contentBlocks).toEqual([
      { type: "text", text: '{"result":"ok"}' },
    ]);
    expect(result.error).toBeNull();
    expect(result.aborted).toBe(false);
  });

  it("task_run failure surfaces aborted=true when failureKind is aborted and persists no transcript entry", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: null,
      usage: null,
      error: "user aborted",
      timedOut: false,
    }));

    const executeAgentCallSpy = vi.fn(async () => ({
      backend: "claude" as const,
      backendRef: null,
      capabilities: {
        backend: "claude" as const,
        nativeStructuredOutput: false,
        nativeAskUserQuestion: false,
        nativeSessionResumption: false,
        portableMcpScope: "between_turns" as const,
        forkSemantics: "synthetic_seed" as const,
      },
      usage: {},
      artifacts: [],
      outcome: {
        kind: "failed" as const,
        error: {
          failureKind: "aborted" as const,
          backend: "claude" as const,
          message: "user aborted",
        },
      },
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorImplementationDeps>);
    setActorDeps(mockDeps);

    const result = await runTaskRunTurnForMachine(makeRunTaskRunInput());

    expect(result.aborted).toBe(true);
    expect(result.error).toBe("user aborted");
    expect(result.contentBlocks).toEqual([]);
    expect(
      vi.mocked(mockDeps.safeAppendTranscriptEntry),
    ).not.toHaveBeenCalled();
  });

  it("task_run failure preserves captured backend transcript without appending an assistant message", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: null,
      usage: null,
      error: "backend error",
      timedOut: false,
    }));
    const transcript = [
      {
        seq: 0,
        backend: "claude" as const,
        type: "assistant",
        raw: { type: "assistant", text: "partial analysis" },
      },
    ];

    const executeAgentCallSpy = vi.fn(async () => ({
      backend: "claude" as const,
      backendRef: null,
      capabilities: {
        backend: "claude" as const,
        nativeStructuredOutput: false,
        nativeAskUserQuestion: false,
        nativeSessionResumption: false,
        portableMcpScope: "between_turns" as const,
        forkSemantics: "synthetic_seed" as const,
      },
      usage: {},
      artifacts: [],
      outcome: {
        kind: "failed" as const,
        transcript,
        error: {
          failureKind: "backend_error" as const,
          backend: "claude" as const,
          message: "backend error",
        },
      },
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorImplementationDeps>);
    setActorDeps(mockDeps);

    const result = await runTaskRunTurnForMachine(makeRunTaskRunInput());

    expect(result.error).toBe("backend error");
    expect(result.transcript).toEqual(transcript);
    expect(
      vi.mocked(mockDeps.safeAppendTranscriptEntry),
    ).not.toHaveBeenCalled();
  });

  it("task_run with origin: stamps origin on the appended assistant TranscriptEntry", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "workflow done",
      usage: null,
      error: null,
      timedOut: false,
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    setActorDeps(mockDeps);

    const origin = {
      source: "workflow" as const,
      workflow: {
        executionId: "exec-42",
        nodeId: "node-validate",
        iterationIndex: 2,
      },
    };

    await runTaskRunTurnForMachine(makeRunTaskRunInput({ origin }));

    const appendCalls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock
      .calls;
    expect(appendCalls).toHaveLength(1);
    const entry = appendCalls[0]![1] as { origin?: unknown };
    expect(entry.origin).toEqual(origin);
  });

  it("routes task_run via deps.executeAgentCall with kind='task_run' and write_capable scheduling", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "done",
      usage: null,
      error: null,
      timedOut: false,
    }));
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorImplementationDeps>);
    setActorDeps(mockDeps);

    await runTaskRunTurnForMachine(makeRunTaskRunInput({ promptText: "go" }));

    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request, facadeDeps] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      prompt: "go",
      backend: "claude",
      writeCapability: "write_capable",
    });
    expect(typeof facadeDeps.resolveTaskRunner).toBe("function");
  });
});
