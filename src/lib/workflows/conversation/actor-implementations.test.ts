import { readRuntimeInstructions } from "./runtime-instructions";
import { createCursorTaskRunner } from "@/lib/agent-backends/cursor/task-runner";
import { createScriptedTransport } from "@/lib/agent-backends/cursor/testing/scripted-worker";
import { translatePortableMcpToCursor } from "@/lib/agent-backends/cursor/mcp-translation";
import {
  conversationTargetStoreSessionName,
  targetFromStoreSessionName,
} from "@/lib/conversations/conversation-target";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
async function readInstructionConfiguration(
  deps: ActorFixtureDependencies,
  input: ExecutePromptInput,
) {
  const { repeatableInstructions, alignmentVersion } =
    await readRuntimeInstructions(
      { execution: deps, context: deps },
      input,
      undefined,
    );
  return { repeatableInstructions, alignmentVersion };
}
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import type { ActorFixtureDependencies } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
import { createPendingEntry } from "@/lib/conversations/message-queue-service";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrepareTurnInput, ExecutePromptInput } from "./types";

import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import type {
  ConversationBackgroundActivity,
  ConversationState,
} from "@/lib/conversations/schemas";
import { makeConversationState as makeSharedConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import type { ResolvedCapabilityCascade } from "@/lib/agent-backends/runtime-config";
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

import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type { RunTaskRunInput } from "./types";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { makeUndeliveredPromptFailure } from "@/lib/agent-backends/testing/undelivered-prompt-fixture";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import {
  ASK_QUESTION_INSTRUCTIONS,
  ASK_QUESTION_INSTRUCTIONS_ENABLED,
  CC_CLI_INSTRUCTIONS,
  TDD_INSTRUCTIONS,
} from "@/lib/prompt/sdk-driver";
import type { AlignmentInjection } from "@/lib/session-alignment/render";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createLiveTicketContextProvider } from "@/lib/tickets/live-context";
import { MEMORY_ADVISORY_CONTRACT } from "@/lib/memory/advisory-contract";
import { createMemoryFreshnessEngine } from "@/lib/memory/freshness";
import {
  createMemoryIndexComposer,
  type MemoryIndexEntry,
} from "@/lib/memory/index-composer";
import {
  createMemoryIndexContextProvider,
  type PreparedMemoryIndexDelivery,
} from "@/lib/memory/index-live-context";
import { createMemoryService } from "@/lib/memory/service";
import { openMemoryContributionGate } from "@/lib/memory/testing/contribution-gate";
import { resolveBoundSpecExecution } from "@/lib/specs/execution-service";
import { createMemoryTelemetryService } from "@/lib/memory/telemetry";
import { createMemoryRepo } from "@/lib/state-store/memory-repo";
import { createMemoryTelemetryRepo } from "@/lib/state-store/memory-telemetry-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecExecutionBindingRepo } from "@/lib/state-store/spec-execution-binding-repo";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createActorDependenciesFixture,
  createMockBackendRuntime as createMockBackendRuntimeFixture,
} from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { createLockManager } from "@/lib/prompt/single-flight";
import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  safeAppendTranscriptEntry as realSafeAppendTranscriptEntry,
  safeAppendTranscriptEntryOnce as realSafeAppendTranscriptEntryOnce,
  readConversationMessages as readPersistedConversationMessages,
  setTranscriptDeps,
  _resetTranscriptDepsForTesting,
} from "@/lib/prompt/transcript";
import type {
  TranscriptBroadcastMeta,
  TranscriptEntry,
} from "@/lib/prompt/transcript";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";

// ---------------------------------------------------------------------------
// Shared mock backend runtime
// ---------------------------------------------------------------------------

const mockSendTurn = vi.fn();

/**
 * This file's own runtime double. It keeps two things the shared fixture's
 * default deliberately does not: the module-level `mockSendTurn` spy that the
 * turn-level assertions read, and a backend-derived default model, which many
 * tests here rely on to construct a Codex runtime without restating the model.
 */
function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  const backend = overrides.backend ?? "claude";
  return {
    ...createMockBackendRuntimeFixture({ backend }),
    modelSelection:
      backend === "codex"
        ? {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "false" },
          }
        : { modelId: "opus", parameters: { effort: "high" } },
    sendTurn: mockSendTurn,
    ...overrides,
  } as ConversationBackendRuntime;
}

const mockBackendRuntime = createMockBackendRuntime();

const mockFactory = {
  backend: "claude" as const,
  createRuntime: vi.fn(
    async (_input: ConversationBackendCreateInput) => mockBackendRuntime,
  ),
  validateModelSelection: vi.fn(),
};

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(
  overrides: Partial<ActorFixtureDependencies> = {},
): ActorFixtureDependencies {
  // Shared fixture, with this file's own backend-runtime factory kept in place:
  // many tests here assert against `mockFactory` / `mockSendTurn` directly.
  return createActorDependenciesFixture({
    getConversationBackendFactory: vi.fn(() => mockFactory),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrepareTurnInput(
  overrides: Partial<PrepareTurnInput> = {},
): PrepareTurnInput {
  return {
    persistence: "durable",
    projectPath: "/projects/repo",
    target: targetFromStoreSessionName(
      overrides.target?.projectName ?? "repo",
      "test-session",
      "conv-1",
    ),

    worktreePath: "/projects/repo/.worktrees/test-session",
    transcriptPath: null,
    ...overrides,
  };
}

function makeExecutePromptInput(
  overrides: Omit<Partial<ExecutePromptInput>, "turn"> & {
    turn?: Partial<ExecutePromptInput["turn"]>;
  } = {},
): ExecutePromptInput {
  return {
    persistence: "durable",
    projectPath: "/projects/repo",
    target: targetFromStoreSessionName("repo", "test-session", "conv-1"),

    worktreePath: "/projects/repo/.worktrees/test-session",

    transcriptPath: "/transcripts/conv-1.jsonl",
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    forkedFrom: null,
    role: null,
    streamId: "stream-1",
    onModelSelectionResolved: async () => {},
    debugMode: null,
    ...overrides,
    turn: {
      kind: "conversation_turn",
      promptText: "Hello, world!",
      images: [],
      modelSelection: null,
      autonomous: false,
      backend: overrides.agentBackend ?? "claude",
      ...overrides.turn,
    },
  };
}

function makeProjectExecutePromptInput(
  overrides: Omit<Partial<ExecutePromptInput>, "turn"> & {
    turn?: Partial<ExecutePromptInput["turn"]>;
  } = {},
): ExecutePromptInput {
  return makeExecutePromptInput({
    target: targetFromStoreSessionName(
      overrides.target?.projectName ?? "repo",
      PROJECT_CONVERSATION_SESSION_SENTINEL,
      overrides.target?.conversationId ?? "conv-1",
    ),

    worktreePath: "/projects/repo",
    ...overrides,
  });
}

// ===========================================================================
// Unit tests: extracted pure functions
// ===========================================================================

// ===========================================================================
// Integration tests: prepareTurnForMachine
// ===========================================================================

describe("prepareTurnForMachine", () => {
  let mockDeps: ActorFixtureDependencies;

  beforeEach(() => {
    _resetForTesting();
    mockDeps = createMockDeps();
    conversationActors = createTestActorImplementations(mockDeps);
  });

  afterEach(() => {
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.prepareTurnForMachine(input);

    expect(mockDeps.acquireConversationLock).toHaveBeenCalledWith(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${conversationTargetStoreSessionName(input.target)}`,
      { signal: undefined },
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.prepareTurnForMachine(input);

    expect(result.transcriptPath).toBe("/existing/path.jsonl");
    expect(mockDeps.getTranscriptPath).not.toHaveBeenCalled();
  });

  it("creates transcript path when not set", async () => {
    const input = makePrepareTurnInput({ transcriptPath: null });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.prepareTurnForMachine(input);

    expect(mockDeps.getTranscriptPath).toHaveBeenCalledWith("conv-1");
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");
  });

  it("throws when runtime state is not registered", async () => {
    const input = makePrepareTurnInput();
    await expect(
      conversationActors.prepareTurnForMachine(input),
    ).rejects.toThrow(/No runtime state/);
  });

  it("acquires the conversation lock even when a caller supplies an obsolete bypass field", async () => {
    const releaseSlot = vi.fn();
    vi.mocked(mockDeps.acquireQuerySlot).mockResolvedValue(releaseSlot);

    const input = makePrepareTurnInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      ...{ skipConversationLock: true },
    });

    const result = await conversationActors.prepareTurnForMachine(input);

    expect(mockDeps.acquireConversationLock).toHaveBeenCalledWith(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    // Query slot should still be acquired
    expect(mockDeps.acquireQuerySlot).toHaveBeenCalledWith(
      `prompt:${conversationTargetStoreSessionName(input.target)}`,
      { signal: undefined },
    );
    expect(result.transcriptPath).toBe("/transcripts/conv-1.jsonl");

    const runtime = getConversationRuntime(key);
    expect(runtime?.releaseConversationLock).toBeTypeOf("function");
    expect(runtime?.releaseQuerySlot).toBe(releaseSlot);
  });
});

// ===========================================================================
// Integration tests: executePromptForMachine
// ===========================================================================

describe("executePromptForMachine", () => {
  let mockDeps: ActorFixtureDependencies;

  const defaultTurnResult: ConversationBackendTurnResult = {
    backendRef: { backend: "claude", ref: "sdk-session-1" },
    costUsd: 0.05,
    durationMs: 1500,
    numTurns: 3,
    contextTokens: 1000,
    contextWindowMax: 200000,
    contentBlocks: [{ type: "text", text: "Hello!" }],
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
  };

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();

    mockDeps = createMockDeps();
    conversationActors = createTestActorImplementations(mockDeps);

    mockSendTurn.mockResolvedValue(defaultTurnResult);
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
    mockFactory.validateModelSelection.mockImplementation(() => {});
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("admits Cursor conversations with instruction-based write limits", async () => {
    const input = makeExecutePromptInput({
      turn: {
        fsWritePolicy: { mode: "allowlist", allowWrite: [], denyWrite: [] },
      },
      agentBackend: "cursor",
    });
    mockSendTurn.mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "cursor", ref: "agent-conversation" },
    });
    mockFactory.createRuntime.mockResolvedValue(
      createMockBackendRuntime({ backend: "cursor", sendTurn: mockSendTurn }),
    );
    conversationActors = createTestActorImplementations(
      createMockDeps({
        getConversationBackendFactory: () => ({
          ...mockFactory,
          backend: "cursor",
        }),
      }),
    );
    const streamEmit = vi.fn();
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
        streamEmit,
      },
    );
    const result = await conversationActors.executePromptForMachine(input);
    expect(result.error).toBeNull();
    expect(mockFactory.createRuntime).toHaveBeenCalled();
    expect(mockSendTurn).toHaveBeenCalled();
    expect(streamEmit).not.toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        code: "backend-governed-execution-unsupported",
      }),
    );
  });

  it.each([false, true])(
    "retains fork history until durable input acceptance (%s)",
    async (accepted) => {
      const fixture = createPersistenceFixture();
      const selection = {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      };
      const input = makeExecutePromptInput({
        turn: {
          modelSelection: selection,
        },
        agentBackend: "cursor",
        backendRef: { backend: "cursor", ref: "agent-created" },
        forkedFrom: {
          sourceConversationId: "source",
          messageIndex: 1,
          forkMode: "synthetic",
          forkPending: false,
          syntheticSeed: "anchored history",
        },
      });
      const seeds: Array<string | null | undefined> = [];
      const backend = createMockBackendRuntime({
        backend: "cursor",
        modelSelection: selection,
        sendTurn: async (turn) => {
          seeds.push(turn.syntheticForkSeed);
          if (accepted) await turn.onEvent({ type: "input_accepted" });
          return { ...defaultTurnResult, backendRef: input.backendRef };
        },
      });
      try {
        fixture.seedProject(input.projectPath);
        fixture.seedSession(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
        );
        await fixture.seedConversation(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          makeSharedConversationState({
            id: input.target.conversationId,
            agentBackend: "cursor",
            backendRef: input.backendRef,
            forkedFrom: input.forkedFrom,
          }),
        );
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getConversation: fixture.store.getConversation,
            mutateConversation: fixture.store.mutateConversation,
            getConversationBackendFactory: () => ({
              backend: "cursor",
              createRuntime: async () => backend,
              validateModelSelection: () => {},
            }),
          }),
        );
        registerConversationRuntime(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
          {
            managed: createManagedRuntimeFixture(
              conversationRuntimeKey(
                input.projectPath,
                conversationTargetStoreSessionName(input.target),
                input.target.conversationId,
              ),
            ),
            abortController: new AbortController(),
          },
        );
        expect(
          (await conversationActors.executePromptForMachine(input)).error,
        ).toBeNull();
        const stored = await fixture
          .recreateStore()
          .getConversation(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          );
        expect(stored?.forkedFrom?.syntheticSeedAcceptedRef).toEqual(
          accepted ? input.backendRef : undefined,
        );
        expect(stored?.forkedFrom?.syntheticSeed).toBe("anchored history");
        expect(
          (await conversationActors.executePromptForMachine(input)).error,
        ).toBeNull();
        expect(seeds).toEqual([
          "anchored history",
          accepted ? null : "anchored history",
        ]);
      } finally {
        fixture.close();
      }
    },
  );

  it("creates a new backend runtime when none exists", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(mockFactory.validateModelSelection).toHaveBeenCalledWith({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-session-1",
    });
    expect(result.costUsd).toBe(0.05);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "Hello!" }]);
  });

  // R1.3: an ORDINARY project turn — not an error path, not the ask route —
  // must not emit the internal sentinel as diagnostic identity. The turn was
  // handed the sentinel as `input.sessionName` (it is the runtime/state-store
  // key), so every structured event that reported a session name leaked it:
  // prompt.runtime_create, prompt.complete, prompt.mcp_seeded, and the rest.
  describe("project-turn diagnostics (R1.3)", () => {
    async function runProjectTurn() {
      const log = createCapturingLogger();
      conversationActors = createTestActorImplementations(
        createMockDeps({ log }),
      );

      const input = makeProjectExecutePromptInput();
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );

      const result = await conversationActors.executePromptForMachine(input);
      return { log, result };
    }

    it("emits no sentinel in any structured log field of a normal turn", async () => {
      const { log, result } = await runProjectTurn();

      // The turn really ran — otherwise "no sentinel logged" is vacuous.
      expect(result.error).toBeNull();
      expect(log.entries.length).toBeGreaterThan(0);
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("reports scope:project with no sessionName key on the turn's own events", async () => {
      const { log } = await runProjectTurn();

      // prompt.complete is emitted by every completed turn; runtime_create by
      // any turn that had to build a runtime. Both previously named the
      // sentinel as `sessionName`.
      const scoped = log.entries.filter(
        (e) =>
          e.message === "prompt.complete" ||
          e.message === "prompt.runtime_create",
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const entry of scoped) {
        expect(entry.fields).toMatchObject({ scope: "project" });
        expect(entry.fields).not.toHaveProperty("sessionName");
      }
    });

    it("still reports the real session name for a session turn", async () => {
      // The fix removes the sentinel, not the diagnostic: a session turn must
      // remain attributable to its session.
      const log = createCapturingLogger();
      conversationActors = createTestActorImplementations(
        createMockDeps({ log }),
      );

      const input = makeExecutePromptInput();
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );
      await conversationActors.executePromptForMachine(input);

      const complete = log.entries.find((e) => e.message === "prompt.complete");
      expect(complete?.fields).toMatchObject({
        scope: "session",
        sessionName: conversationTargetStoreSessionName(input.target),
      });
    });

    // The turn's own log statements are not its only diagnostic sinks: the
    // dispatch it performs hands identity to the runtime-replacement retry
    // policy, which emits two more events from its own module. Those are
    // covered here because the actor now routes them through the SAME injected
    // logger — a module-scoped sink there would be invisible to this test and
    // is exactly how the sentinel survived the previous fix.
    it("emits scope:project from the retry policy's runtime-replacement event", async () => {
      const log = createCapturingLogger();
      conversationActors = createTestActorImplementations(
        createMockDeps({ log }),
      );

      // A dead runtime whose prompt provably never reached the agent — the one
      // shape the policy retries.
      let status: "alive" | "dead" = "alive";
      const dyingRuntime = createMockBackendRuntime();
      Object.defineProperty(dyingRuntime, "status", { get: () => status });
      mockFactory.createRuntime.mockResolvedValue(dyingRuntime);
      mockSendTurn.mockImplementationOnce(() => {
        status = "dead";
        // Neutral seam: the delivery-safety mark plus a message the backend's
        // own classifier calls retryable — no adapter-private error code.
        throw markPromptNotDelivered(
          new Error("No conversation found with session ID: sdk-session-1"),
        );
      });

      const input = makeProjectExecutePromptInput();
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );
      await conversationActors.executePromptForMachine(input);

      const retry = log.entries.find(
        (e) => e.message === "prompt.runtime_retry",
      );
      expect(retry).toBeDefined();
      expect(retry?.fields).toMatchObject({ scope: "project" });
      expect(retry?.fields).not.toHaveProperty("sessionName");
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("emits scope:project from the retry policy's continuation-contradiction event", async () => {
      const log = createCapturingLogger();
      conversationActors = createTestActorImplementations(
        createMockDeps({ log }),
      );

      // An adapter bug: "clear" must imply a null ref. The policy normalizes
      // and logs it — with the turn's identity.
      mockSendTurn.mockResolvedValue({
        ...defaultTurnResult,
        backendRef: { backend: "claude", ref: "stale-ref" },
        continuationDisposition: "clear",
      });

      const input = makeProjectExecutePromptInput();
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );
      await conversationActors.executePromptForMachine(input);

      const contradiction = log.entries.find(
        (e) => e.message === "prompt.continuation_pair_contradiction",
      );
      expect(contradiction).toBeDefined();
      expect(contradiction?.fields).toMatchObject({ scope: "project" });
      expect(contradiction?.fields).not.toHaveProperty("sessionName");
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    // The transcript module is the other downstream sink. The actor cannot
    // assert what that module logs (it is stubbed here), but it owns the
    // carrier: `TranscriptBroadcastMeta` names its session field
    // `storeSessionName` precisely so no consumer can spread it into a payload
    // or a log line as a public `sessionName`.
    it("hands the transcript writer a store-named carrier, never a public sessionName", async () => {
      const safeAppendTranscriptEntry = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({ safeAppendTranscriptEntry }),
      );

      const input = makeProjectExecutePromptInput();
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );
      await conversationActors.executePromptForMachine(input);

      const metas = safeAppendTranscriptEntry.mock.calls
        .map((call) => (call as unknown[])[2])
        .filter((meta): meta is TranscriptBroadcastMeta => meta !== undefined);
      expect(metas.length).toBeGreaterThan(0);
      for (const meta of metas) {
        expect(meta).not.toHaveProperty("sessionName");
        expect(meta.storeSessionName).toBe(
          PROJECT_CONVERSATION_SESSION_SENTINEL,
        );
      }
    });

    // The turn's resources are acquired BEFORE any of the events above, in
    // `prepareTurnForMachine` — a stage `executePromptForMachine` never runs.
    // Both of its sinks live in other modules: the conversation lock emits its
    // own `conversation-lock.*` events, and the query semaphore echoes the
    // label it is handed into `semaphore.*` events AND into its timeout Error
    // message. Stubbing either dependency hides the leak, so the lock here is
    // the PRODUCTION lock manager with an injected logger.
    describe("turn resource acquisition", () => {
      function makeProjectPrepareTurnInput(
        overrides: Partial<PrepareTurnInput> = {},
      ): PrepareTurnInput {
        return makePrepareTurnInput({
          target: targetFromStoreSessionName(
            overrides.target?.projectName ?? "repo",
            PROJECT_CONVERSATION_SESSION_SENTINEL,
            overrides.target?.conversationId ?? "conv-1",
          ),

          worktreePath: "/projects/repo",
          ...overrides,
        });
      }

      function registerFor(input: PrepareTurnInput): string {
        const key = conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        );
        registerConversationRuntime(key, {
          managed: createManagedRuntimeFixture(key),
          abortController: new AbortController(),
        });
        return key;
      }

      it("emits scope:project from the production conversation lock", async () => {
        const log = createCapturingLogger();
        const lockManager = createLockManager(log);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            acquireConversationLock: lockManager.acquireConversationLock,
          }),
        );

        const input = makeProjectPrepareTurnInput();
        const key = registerFor(input);
        await conversationActors.prepareTurnForMachine(input);
        getConversationRuntime(key)?.releaseConversationLock?.();

        const lockEvents = log.entries.filter((e) =>
          e.message.startsWith("conversation-lock."),
        );
        expect(lockEvents.map((e) => e.message)).toEqual([
          "conversation-lock.acquired",
          "conversation-lock.released",
        ]);
        for (const entry of lockEvents) {
          expect(entry.fields).toMatchObject({
            scope: "project",
            conversationId: input.target.conversationId,
          });
          expect(entry.fields).not.toHaveProperty("sessionName");
        }
        expect(log.allFieldValues()).not.toContain(
          PROJECT_CONVERSATION_SESSION_SENTINEL,
        );
      });

      it("emits scope:project when the lock rejects a concurrent project turn", async () => {
        const log = createCapturingLogger();
        const lockManager = createLockManager(log);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            acquireConversationLock: lockManager.acquireConversationLock,
          }),
        );

        const input = makeProjectPrepareTurnInput();
        registerFor(input);
        await conversationActors.prepareTurnForMachine(input);
        await expect(
          conversationActors.prepareTurnForMachine(input),
        ).rejects.toThrow(/busy/i);

        const rejected = log.entries.find(
          (e) => e.message === "conversation-lock.rejected",
        );
        expect(rejected?.fields).toMatchObject({ scope: "project" });
        expect(rejected?.fields).not.toHaveProperty("sessionName");
        expect(log.allFieldValues()).not.toContain(
          PROJECT_CONVERSATION_SESSION_SENTINEL,
        );
      });

      // The semaphore's only turn-derived value is the label — it is the sole
      // field the module logs and the sole interpolation in its timeout error.
      // Asserting the exact label the actor constructs therefore closes that
      // sink without needing to reach into another module's file logger.
      it("hands the query semaphore a scope-discriminated label", async () => {
        const labels: string[] = [];
        conversationActors = createTestActorImplementations(
          createMockDeps({
            acquireQuerySlot: vi.fn(async (label: string) => {
              labels.push(label);
              return vi.fn();
            }),
          }),
        );

        const input = makeProjectPrepareTurnInput();
        registerFor(input);
        await conversationActors.prepareTurnForMachine(input);

        expect(labels).toEqual([
          `prompt:project:${input.target.conversationId}`,
        ]);
        expect(labels[0]).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
      });

      // The stage's own failure message is a public surface too: it propagates
      // out of the turn and is published verbatim in an SSE `error` frame, and
      // it was built by interpolating the runtime key — which embeds the store
      // session name.
      it("names no sentinel when the runtime is missing", async () => {
        conversationActors = createTestActorImplementations(createMockDeps());
        const input = makeProjectPrepareTurnInput({
          target: targetFromStoreSessionName(
            "repo",
            PROJECT_CONVERSATION_SESSION_SENTINEL,
            "unregistered",
          ),
        });

        const err: unknown = await conversationActors
          .prepareTurnForMachine(input)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBeInstanceOf(Error);
        const message = err instanceof Error ? err.message : "";
        expect(message).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
        expect(message).toContain("unregistered");
      });

      it("still names the real session when a session turn takes its resources", async () => {
        const log = createCapturingLogger();
        const lockManager = createLockManager(log);
        const labels: string[] = [];
        conversationActors = createTestActorImplementations(
          createMockDeps({
            acquireConversationLock: lockManager.acquireConversationLock,
            acquireQuerySlot: vi.fn(async (label: string) => {
              labels.push(label);
              return vi.fn();
            }),
          }),
        );

        const input = makePrepareTurnInput();
        registerFor(input);
        await conversationActors.prepareTurnForMachine(input);

        expect(labels).toEqual([
          `prompt:${conversationTargetStoreSessionName(input.target)}`,
        ]);
        const acquired = log.entries.find(
          (e) => e.message === "conversation-lock.acquired",
        );
        expect(acquired?.fields).toMatchObject({
          scope: "session",
          sessionName: conversationTargetStoreSessionName(input.target),
          conversationId: input.target.conversationId,
        });
      });
    });
  });

  // Design 4 (invoked-actor half): the runtime's construction-time persistence
  // choice reaches the invoked actor and gates its durable state-store writes.
  // A new-runtime turn seeds MCP runtime state via `mutateConversation`
  // ("prompt.seedMcpRuntime"); the ephemeral variant must skip that write.
  it("gates the invoked actor's durable mutateConversation on the ephemeral persistence mode", async () => {
    const durableInput = makeExecutePromptInput({
      target: targetFromStoreSessionName(
        "repo",
        "test-session",
        "conv-durable",
      ),
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        durableInput.projectPath,
        conversationTargetStoreSessionName(durableInput.target),
        durableInput.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            durableInput.projectPath,
            conversationTargetStoreSessionName(durableInput.target),
            durableInput.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    await conversationActors.executePromptForMachine(durableInput);
    expect(mockDeps.mutateConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "conv-durable",
      "prompt.seedMcpRuntime",
      expect.anything(),
    );

    vi.mocked(mockDeps.mutateConversation).mockClear();

    const ephemeralInput = makeExecutePromptInput({
      target: targetFromStoreSessionName(
        "repo",
        "test-session",
        "conv-ephemeral",
      ),

      persistence: "ephemeral",
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        ephemeralInput.projectPath,
        conversationTargetStoreSessionName(ephemeralInput.target),
        ephemeralInput.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            ephemeralInput.projectPath,
            conversationTargetStoreSessionName(ephemeralInput.target),
            ephemeralInput.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    await conversationActors.executePromptForMachine(ephemeralInput);
    expect(mockDeps.mutateConversation).not.toHaveBeenCalled();
  });

  it("enforces turn-start MCP policy and idle capability drain without ephemeral bookkeeping writes", async () => {
    const reusedRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultTurnResult,
    );
    const reusedInput = makeExecutePromptInput({
      target: targetFromStoreSessionName(
        "repo",
        "test-session",
        "conv-ephemeral-reused",
      ),

      persistence: "ephemeral",
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        reusedInput.projectPath,
        conversationTargetStoreSessionName(reusedInput.target),
        reusedInput.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            reusedInput.projectPath,
            conversationTargetStoreSessionName(reusedInput.target),
            reusedInput.target.conversationId,
          ),
          reusedRuntime,
        ),
        abortController: new AbortController(),
      },
    );

    await conversationActors.executePromptForMachine(reusedInput);

    expect(mockDeps.applyMcpAtTurnStart).toHaveBeenCalledTimes(1);

    mockSendTurn.mockRejectedValue(new Error("SDK crashed"));
    const failedInput = makeExecutePromptInput({
      target: targetFromStoreSessionName(
        "repo",
        "test-session",
        "conv-ephemeral-failed",
      ),

      persistence: "ephemeral",
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        failedInput.projectPath,
        conversationTargetStoreSessionName(failedInput.target),
        failedInput.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            failedInput.projectPath,
            conversationTargetStoreSessionName(failedInput.target),
            failedInput.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );

    await conversationActors.executePromptForMachine(failedInput);

    expect(mockDeps.applyCapabilityWhenIdle).toHaveBeenCalled();
    expect(mockDeps.mutateConversation).not.toHaveBeenCalled();
  });

  it("reuses an existing alive backend runtime", async () => {
    const existingRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    (existingRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultTurnResult,
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, existingRuntime),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    // Should NOT create a new runtime
    expect(mockFactory.createRuntime).not.toHaveBeenCalled();
    expect(mockFactory.validateModelSelection).toHaveBeenCalledWith({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-session-1",
    });
  });

  it("refreshes baked TDD instructions between two turns", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });
    await conversationActors.executePromptForMachine(input);
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    vi.mocked(mockDeps.getSessionState).mockResolvedValue({
      tddEnabled: true,
    } as Awaited<ReturnType<typeof mockDeps.getSessionState>>);
    await conversationActors.executePromptForMachine(input);
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(2);
    expect(
      mockFactory.createRuntime.mock.calls[1]?.[0].sessionInstructions,
    ).toContain(TDD_INSTRUCTIONS);
  });

  it("recreates runtime when model changes", async () => {
    const existingRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "claude-sonnet-4-5-20250514",
        parameters: { effort: "high" },
      },
    });

    const input = makeExecutePromptInput({
      turn: {
        modelSelection: {
          modelId: "claude-opus-4-20250514",
          parameters: { effort: "high" },
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, existingRuntime),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(existingRuntime.close).toHaveBeenCalled();
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
  });

  it("continues an existing conversation on its last-used model selection when the turn carries none", async () => {
    // The turn arrives with no explicit selection — the shape produced by
    // document feedback, a drained queued message, or an alignment turn. Prior
    // transcript shows the conversation last ran on Haiku/low, so the turn must
    // continue there rather than snapping to the configured Opus selection.
    vi.mocked(mockDeps.readConversationMessages).mockResolvedValue([
      {
        role: "user",
        content: [{ type: "text", text: "earlier" }],
        timestamp: null,
        modelSelection: {
          modelId: "claude-haiku-4-5",
          parameters: { effort: "low" },
        },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        timestamp: null,
      },
    ]);

    const input = makeExecutePromptInput({ turn: { modelSelection: null } });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(mockFactory.validateModelSelection).toHaveBeenCalledWith({
      modelId: "claude-haiku-4-5",
      parameters: { effort: "low" },
    });
    // The persisted user turn records the resolved values so the next turn —
    // and the client composer — continues from the same complete selection.
    const userAppend = vi
      .mocked(mockDeps.safeAppendTranscriptEntry)
      .mock.calls.find(([, entry]) => entry.role === "user");
    expect(userAppend?.[1]).toMatchObject({
      modelSelection: {
        modelId: "claude-haiku-4-5",
        parameters: { effort: "low" },
      },
    });
  });

  it("canonicalizes a last-used project model selection before transcript persistence and runtime dispatch", async () => {
    const aliasSelection: BackendModelSelection = {
      modelId: "composer",
      parameters: { fast: "true" },
    };
    const canonicalSelection: BackendModelSelection = {
      modelId: "composer-2.5",
      parameters: { fast: "true" },
    };
    const validateModelSelection = vi.fn();
    const validateProjectModelSelection = vi.fn(async () => ({
      ok: true as const,
      modelSelection: canonicalSelection,
    }));
    const cursorRuntime = createMockBackendRuntime({
      backend: "cursor",
      modelSelection: canonicalSelection,
    });
    const createRuntime = vi.fn(async () => cursorRuntime);
    let acknowledgeSelection!: () => void;
    const onModelSelectionResolved = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeSelection = resolve;
        }),
    );
    const log = createCapturingLogger();
    mockDeps = createMockDeps({
      getConversationBackendFactory: vi.fn(() => ({
        backend: "cursor" as const,
        createRuntime,
        validateModelSelection,
        validateProjectModelSelection,
      })),
      readConversationMessages: vi.fn(async () => [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "earlier" }],
          timestamp: null,
          modelSelection: aliasSelection,
        },
      ]),
      log,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({
      turn: {
        modelSelection: null,
      },
      agentBackend: "cursor",
      onModelSelectionResolved,
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );

    const execution = conversationActors.executePromptForMachine(input);

    await vi.waitFor(() => {
      expect(onModelSelectionResolved).toHaveBeenCalledWith(canonicalSelection);
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(mockSendTurn).not.toHaveBeenCalled();

    acknowledgeSelection();
    await execution;

    expect(validateModelSelection).toHaveBeenCalledWith(aliasSelection);
    expect(validateProjectModelSelection).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      modelSelection: aliasSelection,
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: canonicalSelection }),
    );
    expect(mockSendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ modelSelection: canonicalSelection }),
    );
    const userAppend = vi
      .mocked(mockDeps.safeAppendTranscriptEntry)
      .mock.calls.find(([, entry]) => entry.role === "user");
    expect(userAppend?.[1]).toMatchObject({
      modelSelection: canonicalSelection,
    });
    expect(log.entries).toContainEqual({
      level: "debug",
      message: "model_selection.resolved",
      fields: {
        backend: "cursor",
        modelId: "composer-2.5",
        parameterIds: ["fast"],
        sourceLayer: "last_turn",
      },
    });
  });

  it("fails a project-model refusal before user transcript persistence or runtime dispatch", async () => {
    const validateModelSelection = vi.fn();
    const validateProjectModelSelection = vi.fn(async () => ({
      ok: false as const,
      code: "model_not_allowed",
      message: 'Cursor model "composer-2.5" is not allowed for this project.',
      modelId: "composer-2.5",
    }));
    const createRuntime = vi.fn(async () =>
      createMockBackendRuntime({ backend: "cursor" }),
    );
    const streamEmit = vi.fn();
    const onModelSelectionResolved = vi.fn(async () => {});
    const log = createCapturingLogger();
    mockDeps = createMockDeps({
      getConversationBackendFactory: vi.fn(() => ({
        backend: "cursor" as const,
        createRuntime,
        validateModelSelection,
        validateProjectModelSelection,
      })),
      log,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({
      turn: {
        modelSelection: null,
      },
      agentBackend: "cursor",
      onModelSelectionResolved,
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
        streamEmit,
      },
    );

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.error).toBe(
      'Cursor model "composer-2.5" is not allowed for this project.',
    );
    expect(validateProjectModelSelection).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "true" },
      },
    });
    expect(mockDeps.safeAppendTranscriptEntry).not.toHaveBeenCalled();
    expect(onModelSelectionResolved).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(mockSendTurn).not.toHaveBeenCalled();
    expect(streamEmit).toHaveBeenCalledWith("error", {
      message: 'Cursor model "composer-2.5" is not allowed for this project.',
    });
    expect(log.entries).toContainEqual({
      level: "warn",
      message: "model_selection.rejected",
      fields: {
        backend: "cursor",
        modelId: "composer-2.5",
        parameterIds: ["fast"],
        sourceLayer: "backend_default",
        code: "model_not_allowed",
      },
    });
  });

  it("marks a claimed queued turn failed when its model selection is refused", async () => {
    const error =
      'Cursor model "composer-2.5" is not allowed for this project.';
    mockDeps = createMockDeps({
      getConversationBackendFactory: vi.fn(() => ({
        backend: "cursor" as const,
        createRuntime: vi.fn(),
        validateModelSelection: vi.fn(),
        validateProjectModelSelection: vi.fn(async () => ({
          ok: false as const,
          code: "model_not_allowed",
          message: error,
          modelId: "composer-2.5",
        })),
      })),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({
      turn: {
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
        queuedDelivery: {
          messageIds: ["m1", "m2"],
          deliveryAttemptId: "att-model",
        },
      },
      agentBackend: "cursor",
    });
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.error).toBe(error);
    expect(mockDeps.markQueuedFailed).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      ids: ["m1", "m2"],
      deliveryAttemptId: "att-model",
      error,
    });
  });

  it("does not read the transcript when the turn carries an explicit complete selection", async () => {
    const input = makeExecutePromptInput({
      turn: {
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(mockDeps.readConversationMessages).not.toHaveBeenCalled();
    expect(mockFactory.validateModelSelection).toHaveBeenCalledWith({
      modelId: "opus",
      parameters: { effort: "high" },
    });
  });

  it("sends and records the explicit Codex speed without reading prior turns", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex",
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "true", reasoning: "high" },
      },
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);
    const input = makeExecutePromptInput({
      turn: {
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "true", reasoning: "high" },
        },
      },
      agentBackend: "codex",
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(mockDeps.readConversationMessages).not.toHaveBeenCalled();
    expect(mockSendTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "true", reasoning: "high" },
        },
      }),
    );
    const userAppend = vi
      .mocked(mockDeps.safeAppendTranscriptEntry)
      .mock.calls.find(([, entry]) => entry.role === "user");
    expect(userAppend?.[1]).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.4",
        parameters: { fast: "true", reasoning: "high" },
      },
    });
  });

  describe("pre-turn readiness gate", () => {
    it("recreates the runtime (resume-preserving) before streamInput when readiness asks for it, then delivers", async () => {
      const reusedPrepare = vi.fn().mockResolvedValue({
        status: "recreate-runtime",
        reason: "rebind_failed",
      });
      const reusedSendTurn = vi.fn();
      const reused = createMockBackendRuntime({
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        prepareForTurnStart: reusedPrepare,
        sendTurn: reusedSendTurn,
      });

      const freshSendTurn = vi.fn().mockResolvedValue(defaultTurnResult);
      const freshPrepare = vi.fn().mockResolvedValue({ status: "ready" });
      const fresh = createMockBackendRuntime({
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        prepareForTurnStart: freshPrepare,
        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(fresh);

      const input = makeExecutePromptInput({
        backendRef: { backend: "claude", ref: "sdk-session-resume" },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key, reused),
        abortController: new AbortController(),
      });

      const result = await conversationActors.executePromptForMachine(input);

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
          persistedRef: { backend: "claude", ref: "sdk-session-resume" },
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
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        prepareForTurnStart: reusedPrepare,
        sendTurn: reusedSendTurn,
      });

      const freshPrepare = vi.fn().mockResolvedValue({
        status: "recreate-runtime",
        reason: "still_broken",
      });
      const freshSendTurn = vi.fn();
      const fresh = createMockBackendRuntime({
        modelSelection: {
          modelId: "opus",
          parameters: { effort: "high" },
        },
        prepareForTurnStart: freshPrepare,
        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(fresh);

      const input = makeExecutePromptInput();
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key, reused),
        abortController: new AbortController(),
      });

      const result = await conversationActors.executePromptForMachine(input);

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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      sendToMachine,
    });

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        // Mid-turn backend_init, as the adapter emits on the SDK's system
        // init message
        await turnInput.onEvent?.({
          type: "backend_init",
          backendRef: { backend: "claude" as const, ref: "new-sdk-session" },
        });
        return {
          ...defaultTurnResult,
          backendRef: {
            backend: "claude" as const,
            ref: "new-sdk-session",
          },
        };
      },
    );

    await conversationActors.executePromptForMachine(input);

    expect(sendToMachine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "BACKEND_INIT",
        backendRef: { backend: "claude", ref: "new-sdk-session" },
      }),
    );
  });

  it("reuses the runtime when a turn requests structured output", async () => {
    const existingRuntime = createMockBackendRuntime();

    const schema = { type: "object", properties: { name: { type: "string" } } };
    const input = makeExecutePromptInput({
      turn: {
        structuredOutputTurns: "single",
        outputFormat: { type: "json_schema", schema },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, existingRuntime),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(existingRuntime.close).not.toHaveBeenCalled();
    expect(mockFactory.createRuntime).not.toHaveBeenCalled();
  });

  it("keeps debug outputFormat on the turn rather than runtime creation", async () => {
    mockSendTurn.mockResolvedValueOnce({
      ...defaultTurnResult,
      contentBlocks: [{ type: "text", text: "{}" }],
      structuredOutput: undefined,
    });

    const input = makeExecutePromptInput({
      turn: {
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
      debugMode: {
        active: true,
        debugSessionId: "debug-session-output-format",
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(mockFactory.createRuntime.mock.calls[0]?.[0]).not.toHaveProperty(
      "outputFormat",
    );
    expect(mockSendTurn).toHaveBeenCalledWith(
      expect.objectContaining({ outputFormat: input.turn.outputFormat }),
    );
    expect(result.error).toBeNull();
  });

  it("uses the config-derived Codex selection for actor-side validation", async () => {
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        agentBackends: {
          claude: {
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
            timeoutMs: 300_000,
          },
          codex: {
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { fast: "false", reasoning: "high" },
            },
            timeoutMs: null,
          },
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            timeoutMs: null,
          },
        },
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
      })),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(mockFactory.validateModelSelection).toHaveBeenCalledWith({
      modelId: "gpt-5.4",
      parameters: { fast: "false", reasoning: "high" },
    });
  });

  it("returns a failed result when actor-side validation rejects config-derived defaults", async () => {
    const streamEmit = vi.fn();
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        agentBackends: {
          claude: {
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
            timeoutMs: 300_000,
          },
          codex: {
            modelSelection: {
              modelId: "gpt-5.6-sol",
              parameters: { fast: "false", reasoning: "max" },
            },
            timeoutMs: null,
          },
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            timeoutMs: null,
          },
        },
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
      })),
    });
    conversationActors = createTestActorImplementations(mockDeps);
    mockFactory.validateModelSelection.mockImplementation(() => {
      throw new Error('Invalid Codex reasoning effort: "max"');
    });

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await conversationActors.executePromptForMachine(input);

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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.error).toBe("SDK crashed");
    expect(result.aborted).toBe(false);
  });

  it("drains Claude capability idle work when a caller turn fails", async () => {
    const applyCapabilityWhenIdle = vi.fn(async () => ({}));
    mockDeps = createMockDeps({ applyCapabilityWhenIdle });
    conversationActors = createTestActorImplementations(mockDeps);
    mockSendTurn.mockRejectedValue(new Error("SDK crashed"));

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.error).toBe("SDK crashed");
    expect(result.aborted).toBe(false);
    expect(applyCapabilityWhenIdle).toHaveBeenCalledTimes(1);
    expect(applyCapabilityWhenIdle).toHaveBeenCalledWith({
      projectPath: input.projectPath,
      projectName: input.target.projectName,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      worktreePath: input.worktreePath,
      backend: "claude",
    });
  });

  it("retries once with a fresh runtime when prompt delivery never reached backend", async () => {
    const staleSendTurn = vi.fn();
    const staleRuntime = createMockBackendRuntime({
      sendTurn: staleSendTurn,
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    staleSendTurn.mockImplementation(async () => {
      (staleRuntime as unknown as { status: string }).status = "dead";
      // Faithful to production: the Claude adapter tags an undelivered-prompt
      // rejection with the `promptNotDelivered` code, which both applies the
      // neutral delivery-safety mark and makes the descriptor classifier return
      // `retryable: true`. Retry requires BOTH facts, so the error must carry
      // the code — not only the mark — exactly as the runtime produces it.
      throw makeUndeliveredPromptFailure();
    });

    const freshSendTurn = vi.fn();
    const freshRuntime = createMockBackendRuntime({ sendTurn: freshSendTurn });
    freshSendTurn.mockResolvedValue({
      ...defaultTurnResult,
      backendRef: {
        backend: "claude" as const,
        ref: "sdk-session-retry",
      },
      contentBlocks: [{ type: "text" as const, text: "Recovered turn" }],
    });
    mockFactory.createRuntime.mockResolvedValue(freshRuntime);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, staleRuntime),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(staleSendTurn).toHaveBeenCalledTimes(1);
    expect(staleRuntime.close).toHaveBeenCalledTimes(1);
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    expect(freshSendTurn).toHaveBeenCalledTimes(1);
    expect(result.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-session-retry",
    });
    expect(result.error).toBeNull();
    expect(result.contentBlocks).toEqual([
      { type: "text", text: "Recovered turn" },
    ]);
  });

  it.each([true, false])(
    "preserves completed work when formatting needs runtime replacement (usable ref: %s)",
    async (hasUsableRef) => {
      const workRef = hasUsableRef
        ? { backend: "claude" as const, ref: "session-after-work" }
        : null;
      let status: "alive" | "dead" = "alive";
      let calls = 0;
      const workSendTurn = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return {
            ...defaultTurnResult,
            backendRef: workRef,
            contentBlocks: [
              { type: "text" as const, text: "The work is complete." },
            ],
          };
        }
        status = "dead";
        throw makeUndeliveredPromptFailure();
      });
      const workRuntime = createMockBackendRuntime({ sendTurn: workSendTurn });
      Object.defineProperty(workRuntime, "status", { get: () => status });
      const formattedSendTurn = vi.fn(async () => ({
        ...defaultTurnResult,
        backendRef: workRef,
        contentBlocks: [
          { type: "text" as const, text: '{"answer":"complete"}' },
        ],
      }));
      mockFactory.createRuntime.mockResolvedValue(
        createMockBackendRuntime({ sendTurn: formattedSendTurn }),
      );
      const input = makeExecutePromptInput({
        backendRef: { backend: "claude", ref: "session-before-work" },
        turn: {
          structuredOutputTurns: "work_then_format",
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
        },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key, workRuntime),
        abortController: new AbortController(),
      });

      const result = await conversationActors.executePromptForMachine(input);

      expect(workSendTurn).toHaveBeenCalledTimes(2);
      if (hasUsableRef) {
        expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
        expect(
          mockFactory.createRuntime.mock.calls[0]?.[0].persistedRef,
        ).toEqual(workRef);
        expect(formattedSendTurn).toHaveBeenCalledTimes(1);
        expect(result.error).toBeNull();
        expect(result.structuredOutput).toEqual({ answer: "complete" });
      } else {
        expect(mockFactory.createRuntime).not.toHaveBeenCalled();
        expect(formattedSendTurn).not.toHaveBeenCalled();
        expect(result.error).not.toBeNull();
      }
    },
  );

  it("marks result as aborted when abort signal fires", async () => {
    const abortController = new AbortController();
    mockSendTurn.mockImplementation(async () => {
      abortController.abort();
      throw new Error("aborted");
    });

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController,
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.aborted).toBe(true);
  });

  it("marks timeout-driven aborts with timeout metadata", async () => {
    vi.useFakeTimers();
    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        agentBackends: {
          claude: {
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
            timeoutMs: 25,
          },
          codex: {
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { fast: "false", reasoning: "high" },
            },
            timeoutMs: null,
          },
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            timeoutMs: null,
          },
        },
        maxTurns: 50,
        idleQuerySessionTtlMs: 300_000,
      })),
    });
    conversationActors = createTestActorImplementations(mockDeps);
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
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });

      const resultPromise = conversationActors.executePromptForMachine(input);

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

  it("preserves cancellation already signalled on the admitted runtime controller", async () => {
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: staleAbortController,
    });

    await expect(
      conversationActors.executePromptForMachine(input),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    const runtime = getConversationRuntime(key);
    expect(capturedSignal).toBeUndefined();
    expect(runtime?.abortController).toBe(staleAbortController);
    expect(runtime?.abortController.signal.aborted).toBe(true);
  });

  it("signals the attempt controller when the safety-net timeout fires", async () => {
    vi.mocked(mockDeps.readConfig).mockResolvedValue({
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          timeoutMs: 30,
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
          timeoutMs: null,
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          timeoutMs: null,
        },
      },
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
    });

    const events: string[] = [];
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => {
      events.push("abort");
    });

    const closingRuntime = createMockBackendRuntime({
      close: vi.fn(async () => {
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController,
    });

    await conversationActors.executePromptForMachine(input);

    expect(events).toEqual(["abort"]);
    expect(abortController.signal.reason).toBe("timeout");
  });

  it("merges portable MCP tooling overrides from runtime state into factory.createRuntime", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
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

    await conversationActors.executePromptForMachine(input);

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
      target: targetFromStoreSessionName("repo", "sess-a", "conv-xyz"),

      worktreePath: "/projects/repo/.worktrees/sess-a",
      agentBackend: "claude",
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      tooling: { portableMcp: transient },
    });

    await conversationActors.executePromptForMachine(input);

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
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
      backendRef: { backend: "codex" as const, ref: "thread-1" },
    });
    const applyMcpAtTurnStart = vi.fn(async () => ({
      conversationId: "conv-1",
      backend: "codex" as const,
      disposition: "applied_now" as const,
      effectiveConfigHash: "hash-codex",
    }));
    mockDeps = createMockDeps({ applyMcpAtTurnStart });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, reusedRuntime),
      abortController: new AbortController(),

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

    await conversationActors.executePromptForMachine(input);

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
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, reusedRuntime),
      abortController: new AbortController(),

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

    const result = await conversationActors.executePromptForMachine(input);

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
    const reusedRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      defaultTurnResult,
    );
    mockFactory.createRuntime.mockResolvedValue(reusedRuntime);
    mockDeps = createMockDeps({
      composePortableMcpForConversation: vi.fn(async () => composed),
      mutateConversation,
      applyMcpAtTurnStart,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const expectedHash = computeEffectiveConfigHash(composed);
    expect(conversationState.mcpRuntime?.lastAppliedConfigHash).toBe(
      expectedHash,
    );
    expect(conversationState.mcpRuntime?.lastApplyDisposition).toBe(
      "applied_now",
    );

    vi.clearAllMocks();
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, reusedRuntime),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(applyMcpAtTurnStart).toHaveBeenCalledTimes(1);
    expect(reusedRuntime.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("does not include tooling overrides when not set on runtime", async () => {
    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
    const seededCapabilities: ResolvedCapabilityCascade = {
      backend: "claude",
      kinds: [
        {
          kind: "skills",
          items: [
            { itemId: "skill-alpha", enabled: true, originLayer: "global" },
          ],
        },
      ],
    };
    const seededRuntimeState: AgentCapabilityRuntimeApplicationState = {
      cascades: {
        "claude-skills": {
          appliedHash: "hash-claude-skills",
          lastApplyStatus: "applied",
        },
      },
    };
    const composeCapabilityConfigForConversation: ActorFixtureDependencies["composeCapabilityConfigForConversation"] =
      vi.fn(async () => ({
        capabilities: seededCapabilities,
        runtimeState: seededRuntimeState,
      }));
    let capturedSeed: AgentCapabilityRuntimeApplicationState | undefined;
    const mutateConversation: ActorFixtureDependencies["mutateConversation"] =
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
      composeCapabilityConfigForConversation,
      mutateConversation,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(composeCapabilityConfigForConversation).toHaveBeenCalledTimes(1);
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      capabilities?: ResolvedCapabilityCascade;
    };
    expect(tooling.capabilities).toBe(seededCapabilities);
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
      backendRef: { backend: "codex" as const, ref: "thread-1" },
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const seededCapabilities: ResolvedCapabilityCascade = {
      backend: "codex",
      kinds: [
        {
          kind: "skills",
          items: [
            { itemId: "skill-alpha", enabled: false, originLayer: "global" },
          ],
        },
      ],
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
    const composeCapabilityConfigForConversation: ActorFixtureDependencies["composeCapabilityConfigForConversation"] =
      vi.fn(async () => ({
        capabilities: seededCapabilities,
        runtimeState: seededRuntimeState,
      }));
    const applyCapabilityAtTurnStart = vi.fn<
      ActorFixtureDependencies["applyCapabilityAtTurnStart"]
    >(async () => ({}));

    mockDeps = createMockDeps({
      composeCapabilityConfigForConversation,
      applyCapabilityAtTurnStart,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(composeCapabilityConfigForConversation).toHaveBeenCalledTimes(1);
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
    const mutateConversation: ActorFixtureDependencies["mutateConversation"] =
      vi.fn(async () => {});
    mockDeps = createMockDeps({
      composeCapabilityConfigForConversation: vi.fn(async () => undefined),
      mutateConversation,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const labels = (
      mutateConversation as ReturnType<typeof vi.fn>
    ).mock.calls.map((call) => call[3]);
    expect(labels).not.toContain("prompt.seedCapabilityRuntime");
  });

  it("seeds Claude project-conversation capability config from the project composer", async () => {
    const seededCapabilities: ResolvedCapabilityCascade = {
      backend: "claude",
      kinds: [
        {
          kind: "plugins",
          items: [
            { itemId: "plugin-alpha", enabled: true, originLayer: "global" },
          ],
        },
        {
          kind: "skills",
          items: [
            { itemId: "skill-alpha", enabled: true, originLayer: "global" },
          ],
        },
      ],
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
      capabilities: seededCapabilities,
      runtimeState: seededRuntimeState,
    }));
    let capturedSeed: AgentCapabilityRuntimeApplicationState | undefined;
    const mutateConversation: ActorFixtureDependencies["mutateConversation"] =
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
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeProjectExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(composeCapabilityConfigForProjectConversation).toHaveBeenCalledWith({
      backend: "claude",
      worktreePath: "/projects/repo",
      projectPath: "/projects/repo",
      projectName: "repo",
      conversationId: "conv-1",
    });
    expect(
      mockDeps.composeCapabilityConfigForConversation,
    ).not.toHaveBeenCalled();
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      capabilities?: ResolvedCapabilityCascade;
    };
    expect(tooling.capabilities).toBe(seededCapabilities);
    expect(capturedSeed).toBe(seededRuntimeState);
  });

  it("seeds Codex project-conversation capability config and applies turn start with project identity", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...defaultTurnResult,
      backendRef: { backend: "codex" as const, ref: "thread-1" },
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const seededCapabilities: ResolvedCapabilityCascade = {
      backend: "codex",
      kinds: [
        {
          kind: "skills",
          items: [
            { itemId: "skill-alpha", enabled: false, originLayer: "global" },
          ],
        },
      ],
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
      capabilities: seededCapabilities,
      runtimeState: seededRuntimeState,
    }));
    const applyCapabilityAtTurnStart = vi.fn<
      ActorFixtureDependencies["applyCapabilityAtTurnStart"]
    >(async () => ({}));

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
      applyCapabilityAtTurnStart,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeProjectExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    const tooling = createCall["tooling"] as {
      capabilities?: ResolvedCapabilityCascade;
    };
    expect(tooling.capabilities).toBe(seededCapabilities);
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
      capabilities: {
        backend: "codex",
        kinds: [],
      } as ResolvedCapabilityCascade,
      runtimeState: { cascades: {} },
    }));

    mockDeps = createMockDeps({
      composeCapabilityConfigForProjectConversation,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeProjectExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(mockDeps.getConversationBackendFactory).toHaveBeenCalledWith(
      "claude",
    );
    const createCall = (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
    expect(createCall["persistedRef"]).toBeNull();
    expect(createCall["tooling"]).not.toHaveProperty("capabilities");
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
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeProjectExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await conversationActors.executePromptForMachine(input);

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
      turn: {
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: { type: "object" },
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

    expect(result.structuredOutput).toEqual(structuredData);
  });

  it("prepends debug instructions on first debug turn", async () => {
    const input = makeExecutePromptInput({
      turn: {
        promptText: "Help me debug this",
      },
      debugMode: {
        active: true,
        debugSessionId: "debug-session-first-turn",
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const sendTurnCall = mockSendTurn.mock.calls[0]! as unknown[];
    const turnInput = sendTurnCall[0] as ConversationBackendTurnInput;
    expect(turnInput.promptText).toContain("<debug-mode>");
    expect(turnInput.promptText).toContain("Help me debug this");
  });

  it("substitutes an absolute manifest path under the worktree into debug prompts", async () => {
    const worktreePath = "/projects/repo/.worktrees/test-session";
    const conversationId = "conv-abs-manifest";
    const input = makeExecutePromptInput({
      turn: {
        promptText: "Help me debug this",
      },
      worktreePath,
      target: targetFromStoreSessionName(
        "repo",
        "test-session",
        conversationId,
      ),
      debugMode: {
        active: true,
        debugSessionId: "debug-session-absolute-manifest",
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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const sendTurnCall = mockSendTurn.mock.calls[0]! as unknown[];
    const turnInput = sendTurnCall[0] as ConversationBackendTurnInput;
    const expectedAbsManifest = `${worktreePath}/.debug/${conversationId}/instrumentation.json`;
    expect(turnInput.promptText).toContain(expectedAbsManifest);
    expect(turnInput.promptText).not.toMatch(
      /(?<![A-Za-z0-9/_.-])\.debug\/conv-abs-manifest\/instrumentation\.json/,
    );
  });

  describe("live ticket context injection", () => {
    const TICKET_BLOCK = [
      "<active-ticket>",
      "identifier: repo#1",
      "title: Injected ticket",
      "status: In Progress",
      "attachments: none",
      "refresh: cctl ticket get repo#1",
      "</active-ticket>",
    ].join("\n");

    function registerRuntime(input: ExecutePromptInput): void {
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });
    }

    function lastTurnInput(): ConversationBackendTurnInput {
      const call = mockSendTurn.mock.calls.at(-1)! as unknown[];
      return call[0] as ConversationBackendTurnInput;
    }

    it("prepends the live ticket block to the turn's effective prompt, never to sessionInstructions", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getLiveTicketBlock: vi.fn(async () => TICKET_BLOCK),
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      const turnInput = lastTurnInput();
      expect(turnInput.promptText.startsWith(TICKET_BLOCK)).toBe(true);
      expect(turnInput.promptText).toContain("do the work");
      expect(turnInput).not.toHaveProperty("promptContext");

      expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
      const createRuntimeCall = (
        mockFactory.createRuntime as ReturnType<typeof vi.fn>
      ).mock.calls[0]! as unknown[];
      const runtimeArgs = createRuntimeCall[0] as {
        sessionInstructions: string[];
      };
      expect(runtimeArgs.sessionInstructions.join("\n")).not.toContain(
        "<active-ticket>",
      );
    });

    it.each([
      "plain request",
      "[$selected](</skills/selected/SKILL.md>) explain",
    ])(
      "keeps user skill selection provenance separate from host context: %s",
      async (userText) => {
        const hostText = `${TICKET_BLOCK}\n[$host-only](</skills/host-only/SKILL.md>)`;
        conversationActors = createTestActorImplementations(
          createMockDeps({ getLiveTicketBlock: vi.fn(async () => hostText) }),
        );
        const input = makeExecutePromptInput({
          turn: { promptText: userText },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(lastTurnInput()).toMatchObject({
          promptText: `${hostText}\n\n${userText}`,
          userPromptText: userText,
        });
      },
    );

    it("keeps an explicit skill invocation separate from transient context", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getLiveTicketBlock: vi.fn(async () => TICKET_BLOCK),
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "/wait-what explain the last answer" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(lastTurnInput()).toMatchObject({
        promptText: "/wait-what explain the last answer",
        promptContext: TICKET_BLOCK,
      });
    });

    it("leaves the prompt untouched for unlinked sessions", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getLiveTicketBlock: vi.fn(async () => null),
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "plain turn" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(lastTurnInput().promptText).toBe("plain turn");
    });

    it("does not look up tickets for project conversations", async () => {
      const getLiveTicketBlock = vi.fn(async () => TICKET_BLOCK);
      conversationActors = createTestActorImplementations(
        createMockDeps({ getLiveTicketBlock }),
      );
      const input = makeProjectExecutePromptInput({
        turn: {
          promptText: "project turn",
        },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(getLiveTicketBlock).not.toHaveBeenCalled();
      expect(lastTurnInput().promptText).toBe("project turn");
    });

    it("proceeds without the block when the ticket lookup fails", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getLiveTicketBlock: vi.fn(async () => {
            throw new Error("db unavailable");
          }),
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "resilient turn" },
      });
      registerRuntime(input);

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      expect(lastTurnInput().promptText).toBe("resilient turn");
    });

    it("shows a mid-session attachment addition in the next turn's effective prompt without runtime recreation", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
          "/projects/repo",
        );
        db.prepare(
          `INSERT INTO sessions
             (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at, finished)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          "/projects/repo",
          "test-session",
          "/projects/repo/.worktrees/test-session",
          "csm/test-session",
          "2026-07-04T00:00:00.000Z",
          "2026-07-04T00:00:00.000Z",
        );
        const repo = createTicketsRepo(db, createWriteQueue());
        const ticket = await repo.create({
          id: "t-1",
          projectPath: "/projects/repo",
          title: "Mid-session ticket",
          description: "",
          workType: "feature",
          status: "not_started",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        });
        await repo.linkStartedSession({
          id: "l-1",
          projectPath: "/projects/repo",
          number: ticket.number,
          sessionName: "test-session",
          sessionCreatedAt: "2026-07-04T00:00:00.000Z",
          startMode: "agent",
          linkedAt: "2026-07-05T00:00:00.000Z",
        });
        const provider = createLiveTicketContextProvider({
          findLinkedTicket(projectPath, sessionName) {
            return repo.findLinkedTicket(projectPath, sessionName);
          },
        });
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getLiveTicketBlock: (projectPath, sessionName) =>
              provider.getForSession(projectPath, sessionName),
          }),
        );

        // A persistent runtime is already alive — its instructions are frozen.
        const existingRuntime = createMockBackendRuntime({
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
        });
        (
          existingRuntime.sendTurn as ReturnType<typeof vi.fn>
        ).mockResolvedValue(defaultTurnResult);
        const input = makeExecutePromptInput({
          turn: { promptText: "first turn" },
        });
        const key = conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        );
        registerConversationRuntime(key, {
          managed: createManagedRuntimeFixture(key, existingRuntime),
          abortController: new AbortController(),
        });

        await conversationActors.executePromptForMachine(input);
        const firstPrompt = lastTurnInput().promptText;
        expect(firstPrompt).toContain("<active-ticket>");
        expect(firstPrompt).toContain("attachments: none");

        await repo.addAttachment({
          id: "att-mid",
          ticketId: ticket.id,
          description: "added mid-session",
          payload: { kind: "note", markdown: "body stays out of prompts" },
          createdAt: "2026-07-05T01:00:00.000Z",
          updatedAt: "2026-07-05T01:00:00.000Z",
        });

        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({ turn: { promptText: "second turn" } }),
        );
        const secondPrompt = lastTurnInput().promptText;
        expect(secondPrompt).toContain("att-mid");
        expect(secondPrompt).toContain("added mid-session");
        expect(secondPrompt).not.toContain("body stays out of prompts");
        expect(mockFactory.createRuntime).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    });
  });

  // D5: the agent-facing rewrite seam expands notepad references to full
  // canonical content; the durable transcript keeps the un-expanded reference
  // so the chip still renders in history.
  describe("notepad reference injection", () => {
    const NOTEPAD_REF =
      '<notepad-ref notepad-id="np-1" name="Design Notes" scope="global" read-command="cctl notepad get \'np-1\'" />';

    function registerRuntime(input: ExecutePromptInput): void {
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });
    }

    function deliveredPromptText(): string {
      const call = mockSendTurn.mock.calls.at(-1)! as unknown[];
      return (call[0] as ConversationBackendTurnInput).promptText;
    }

    function userTranscriptText(deps: ActorFixtureDependencies): string {
      const call = vi
        .mocked(deps.safeAppendTranscriptEntry)
        .mock.calls.find(
          ([, entry]) => (entry as { role?: string }).role === "user",
        )!;
      const content = (call[1] as { content: Array<{ text?: string }> })
        .content;
      return content.map((block) => block.text ?? "").join("");
    }

    it("adds one current entity summary from direct and injected references while preserving the transcript", async () => {
      const ref =
        '<ticket-ref project-name="cc" ticket-number="90" identifier="cc#90" title="Captured" read-command="cctl ticket get cc#90" />';
      const fixture = createMockDeps({
        readLiveReference: async () => ({
          title: "Current",
          identity: "cc#90",
          status: "Done",
          tone: "green",
          href: "/tickets/cc/90",
          readCommand: "read",
          details: [],
          attentionCount: 0,
        }),
        readNotepadForInjection: async () => ({
          id: "np-1",
          name: "Design Notes",
          revision: 4,
          openComments: { count: 0, latestCreatedAt: null },
          writeMode: "full-edit",
          content: ref,
        }),
      });
      conversationActors = createTestActorImplementations(fixture);
      const raw = `${ref} ${NOTEPAD_REF}`;
      const input = makeExecutePromptInput({ turn: { promptText: raw } });
      registerRuntime(input);
      await conversationActors.executePromptForMachine(input);
      expect(deliveredPromptText()).toContain('status="Done"');
      expect(deliveredPromptText().match(/<entity-state /g)).toHaveLength(1);
      expect(userTranscriptText(fixture)).toBe(raw);
    });

    it("delivers full notepad content to the agent while the transcript keeps the un-expanded reference", async () => {
      const nested =
        '<notepad-ref notepad-id="np-2" name="Nested" scope="global" read-command="cctl notepad get \'np-2\'" />';
      const notepadDeps = createMockDeps({
        readNotepadForInjection: vi.fn(async (notepadId: string) =>
          notepadId === "np-1"
            ? {
                id: "np-1",
                name: "Design Notes",
                revision: 4,
                openComments: { count: 0, latestCreatedAt: null },
                writeMode: "full-edit" as const,
                content: `Body line.\n\n[Image: img-a]\n\nSee ${nested}`,
              }
            : null,
        ),
      });
      conversationActors = createTestActorImplementations(notepadDeps);
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Please review ${NOTEPAD_REF} today.`,
        },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      const delivered = deliveredPromptText();
      expect(delivered).toContain("id: np-1");
      expect(delivered).toContain("name: Design Notes");
      expect(delivered).toContain("revision: 4");
      expect(delivered).toContain("read: cctl notepad get 'np-1'");
      expect(delivered).toContain("Body line.");
      // Nested reference arrives as a reference, with its read command intact.
      expect(delivered).toContain(nested);
      expect(delivered).toContain("[Image: img-a]");

      // The durable transcript keeps what the user composed.
      expect(userTranscriptText(notepadDeps)).toBe(
        `Please review ${NOTEPAD_REF} today.`,
      );
    });

    it("injects a not-found block naming the id when the notepad was deleted", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          readNotepadForInjection: vi.fn(async () => null),
        }),
      );
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Look: ${NOTEPAD_REF}`,
        },
      });
      registerRuntime(input);

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      const delivered = deliveredPromptText();
      expect(delivered).toContain("id: np-1");
      expect(delivered).toContain("not found");
    });

    it("does not read notepads for a prompt with no notepad reference", async () => {
      const readNotepadForInjection = vi.fn(async () => null);
      conversationActors = createTestActorImplementations(
        createMockDeps({ readNotepadForInjection }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "plain turn" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(readNotepadForInjection).not.toHaveBeenCalled();
      expect(deliveredPromptText()).toBe("plain turn");
    });

    it("delivers the un-expanded text when the notepad read fails", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          readNotepadForInjection: vi.fn(async () => {
            throw new Error("state store unavailable");
          }),
        }),
      );
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Resilient ${NOTEPAD_REF}`,
        },
      });
      registerRuntime(input);

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      expect(deliveredPromptText()).toBe(`Resilient ${NOTEPAD_REF}`);
    });

    it("does not record a rendered reference when the backend never accepts input", async () => {
      const recordNotepadDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          readNotepadForInjection: vi.fn(async () => ({
            id: "np-1",
            name: "Design Notes",
            revision: 4,
            openComments: { count: 0, latestCreatedAt: null },
            writeMode: "full-edit" as const,
            content: "Prepared body",
          })),
          recordNotepadDeliveries,
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: NOTEPAD_REF },
      });
      registerRuntime(input);
      mockSendTurn.mockRejectedValueOnce(
        new Error("rejected before acceptance"),
      );
      await conversationActors.executePromptForMachine(input);
      expect(recordNotepadDeliveries).not.toHaveBeenCalled();
    });

    it("records the prepared reference after backend acceptance", async () => {
      const recordNotepadDeliveries = vi.fn(async () => {});
      const notepadDeps = createMockDeps({
        readNotepadForInjection: vi.fn(async () => ({
          id: "np-1",
          name: "Design Notes",
          revision: 4,
          openComments: { count: 0, latestCreatedAt: null },
          writeMode: "full-edit" as const,
          content: "Body line.",
        })),
        recordNotepadDeliveries,
      });
      conversationActors = createTestActorImplementations(notepadDeps);
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Please review ${NOTEPAD_REF} today.`,
        },
      });
      registerRuntime(input);
      mockSendTurn.mockImplementationOnce(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      await conversationActors.executePromptForMachine(input);

      expect(recordNotepadDeliveries).toHaveBeenCalledWith({
        conversationId: input.target.conversationId,
        notepads: [
          {
            notepadId: "np-1",
            revision: 4,
            openComments: { count: 0, latestCreatedAt: null },
          },
        ],
      });
    });

    it("records nothing for a turn carrying no notepad reference", async () => {
      const recordNotepadDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({ recordNotepadDeliveries }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "plain turn" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordNotepadDeliveries).not.toHaveBeenCalled();
    });

    it("records nothing for a dangling reference — a deleted notepad was never delivered", async () => {
      const recordNotepadDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          readNotepadForInjection: vi.fn(async () => null),
          recordNotepadDeliveries,
        }),
      );
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Look: ${NOTEPAD_REF}`,
        },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordNotepadDeliveries).not.toHaveBeenCalled();
    });

    it("still delivers the turn when recording the watermark fails", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          readNotepadForInjection: vi.fn(async () => ({
            id: "np-1",
            name: "Design Notes",
            revision: 4,
            openComments: { count: 0, latestCreatedAt: null },
            writeMode: "full-edit" as const,
            content: "Body line.",
          })),
          recordNotepadDeliveries: vi.fn(async () => {
            throw new Error("state store unavailable");
          }),
        }),
      );
      const input = makeExecutePromptInput({
        turn: {
          promptText: `Please review ${NOTEPAD_REF}`,
        },
      });
      registerRuntime(input);
      mockSendTurn.mockImplementationOnce(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      expect(deliveredPromptText()).toContain("Body line.");
    });

    describe("notepad change notices", () => {
      const NOTICE_BLOCK = [
        "<notepad-changes>",
        "<notepad-change>",
        "id: np-1",
        "revision: 5",
        "</notepad-change>",
        "</notepad-changes>",
      ].join("\n");

      function preparedNotice() {
        return {
          conversationId: "conv-1",
          block: NOTICE_BLOCK,
          advances: [
            {
              conversationId: "conv-1",
              notepadId: "np-1",
              revision: 5,
              openComments: { count: 0, latestCreatedAt: null },
              updatedAt: "2026-08-28T12:00:00.000Z",
            },
          ],
        };
      }

      it("prepends the notice to the agent's prompt while the transcript keeps the user's text", async () => {
        const append = vi.fn<
          ActorFixtureDependencies["safeAppendTranscriptEntry"]
        >(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            safeAppendTranscriptEntry: append,
            prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        const delivered = deliveredPromptText();
        expect(delivered).toContain(NOTICE_BLOCK);
        expect(delivered.indexOf(NOTICE_BLOCK)).toBeLessThan(
          delivered.indexOf("carry on"),
        );
        const storedUser = append.mock.calls
          .map(([, entry]) => entry)
          .find((entry) => entry.role === "user");
        expect(storedUser?.content).toEqual([
          { type: "text", text: "carry on" },
        ]);
      });

      it("prepends nothing when no tracked notepad changed", async () => {
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(
              async (conversationId: string) => ({
                conversationId,
                block: null,
                advances: [],
              }),
            ),
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(deliveredPromptText()).toBe("carry on");
      });

      it("advances the watermarks only once the backend accepts the message", async () => {
        const settleNotepadChangeNotice = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
            settleNotepadChangeNotice,
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        mockSendTurn.mockImplementation(
          async (turnInput: ConversationBackendTurnInput) => {
            expect(settleNotepadChangeNotice).not.toHaveBeenCalled();
            await turnInput.onEvent({ type: "input_accepted" });
            return defaultTurnResult;
          },
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(settleNotepadChangeNotice).toHaveBeenCalledWith(
          preparedNotice(),
        );
      });

      it("leaves the watermarks untouched when the turn fails before acceptance", async () => {
        const settleNotepadChangeNotice = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
            settleNotepadChangeNotice,
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        mockSendTurn.mockRejectedValue(new Error("pre-ack crash"));
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(settleNotepadChangeNotice).not.toHaveBeenCalled();
      });

      it("keeps the watermarks advanced when the turn fails after acceptance", async () => {
        const settleNotepadChangeNotice = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
            settleNotepadChangeNotice,
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        mockSendTurn.mockImplementation(
          async (turnInput: ConversationBackendTurnInput) => {
            await turnInput.onEvent({ type: "input_accepted" });
            throw new Error("post-ack crash");
          },
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(settleNotepadChangeNotice).toHaveBeenCalledTimes(1);
      });

      it("settles the notice even when an unrelated post-acceptance write fails", async () => {
        // The backend has already taken the message, so the notice was
        // delivered. A neighbouring settle failing must not strand the
        // watermark and make the agent read the same notice twice.
        const settleNotepadChangeNotice = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(async () => preparedNotice()),
            settleNotepadChangeNotice,
            claimWorkflowResults: vi.fn(async () => [
              {
                executionId: "exec-alpha",
                boundarySeq: 11,
                projectPath: "/projects/repo",
                sessionName: "test-session",
                originConversationId: "conv-1",
                payload: { status: "halted", output: "first" },
                recordedAt: "2026-08-14T12:00:01.000Z",
                state: "delivering",
                attemptId: "stream-1",
                attemptCount: 1,
                deliveredAt: null,
                effectsDeliveredAt: null,
              },
            ]),
            settleWorkflowResults: vi.fn(async () => {
              throw new Error("workflow settle unavailable");
            }),
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        mockSendTurn.mockImplementation(
          async (turnInput: ConversationBackendTurnInput) => {
            await turnInput.onEvent({ type: "input_accepted" });
            return defaultTurnResult;
          },
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        await expect(
          conversationActors.executePromptForMachine(input),
        ).rejects.toThrow("Turn context receipts failed");

        expect(settleNotepadChangeNotice).toHaveBeenCalledWith(
          preparedNotice(),
        );
      });

      it("delivers the turn without a notice when preparing one fails", async () => {
        const settleNotepadChangeNotice = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            prepareNotepadChangeNotice: vi.fn(async () => {
              throw new Error("state store unavailable");
            }),
            settleNotepadChangeNotice,
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        const input = makeExecutePromptInput({
          turn: { promptText: "carry on" },
        });
        registerRuntime(input);

        const result = await conversationActors.executePromptForMachine(input);

        expect(result.error).toBeNull();
        expect(deliveredPromptText()).toBe("carry on");
        expect(settleNotepadChangeNotice).not.toHaveBeenCalled();
      });

      it("prepares from local references and records them after acceptance", async () => {
        const order: string[] = [];
        conversationActors = createTestActorImplementations(
          createMockDeps({
            readNotepadForInjection: vi.fn(async () => ({
              id: "np-1",
              name: "Design Notes",
              revision: 4,
              openComments: { count: 0, latestCreatedAt: null },
              writeMode: "full-edit" as const,
              content: "Body line.",
            })),
            recordNotepadDeliveries: vi.fn(async () => {
              order.push("record");
            }),
            prepareNotepadChangeNotice: vi.fn(
              async (conversationId: string) => {
                order.push("prepare");
                return { conversationId, block: null, advances: [] };
              },
            ),
          } as unknown as Partial<ActorFixtureDependencies>),
        );
        const input = makeExecutePromptInput({
          turn: {
            promptText: `Please review ${NOTEPAD_REF}`,
          },
        });
        registerRuntime(input);
        mockSendTurn.mockImplementationOnce(
          async (turnInput: ConversationBackendTurnInput) => {
            await turnInput.onEvent({ type: "input_accepted" });
            return defaultTurnResult;
          },
        );

        await conversationActors.executePromptForMachine(input);

        // Content delivered in full this turn needs no notice to re-read it.
        expect(order).toEqual(["prepare", "record"]);
      });
    });
  });

  describe("workflow result injection", () => {
    function claimedResults(): GraphWorkflowResultDelivery[] {
      return [
        {
          executionId: "exec-alpha",
          boundarySeq: 11,
          projectPath: "/projects/repo",
          sessionName: "test-session",
          originConversationId: "conv-1",
          payload: { status: "halted", output: "first" },
          recordedAt: "2026-08-14T12:00:01.000Z",
          state: "delivering",
          attemptId: "stream-1",
          attemptCount: 1,
          deliveredAt: null,
          effectsDeliveredAt: null,
        },
        {
          executionId: "exec-zeta",
          boundarySeq: 42,
          projectPath: "/projects/repo",
          sessionName: "test-session",
          originConversationId: "conv-1",
          payload: { status: "completed", output: "second" },
          recordedAt: "2026-08-14T12:00:02.000Z",
          state: "delivering",
          attemptId: "stream-1",
          attemptCount: 1,
          deliveredAt: null,
          effectsDeliveredAt: null,
        },
      ];
    }

    function registerRuntime(input: ExecutePromptInput): void {
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });
    }

    function assertOrderedResultsBeforeUser(prompt: string, userText: string) {
      expect(prompt.match(/<workflow-results>/g)).toHaveLength(1);
      expect(prompt.match(/<\/workflow-results>/g)).toHaveLength(1);
      expect(prompt.indexOf('"key":"exec-alpha:11"')).toBeLessThan(
        prompt.indexOf('"key":"exec-zeta:42"'),
      );
      expect(prompt.indexOf('"key":"exec-zeta:42"')).toBeLessThan(
        prompt.indexOf(userText),
      );
    }

    it("claims and prepends pending boundaries for a direct turn without changing stored user text", async () => {
      const append = vi.fn<
        ActorFixtureDependencies["safeAppendTranscriptEntry"]
      >(async () => {});
      const claimWorkflowResults = vi.fn(async () => claimedResults());
      conversationActors = createTestActorImplementations(
        createMockDeps({
          safeAppendTranscriptEntry: append,
          claimWorkflowResults,
        } as unknown as Partial<ActorFixtureDependencies>),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "direct user text" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(claimWorkflowResults).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        originConversationId: input.target.conversationId,
        attemptId: "stream-1",
      });
      const turnInput = mockSendTurn.mock.calls.at(-1)![0] as
        | ConversationBackendTurnInput
        | undefined;
      expect(turnInput).toBeDefined();
      assertOrderedResultsBeforeUser(turnInput!.promptText, "direct user text");
      const storedUser = append.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.role === "user");
      expect(storedUser?.content).toEqual([
        { type: "text", text: "direct user text" },
      ]);
    });

    it("claims and prepends pending boundaries for a queued turn without changing stored user text", async () => {
      const append = vi.fn<
        ActorFixtureDependencies["appendTranscriptEntryOnce"]
      >(async () => {});
      const claimWorkflowResults = vi.fn(async () => claimedResults());
      conversationActors = createTestActorImplementations(
        createMockDeps({
          appendTranscriptEntryOnce: append,
          claimWorkflowResults,
        } as unknown as Partial<ActorFixtureDependencies>),
      );
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );
      const input = makeExecutePromptInput({
        turn: {
          promptText: "queued user text",
          queuedDelivery: {
            messageIds: ["message-1"],
            deliveryAttemptId: "queue-attempt-1",
          },
        },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(claimWorkflowResults).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        originConversationId: input.target.conversationId,
        attemptId: "queue-attempt-1",
      });
      const turnInput = mockSendTurn.mock.calls.at(-1)![0] as
        | ConversationBackendTurnInput
        | undefined;
      expect(turnInput).toBeDefined();
      assertOrderedResultsBeforeUser(turnInput!.promptText, "queued user text");
      const storedUser = append.mock.calls
        .map(([, entry]) => entry)
        .find((entry) => entry.role === "user");
      expect(storedUser?.content).toEqual([
        { type: "text", text: "queued user text" },
      ]);
    });

    it("returns claimed boundaries to pending when dispatch fails before input acceptance", async () => {
      const releaseWorkflowResults = vi.fn(async () => 2);
      const settleWorkflowResults = vi.fn(async () => 0);
      conversationActors = createTestActorImplementations(
        createMockDeps({
          claimWorkflowResults: vi.fn(async () => claimedResults()),
          releaseWorkflowResults,
          settleWorkflowResults,
        } as unknown as Partial<ActorFixtureDependencies>),
      );
      mockSendTurn.mockRejectedValue(new Error("pre-ack crash"));
      const input = makeExecutePromptInput({
        turn: { promptText: "retry safely" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(settleWorkflowResults).not.toHaveBeenCalled();
      expect(releaseWorkflowResults).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        originConversationId: input.target.conversationId,
        attemptId: "stream-1",
      });
    });

    it("settles claimed boundaries at input acceptance and does not release them when the turn later fails", async () => {
      const releaseWorkflowResults = vi.fn(async () => 0);
      const settleWorkflowResults = vi.fn(async () => 2);
      conversationActors = createTestActorImplementations(
        createMockDeps({
          claimWorkflowResults: vi.fn(async () => claimedResults()),
          releaseWorkflowResults,
          settleWorkflowResults,
        } as unknown as Partial<ActorFixtureDependencies>),
      );
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          throw new Error("post-ack crash");
        },
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "accepted once" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(settleWorkflowResults).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        originConversationId: input.target.conversationId,
        attemptId: "stream-1",
      });
      expect(releaseWorkflowResults).not.toHaveBeenCalled();
    });
  });

  it("persists non-Claude content events incrementally before the result entry", async () => {
    const codexRuntime = createMockBackendRuntime({
      backend: "codex" as const,
    });
    (codexRuntime.sendTurn as ReturnType<typeof vi.fn>).mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({
          type: "backend_init",
          backendRef: { backend: "codex" as const, ref: "thread-1" },
        });
        await turnInput.onEvent({
          type: "content",
          block: { type: "text", text: "Codex says hello" },
        });
        await turnInput.onEvent({
          type: "content",
          block: { type: "thinking", text: "Checking the implementation" },
        });
        return {
          ...defaultTurnResult,
          backendRef: { backend: "codex" as const, ref: "thread-1" },
          contentBlocks: [
            { type: "text" as const, text: "Codex says hello" },
            { type: "thinking" as const, text: "Checking the implementation" },
          ],
        };
      },
    );
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const systemEntry = calls.find(
      ([, entry]) => (entry as { type?: string }).type === "system",
    );
    const assistantEntries = calls.filter(
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
    expect(assistantEntries.map(([, entry]) => entry.content)).toEqual([
      [{ type: "text", text: "Codex says hello" }],
      [{ type: "thinking", text: "Checking the implementation" }],
    ]);
    expect(resultEntry).toBeDefined();
    expect(resultEntry![1]).toEqual(
      expect.objectContaining({
        type: "result",
        raw: expect.objectContaining({
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-1" },
          aborted: false,
          error: null,
        }),
      }),
    );
    expect(calls.indexOf(assistantEntries[0]!)).toBeLessThan(
      calls.indexOf(resultEntry!),
    );
  });

  it("persists transcript_entry frames verbatim without reading into the payload", async () => {
    const noticeFrame = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "streamed" }],
      uuid: "u-frame-1",
    };
    // A payload shape no real backend produces: proves byte-faithful
    // passthrough of non-frame envelopes too.
    const alienPayload = { type: "testfake_frame", marker: "m-42" };

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({
          type: "transcript_entry",
          entry: {
            seq: 0,
            backend: "claude",
            type: "assistant",
            raw: noticeFrame,
          },
        });
        await turnInput.onEvent({
          type: "transcript_entry",
          entry: {
            seq: 1,
            backend: "claude",
            type: "testfake_frame",
            raw: alienPayload,
          },
        });
        return { ...defaultTurnResult };
      },
    );

    const input = makeExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const calls = vi.mocked(mockDeps.safeAppendTranscriptEntry).mock.calls;
    const frameAppend = calls.find(
      ([, entry]) => (entry as { uuid?: string }).uuid === "u-frame-1",
    );
    expect(frameAppend).toBeDefined();
    // Frame-shaped payloads are appended as the SAME object (byte-exact).
    expect(frameAppend![1]).toBe(noticeFrame);

    const alienAppend = calls.find(
      ([, entry]) => (entry as { type?: string }).type === "testfake_frame",
    );
    expect(alienAppend).toBeDefined();
    // Non-frame payloads are wrapped generically with the payload untouched.
    expect((alienAppend![1] as { raw?: unknown }).raw).toBe(alienPayload);
  });

  describe("durable backend turn transcripts", () => {
    let transcriptRoot: string;
    let broadcasts: SSEEvent[];

    /**
     * The backend-event persistence path wired to the REAL transcript module
     * over a temp config directory, so exactly-once is proven against the
     * JSONL file and the broadcast the production code actually produces —
     * a fake append could not distinguish skipped from written.
     */
    beforeEach(async () => {
      transcriptRoot = await mkdtemp(
        path.join(tmpdir(), "cc-actor-transcript-"),
      );
      broadcasts = [];
      setTranscriptDeps({
        broadcast: (event: SSEEvent) => {
          broadcasts.push(event);
          return { delivered: true };
        },
        indexMarkdownDocuments: async () => {},
      });
      conversationActors = createTestActorImplementations(
        createMockDeps({
          safeAppendTranscriptEntry: (
            conversationId: string,
            entry: TranscriptEntry,
            meta?: TranscriptBroadcastMeta,
          ) =>
            realSafeAppendTranscriptEntry(
              conversationId,
              entry,
              undefined,
              transcriptRoot,
              meta,
            ),
          safeAppendTranscriptEntryOnce: (
            conversationId: string,
            entry: TranscriptEntry & { id: string },
            meta?: TranscriptBroadcastMeta,
          ) =>
            realSafeAppendTranscriptEntryOnce(
              conversationId,
              entry,
              undefined,
              transcriptRoot,
              meta,
            ),
          appendTranscriptEntryOnce: (conversationId, entry, meta) =>
            realSafeAppendTranscriptEntryOnce(
              conversationId,
              entry,
              undefined,
              transcriptRoot,
              meta,
            ),
        }),
      );
    });

    afterEach(async () => {
      _resetTranscriptDepsForTesting();
      await rm(transcriptRoot, { recursive: true, force: true });
    });

    it.each([
      { scope: "session", emitsError: false },
      { scope: "project", emitsError: true },
    ])(
      "keeps a queued turn failure visible after reload ($scope, error event: $emitsError)",
      async ({ scope, emitsError }) => {
        const error =
          "Selected model is at capacity. Please try a different model.";
        const progress = { type: "thinking" as const, text: "Checking work" };
        mockFactory.createRuntime.mockResolvedValue(
          createMockBackendRuntime({ backend: "codex" }),
        );
        mockSendTurn.mockImplementation(
          async (turn: ConversationBackendTurnInput) => {
            await turn.onEvent({ type: "input_accepted" });
            if (emitsError)
              await turn.onEvent({ type: "error", message: error });
            return {
              ...defaultTurnResult,
              backendRef: { backend: "codex", ref: "thread-1" },
              contentBlocks: [progress],
              failure: {
                kind: "backend_error",
                message: error,
                retryable: false,
              },
            };
          },
        );
        const makeInput =
          scope === "project"
            ? makeProjectExecutePromptInput
            : makeExecutePromptInput;
        const input = makeInput({
          agentBackend: "codex",
          turn: {
            queuedDelivery: {
              messageIds: ["answer-1"],
              deliveryAttemptId: "answer-attempt-1",
            },
          },
        });
        const key = conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        );
        // Answer-driven turns have no browser prompt stream attached.
        registerConversationRuntime(key, {
          managed: createManagedRuntimeFixture(key),
          abortController: new AbortController(),
        });

        const result = await conversationActors.executePromptForMachine(input);
        expect(result.error).toBe(error);
        const messages = await readPersistedConversationMessages(
          path.join(
            transcriptRoot,
            "transcripts",
            `${input.target.conversationId}.jsonl`,
          ),
        );
        expect(messages.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "notice",
        ]);
        expect(messages.at(-2)?.content).toEqual([progress]);
        expect(messages.at(-1)?.content).toEqual([
          { type: "text", text: `Turn stopped: ${error}` },
        ]);
        expect(
          broadcasts.filter(
            (event) =>
              event.type === "message-appended" &&
              event.message.role === "notice",
          ),
        ).toHaveLength(1);
      },
    );

    it.each([false, true])(
      "does not persist a failure notice for a successful or cancelled turn (aborted: %s)",
      async (aborted) => {
        mockFactory.createRuntime.mockResolvedValue(
          createMockBackendRuntime({ backend: "codex" }),
        );
        mockSendTurn.mockResolvedValue({
          ...defaultTurnResult,
          backendRef: { backend: "codex", ref: "thread-1" },
          aborted,
          failure: aborted
            ? { kind: "aborted", message: "Cancelled", retryable: false }
            : null,
        });
        const input = makeExecutePromptInput({ agentBackend: "codex" });
        const key = conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        );
        registerConversationRuntime(key, {
          managed: createManagedRuntimeFixture(key),
          abortController: new AbortController(),
        });

        const result = await conversationActors.executePromptForMachine(input);
        expect(result.aborted).toBe(aborted);
        const messages = await readPersistedConversationMessages(
          path.join(
            transcriptRoot,
            "transcripts",
            `${input.target.conversationId}.jsonl`,
          ),
        );
        expect(messages.some((message) => message.role === "assistant")).toBe(
          true,
        );
        expect(messages.filter((message) => message.role === "notice")).toEqual(
          [],
        );
      },
    );

    async function persistedEntries(
      conversationId: string,
    ): Promise<Array<{ id?: string; uuid?: string }>> {
      const raw = await readFile(
        path.join(transcriptRoot, "transcripts", `${conversationId}.jsonl`),
        "utf-8",
      );
      return raw
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { id?: string; uuid?: string });
    }

    function emitTwice(frame: Record<string, unknown>): void {
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          for (const seq of [0, 1]) {
            await turnInput.onEvent({
              type: "transcript_entry",
              entry: { seq, backend: "claude", type: "assistant", raw: frame },
            });
          }
          return { ...defaultTurnResult };
        },
      );
    }

    it("persists and broadcasts a re-delivered id-bearing frame exactly once", async () => {
      const frameId = "backend:conv-1:run-7:3";
      emitTwice({
        id: frameId,
        timestamp: "2026-07-12T10:00:00.000Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "streamed once" }],
      });

      const input = makeExecutePromptInput({ agentBackend: "claude" });
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );

      await conversationActors.executePromptForMachine(input);

      const entries = await persistedEntries(input.target.conversationId);
      expect(entries.filter((entry) => entry.id === frameId)).toHaveLength(1);
      expect(
        broadcasts.filter(
          (event) =>
            (event as { message?: { id?: string } }).message?.id === frameId,
        ),
      ).toHaveLength(1);
    });

    it("keeps appending an id-less frame on every delivery", async () => {
      emitTwice({
        timestamp: "2026-07-12T10:00:00.000Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "no identity" }],
        uuid: "u-anon-1",
      });

      const input = makeExecutePromptInput({ agentBackend: "claude" });
      registerConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
        {
          managed: createManagedRuntimeFixture(
            conversationRuntimeKey(
              input.projectPath,
              conversationTargetStoreSessionName(input.target),
              input.target.conversationId,
            ),
          ),
          abortController: new AbortController(),
        },
      );

      await conversationActors.executePromptForMachine(input);

      const entries = await persistedEntries(input.target.conversationId);
      expect(entries.filter((entry) => entry.uuid === "u-anon-1")).toHaveLength(
        2,
      );
    });
  });

  it("does not write extra assistant transcript for Claude backends", async () => {
    const input = makeExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
      backendRef: { backend: "codex" as const, ref: "thread-1" },
      contentBlocks: [],
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
      backendRef: { backend: "codex" as const, ref: "thread-1" },
      contentBlocks: [{ type: "text", text: "Partial Codex output" }],
      aborted: true,
      failure: null,
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
          backendRef: { backend: "codex", ref: "thread-1" },
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
      backendRef: { backend: "codex" as const, ref: "thread-1" },
      failure: {
        kind: "backend_error",
        message: "Codex failed after streaming",
        retryable: false,
      },
      continuationDisposition: "clear",
    });
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      streamEmit,
    });

    await conversationActors.executePromptForMachine(input);

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
          backendRef: { backend: "codex" as const, ref: "thread-1" },
          failure: {
            kind: "backend_error",
            message: "Codex failed after streaming",
            retryable: false,
          },
          continuationDisposition: "clear",
        };
      },
    );
    mockFactory.createRuntime.mockResolvedValue(codexRuntime);

    const input = makeExecutePromptInput({ agentBackend: "codex" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      streamEmit,
    });

    await conversationActors.executePromptForMachine(input);

    const errorEvents = streamEmit.mock.calls.filter(
      ([event]) => event === "error",
    );
    expect(errorEvents).toHaveLength(1);
  });

  // ---------------------------------------------------------------
  // Shared structured-output gate — both streaming conversation_turn
  // and single-shot task_run paths must funnel structured-output
  // extraction and validation through the facade's structured-output protocol so
  // workflows see one normalized outcome.
  // ---------------------------------------------------------------
  it("consumes the shared gate's parsed structuredOutput when the backend leaves it unset and the gate parses it from text", async () => {
    mockSendTurn.mockResolvedValueOnce({
      ...defaultTurnResult,
      contentBlocks: [{ type: "text", text: '{"answer":42}' }],
      structuredOutput: undefined,
    });

    const input = makeExecutePromptInput({
      turn: {
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

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
      turn: {
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
      streamEmit,
    });

    const result = await conversationActors.executePromptForMachine(input);

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
  it("blocks a direct actor turn when recovery has retained an uncertain delivery", async () => {
    const row = {
      ...createPendingEntry({
        id: "held",
        content: [{ type: "text", text: "retained" }],
        now: "now",
      }),
      status: "uncertain" as const,
    };
    conversationActors = createTestActorImplementations(
      createMockDeps({
        getConversation: async () =>
          makeSharedConversationState({ pendingQueue: [row] }),
      }),
    );
    const input = makeExecutePromptInput({ persistence: "durable" });
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    const result = await conversationActors.executePromptForMachine(input);
    expect(result.error).toBe(
      "Review queued deliveries before sending another prompt.",
    );
    expect(mockSendTurn).not.toHaveBeenCalled();
  });

  it("does not dispatch after cancellation during runtime creation", async () => {
    const controller = new AbortController();
    const backendRuntime = createMockBackendRuntime();
    conversationActors = createTestActorImplementations(
      createMockDeps({
        getConversationBackendFactory: () => ({
          backend: "claude",
          createRuntime: async () => {
            controller.abort();
            return backendRuntime;
          },
        }),
      }),
    );
    const input = makeExecutePromptInput();
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    await conversationActors
      .executePromptForMachine(input, controller.signal)
      .catch(() => {});
    expect(mockSendTurn).not.toHaveBeenCalled();
  });

  it("routes the conversation turn through deps.executeAgentCall (Task 6.1 parity)", async () => {
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    conversationActors = createTestActorImplementations(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
      } as unknown as Partial<ActorFixtureDependencies>),
    );

    const input = makeExecutePromptInput({ agentBackend: "claude" });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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

  it("expands the native /spec command for the agent without rewriting the user transcript", async () => {
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const appendSpy = vi.fn<
      ActorFixtureDependencies["safeAppendTranscriptEntry"]
    >(async () => {});
    conversationActors = createTestActorImplementations(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
        safeAppendTranscriptEntry: appendSpy,
      } as unknown as Partial<ActorFixtureDependencies>),
    );

    const rawPrompt = "/spec Add a project health endpoint";
    const input = makeExecutePromptInput({ turn: { promptText: rawPrompt } });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    const [request] = executeAgentCallSpy.mock.calls[0]!;
    const agentPrompt = (request as { prompt: string }).prompt;
    expect(agentPrompt).toContain("cctl spec create");
    expect(agentPrompt).toContain("Add a project health endpoint");
    expect(agentPrompt).not.toMatch(/^\s*\/spec(?:\s|$)/);

    const userEntry = appendSpy.mock.calls
      .map((call) => call[1] as { type: string; content: unknown })
      .find((entry) => entry.type === "user");
    expect(userEntry?.content).toEqual([{ type: "text", text: rawPrompt }]);
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
      ActorFixtureDependencies["safeAppendTranscriptEntry"]
    >(async () => {});
    conversationActors = createTestActorImplementations(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
        safeAppendTranscriptEntry: appendSpy,
      } as unknown as Partial<ActorFixtureDependencies>),
    );

    const input = makeExecutePromptInput({
      turn: {
        promptText: "",
        documentFeedback: { items: [fbItem] },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
      ActorFixtureDependencies["safeAppendTranscriptEntry"]
    >(async () => {});
    conversationActors = createTestActorImplementations(
      createMockDeps({ safeAppendTranscriptEntry: appendSpy }),
    );

    const input = makeExecutePromptInput({
      turn: { promptText: "Hello, world!" },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
      ActorFixtureDependencies["appendTranscriptEntryOnce"]
    >(async () => {});
    conversationActors = createTestActorImplementations(
      createMockDeps({
        executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
          typeof vi.fn
        >,
        appendTranscriptEntryOnce: appendSpy,
      } as unknown as Partial<ActorFixtureDependencies>),
    );

    mockSendTurn.mockImplementation(
      async (turnInput: ConversationBackendTurnInput) => {
        await turnInput.onEvent({ type: "input_accepted" });
        return defaultTurnResult;
      },
    );

    const input = makeExecutePromptInput({
      turn: {
        promptText: "also handle the empty-state case",
        documentFeedback: { items: [fbItem] },
        queuedDelivery: {
          messageIds: ["m1", "m2"],
          deliveryAttemptId: "att-1",
        },
      },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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

    const input = makeExecutePromptInput({
      turn: { waitForBackgroundTasks: true },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

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
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });

    const result = await conversationActors.executePromptForMachine(input);

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
      conversationActors = createTestActorImplementations(mockDeps);

      const input = makeExecutePromptInput({
        turn: {
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
        },
      });

      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });

      await conversationActors.executePromptForMachine(input);

      expect(getNextImageIndex).toHaveBeenCalledWith(
        input.target.conversationId,
      );

      expect(saveTranscriptImage).toHaveBeenCalledTimes(3);
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        1,
        input.target.conversationId,
        5,
        "image/png",
        "AAAA",
      );
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        2,
        input.target.conversationId,
        6,
        "image/jpeg",
        "BBBB",
      );
      expect(saveTranscriptImage).toHaveBeenNthCalledWith(
        3,
        input.target.conversationId,
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
        .mocked(mockDeps.appendTranscriptEntryOnce)
        .mock.calls.filter(
          ([, entry]) => (entry as { role?: string }).role === "user",
        );
    }

    it("appends exactly one user transcript entry after backend acceptance and marks rows delivered", async () => {
      const appendOrder: string[] = [];
      mockDeps = createMockDeps({
        appendTranscriptEntryOnce: vi.fn(async (_id, entry) => {
          if ((entry as { role?: string }).role === "user") {
            appendOrder.push("append");
          }
        }),
        confirmQueuedDelivery: vi.fn(async () => {
          appendOrder.push("confirmDelivery");
          return 2;
        }),
      });
      conversationActors = createTestActorImplementations(mockDeps);

      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );

      const input = makeExecutePromptInput({
        turn: {
          promptText: "queued follow-up",
          queuedDelivery: {
            messageIds: ["m1", "m2"],
            deliveryAttemptId: "att-1",
          },
        },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });

      await conversationActors.executePromptForMachine(input);

      const userCalls = userAppendCalls();
      expect(userCalls).toHaveLength(1);
      expect((userCalls[0]![1] as { id?: string }).id).toBe("m1");
      expect((userCalls[0]![1] as { content: unknown }).content).toEqual([
        { type: "text", text: "queued follow-up" },
      ]);

      expect(mockDeps.confirmQueuedDelivery).toHaveBeenCalledTimes(1);
      expect(mockDeps.confirmQueuedDelivery).toHaveBeenCalledWith({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        conversationId: input.target.conversationId,
        ids: ["m1", "m2"],
        deliveryAttemptId: "att-1",
      });
      expect(mockDeps.markQueuedPending).not.toHaveBeenCalled();
      expect(mockDeps.markQueuedFailed).not.toHaveBeenCalled();

      // Append must happen before the rows are released.
      expect(appendOrder).toEqual(["append", "confirmDelivery"]);
    });

    it("appends nothing and holds rows for review when dispatch throws", async () => {
      mockSendTurn.mockRejectedValue(new Error("backend dispatch failed"));

      const input = makeExecutePromptInput({
        turn: {
          promptText: "queued follow-up",
          queuedDelivery: {
            messageIds: ["m1"],
            deliveryAttemptId: "att-1",
          },
        },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });

      await conversationActors.executePromptForMachine(input);

      expect(userAppendCalls()).toHaveLength(0);
      expect(mockDeps.confirmQueuedDelivery).not.toHaveBeenCalled();
      await conversationActors.finalizeQueuedDeliveryForMachine({
        projectPath: input.projectPath,
        target: input.target,

        persistence: input.persistence,
        queuedDelivery: input.turn.queuedDelivery!,
      });
      expect(mockDeps.markQueuedUncertain).toHaveBeenCalledTimes(1);
      expect(mockDeps.markQueuedUncertain).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["m1"],
          deliveryAttemptId: "att-1",
        }),
      );
    });
  });

  // Spec `memory` R5/R6/D4: the `<memory-index>` block is a per-turn
  // live-context source beside the ticket block, for session AND project
  // conversations, and the static advisory contract is the only memory
  // content in the governing instruction layer.
  describe("memory index injection", () => {
    const TICKET_BLOCK = [
      "<active-ticket>",
      "identifier: repo#1",
      "attachments: none",
      "</active-ticket>",
    ].join("\n");

    function memoryBlock(
      text: string | null,
      entries: readonly MemoryIndexEntry[] = [],
      mode: PreparedMemoryIndexDelivery["mode"] = "full",
      composedAt = "2026-07-05T00:00:00.000Z",
    ): PreparedMemoryIndexDelivery {
      return {
        mode,
        composedAt,
        entries,
        block: text,
        rendered: null,
      };
    }

    function indexEntry(
      memoryId: string,
      revision: number,
      statusDelivered = true,
    ): MemoryIndexEntry {
      return {
        memoryId,
        revision,
        slug: `slug-${memoryId}`,
        scope: "project",
        section: "auto",
        statusDelivered,
      };
    }

    /** One claimed workflow result, enough to make the turn settle them. */
    function claimedWorkflowResults(): GraphWorkflowResultDelivery[] {
      return [
        {
          executionId: "exec-alpha",
          boundarySeq: 11,
          projectPath: "/projects/repo",
          sessionName: "test-session",
          originConversationId: "conv-1",
          payload: { status: "halted", output: "first" },
          recordedAt: "2026-08-14T12:00:01.000Z",
          state: "delivering",
          attemptId: "stream-1",
          attemptCount: 1,
          deliveredAt: null,
          effectsDeliveredAt: null,
        },
      ];
    }

    const MEMORY_BLOCK = [
      "<memory-index>",
      "visibility: global + project",
      "- a-lesson [project, just now] A hook",
      "showing 1 of 1 hooks",
      "</memory-index>",
    ].join("\n");

    function registerRuntime(input: ExecutePromptInput): void {
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key),
        abortController: new AbortController(),
      });
    }

    function lastTurnInput(): ConversationBackendTurnInput {
      const call = mockSendTurn.mock.calls.at(-1)! as unknown[];
      return call[0] as ConversationBackendTurnInput;
    }

    function createdRuntimeInstructions(): string {
      const createRuntimeCall = (
        mockFactory.createRuntime as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)! as unknown[];
      const runtimeArgs = createRuntimeCall[0] as {
        sessionInstructions: string[];
      };
      return runtimeArgs.sessionInstructions.join("\n\n");
    }

    type TestDb = ReturnType<typeof _createTestDb>;

    function seedSessionRows(db: TestDb): void {
      db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(
        "/projects/repo",
      );
      db.prepare(
        `INSERT INTO sessions
           (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at, finished)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        "/projects/repo",
        "test-session",
        "/projects/repo/.worktrees/test-session",
        "csm/test-session",
        "2026-07-04T00:00:00.000Z",
        "2026-07-04T00:00:00.000Z",
      );
    }

    /**
     * The production memory delivery over a real store: the real service,
     * composer, freshness engine, and the same spec-binding resolver the
     * spec lifecycle uses, so a lane's bound spec reaches the composer the
     * way it does in production.
     */
    function createRealMemoryDelivery(db: TestDb) {
      const memoryRepo = createMemoryRepo(db, createWriteQueue());
      let currentNow = "2026-07-05T00:00:00.000Z";
      const now = (): string => currentNow;
      const sessions = {
        async isSessionIncarnationOver() {
          return false;
        },
      };
      let idSeq = 0;
      const memoryService = createMemoryService({
        repo: memoryRepo,
        publish: () => ({ delivered: true }),
        contributionGate: openMemoryContributionGate(),
        sessions,
        now,
        generateId: () => `mem-${(idSeq += 1)}`,
      });
      const bindingRepo = createSpecExecutionBindingRepo(db);
      const deliveryRepo = createSpecDeliveryRepo(db);
      const telemetry = createMemoryTelemetryService({
        repo: createMemoryTelemetryRepo(db, createWriteQueue()),
        now,
      });
      const provider = createMemoryIndexContextProvider({
        // The shipped cascade in miniature; the real resolver is proven in
        // delivery-policy.test.ts and wired in service-factory.ts.
        resolveReadPolicy: async (subject) =>
          subject.role === "validator" ? "off" : "ambient",
        composer: createMemoryIndexComposer({
          repo: memoryRepo,
          freshness: createMemoryFreshnessEngine({
            repo: memoryRepo,
            sessions,
            now,
          }),
          now,
        }),
        async findSessionCreatedAt(projectPath, sessionName) {
          const row = db
            .prepare(
              "SELECT created_at FROM sessions WHERE project_path = ? AND session_name = ?",
            )
            .get(projectPath, sessionName);
          return typeof row === "object" &&
            row !== null &&
            "created_at" in row &&
            typeof row.created_at === "string"
            ? row.created_at
            : null;
        },
        async findLinkedTicketId() {
          return null;
        },
        async findBoundSpecId(workflowExecutionId) {
          return (
            resolveBoundSpecExecution(
              { bindingRepo, deliveryRepo },
              workflowExecutionId,
            )?.spec_id ?? null
          );
        },
        async readBudget() {
          return { bytes: 12288, hooks: 80 };
        },
        readIndexDelivery: (conversationId) =>
          telemetry.readIndexDelivery(conversationId),
        resetIndexDelivery: (conversationId) =>
          telemetry.resetIndexDelivery(conversationId),
        now,
      });
      return {
        memoryService,
        provider,
        telemetry,
        setNow(value: string) {
          currentNow = value;
        },
      };
    }

    it("prepends the block to a session turn's effective prompt below the ticket block, never to sessionInstructions", async () => {
      const getMemoryIndexBlock = vi.fn(async () => memoryBlock(MEMORY_BLOCK));
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getLiveTicketBlock: vi.fn(async () => TICKET_BLOCK),
          getMemoryIndexBlock,
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(getMemoryIndexBlock).toHaveBeenCalledWith({
        projectPath: "/projects/repo",
        conversationId: "conv-1",
        conversation: { kind: "session", sessionName: "test-session" },
        role: null,
        workflowExecutionId: null,
        workflowContextId: null,
        runtimeCreatedWithoutResume: false,
        backendReportedCompactionLastTurn: false,
      });
      const prompt = lastTurnInput().promptText;
      expect(prompt.indexOf(TICKET_BLOCK)).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(MEMORY_BLOCK)).toBeGreaterThan(
        prompt.indexOf(TICKET_BLOCK),
      );
      expect(prompt.indexOf("do the work")).toBeGreaterThan(
        prompt.indexOf(MEMORY_BLOCK),
      );
      // The contract may NAME the block; the block's changing content — its
      // hook lines and counts — never enters the frozen instruction layer.
      const instructions = createdRuntimeInstructions();
      expect(instructions).toContain(MEMORY_ADVISORY_CONTRACT);
      expect(instructions).not.toContain(MEMORY_BLOCK);
      expect(instructions).not.toContain("- a-lesson [project, just now]");
    });

    it("prepends the block to a project conversation's turn as well", async () => {
      const getMemoryIndexBlock = vi.fn(async () => memoryBlock(MEMORY_BLOCK));
      conversationActors = createTestActorImplementations(
        createMockDeps({ getMemoryIndexBlock }),
      );
      const input = makeProjectExecutePromptInput({
        turn: {
          promptText: "project turn",
        },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(getMemoryIndexBlock).toHaveBeenCalledWith({
        projectPath: "/projects/repo",
        conversationId: "conv-1",
        conversation: { kind: "project" },
        role: null,
        workflowExecutionId: null,
        workflowContextId: null,
        runtimeCreatedWithoutResume: false,
        backendReportedCompactionLastTurn: false,
      });
      expect(lastTurnInput().promptText).toBe(
        `${MEMORY_BLOCK}\n\nproject turn`,
      );
    });

    /** Emit backend acceptance the way a live runtime does mid-turn. */
    function acceptTurnOnSend(): void {
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );
    }

    // Spec R15: what a turn actually injected is recorded per conversation,
    // following the notepad delivery-watermark precedent — at the seam where
    // the block reaches the agent, never at composition, so a preview of the
    // same block records nothing and a turn rejected before acceptance
    // reports nothing as delivered.
    it("records a watermark for every note revision the injected block carried", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      const log = createCapturingLogger();
      conversationActors = createTestActorImplementations(
        createMockDeps({
          log,
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [
              indexEntry("mem-1", 3),
              indexEntry("mem-2", 1, false),
            ]),
          ),
          recordMemoryIndexDeliveries,
        }),
      );
      acceptTurnOnSend();
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordMemoryIndexDeliveries).toHaveBeenCalledWith({
        conversationId: "conv-1",
        kind: "full",
        composedAt: "2026-07-05T00:00:00.000Z",
        // Per note, not per block: the second entry's status line was withheld
        // and the watermark the seam hands on has to say so.
        notes: [
          { memoryId: "mem-1", revision: 3, statusDelivered: true },
          { memoryId: "mem-2", revision: 1, statusDelivered: false },
        ],
      });
      expect(
        log.entries.find(
          (entry) => entry.message === "prompt.memory_delivery_settled",
        )?.fields,
      ).toEqual({
        conversationId: "conv-1",
        mode: "full",
        entryCount: 2,
        omittedCount: 0,
        bytes: Buffer.byteLength(MEMORY_BLOCK, "utf8"),
      });
      expect(log.allFieldValues()).not.toContain(MEMORY_BLOCK);
      expect(log.allFieldValues()).not.toContain("A hook");
    });

    it("records the watermark only once the backend accepts the message", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [indexEntry("mem-1", 3)]),
          ),
          recordMemoryIndexDeliveries,
        }),
      );
      // Read outside the mock: an assertion thrown inside it would be caught
      // by the turn's own failure handling and never reach the reporter.
      let callsBeforeAcceptance = -1;
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          // Composition, capability setup, MCP apply and dispatch have all run
          // by now; none of them proves the agent read the block.
          callsBeforeAcceptance = recordMemoryIndexDeliveries.mock.calls.length;
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(callsBeforeAcceptance).toBe(0);
      expect(recordMemoryIndexDeliveries).toHaveBeenCalledTimes(1);
    });

    it("records nothing when the turn fails before the backend accepts it", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [indexEntry("mem-1", 3)]),
          ),
          recordMemoryIndexDeliveries,
        }),
      );
      mockSendTurn.mockRejectedValue(new Error("pre-ack crash"));
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordMemoryIndexDeliveries).not.toHaveBeenCalled();
    });

    it("records the delivery once when acceptance fires repeatedly", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [indexEntry("mem-1", 3)]),
          ),
          recordMemoryIndexDeliveries,
        }),
      );
      mockSendTurn.mockImplementation(
        async (turnInput: ConversationBackendTurnInput) => {
          await turnInput.onEvent({ type: "input_accepted" });
          await turnInput.onEvent({ type: "input_accepted" });
          return defaultTurnResult;
        },
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordMemoryIndexDeliveries).toHaveBeenCalledTimes(1);
    });

    // Once the backend has taken the message the agent has read the block, so
    // what the turn delivered is settled fact. A neighbouring post-acceptance
    // write failing must not cost the observation.
    it("records the watermark even when another post-acceptance write fails", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [indexEntry("mem-1", 3)]),
          ),
          recordMemoryIndexDeliveries,
          claimWorkflowResults: vi.fn(async () => claimedWorkflowResults()),
          settleWorkflowResults: vi.fn(async () => {
            throw new Error("workflow settle unavailable");
          }),
        }),
      );
      acceptTurnOnSend();
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await expect(
        conversationActors.executePromptForMachine(input),
      ).rejects.toThrow("Turn context receipts failed");

      expect(recordMemoryIndexDeliveries).toHaveBeenCalledWith({
        conversationId: "conv-1",
        kind: "full",
        composedAt: "2026-07-05T00:00:00.000Z",
        notes: [{ memoryId: "mem-1", revision: 3, statusDelivered: true }],
      });
    });

    // The counter half of the same seam, against the REAL counter rather than a
    // spy: a rejected prompt showed the agent nothing, so it must leave the
    // retrieval count where it was.
    it("counts a retrieval only for a prompt the backend accepted", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider } = createRealMemoryDelivery(db);
        const telemetry = createMemoryTelemetryService({
          repo: createMemoryTelemetryRepo(db, createWriteQueue()),
          now: () => "2026-07-05T00:00:00.000Z",
        });
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "counted-once-per-delivery",
            hook: "A lesson the turn is about to carry",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            // The production wiring in miniature: the turn seam hands what it
            // delivered straight to the telemetry service on the index channel.
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({
                conversationId: input.conversationId,
                channel: "index",
                kind: input.kind,
                composedAt: input.composedAt,
                notes: input.notes,
              }),
          }),
        );

        mockSendTurn.mockRejectedValue(new Error("pre-ack crash"));
        const rejected = makeExecutePromptInput({
          turn: {
            promptText: "rejected turn",
          },
        });
        registerRuntime(rejected);
        await conversationActors.executePromptForMachine(rejected);

        expect(
          await telemetry.listObservations({ kind: "retrieval_index" }),
        ).toEqual([]);
        expect((await telemetry.readIndexDelivery("conv-1")).state).toBeNull();

        acceptTurnOnSend();
        const delivered = makeExecutePromptInput({
          turn: {
            promptText: "delivered turn",
          },
        });
        registerRuntime(delivered);
        await conversationActors.executePromptForMachine(delivered);

        expect(
          await telemetry.listObservations({ kind: "retrieval_index" }),
        ).toEqual([
          expect.objectContaining({
            kind: "retrieval_index",
            memoryId: created.value.note.id,
            count: 1,
          }),
        ]);
        // The whole path, through the real store: the accepted turn left the
        // conversation with a delivery state naming the full block it now
        // holds and an index watermark for the note that block carried, while
        // the rejected turn above left neither.
        const read = await telemetry.readIndexDelivery("conv-1");
        expect(read.state?.lastFullAt).toBe(read.state?.lastDeliveryAt);
        expect(read.watermarks.map((watermark) => watermark.memoryId)).toEqual([
          created.value.note.id,
        ]);
      } finally {
        db.close();
      }
    });

    // Same isolation demand as the watermark, read off the real counter: the
    // agent got the notes, so the count exists whatever a neighbouring
    // post-acceptance write does.
    it("counts the retrieval when another post-acceptance write fails", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider } = createRealMemoryDelivery(db);
        const telemetry = createMemoryTelemetryService({
          repo: createMemoryTelemetryRepo(db, createWriteQueue()),
          now: () => "2026-07-05T00:00:00.000Z",
        });
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "counted-despite-neighbour",
            hook: "A lesson the turn is about to carry",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({
                conversationId: input.conversationId,
                channel: "index",
                kind: input.kind,
                composedAt: input.composedAt,
                notes: input.notes,
              }),
            claimWorkflowResults: vi.fn(async () => claimedWorkflowResults()),
            settleWorkflowResults: vi.fn(async () => {
              throw new Error("workflow settle unavailable");
            }),
          }),
        );

        acceptTurnOnSend();
        const delivered = makeExecutePromptInput({
          turn: {
            promptText: "delivered turn",
          },
        });
        registerRuntime(delivered);
        await expect(
          conversationActors.executePromptForMachine(delivered),
        ).rejects.toThrow("Turn context receipts failed");

        expect(
          await telemetry.listObservations({ kind: "retrieval_index" }),
        ).toEqual([
          expect.objectContaining({
            kind: "retrieval_index",
            memoryId: created.value.note.id,
            count: 1,
          }),
        ]);
      } finally {
        db.close();
      }
    });

    it("records nothing when the conversation has no block to be shown", async () => {
      const recordMemoryIndexDeliveries = vi.fn(async () => {});
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () => null),
          recordMemoryIndexDeliveries,
        }),
      );
      acceptTurnOnSend();
      const input = makeExecutePromptInput({
        turn: { promptText: "do the work" },
      });
      registerRuntime(input);

      await conversationActors.executePromptForMachine(input);

      expect(recordMemoryIndexDeliveries).not.toHaveBeenCalled();
    });

    it.each([
      {
        case: "an empty first full delivery",
        delivery: memoryBlock(null),
        expectedKind: "full",
      },
      {
        case: "a quiet delta",
        delivery: memoryBlock(
          "<memory-index-delta>no memory changes</memory-index-delta>",
          [],
          "delta",
          "2026-07-05T00:01:00.000Z",
        ),
        expectedKind: "delta",
      },
    ] as const)(
      "settles $case even with zero entries",
      async ({ delivery, expectedKind }) => {
        const recordMemoryIndexDeliveries = vi.fn(async () => {});
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: vi.fn(async () => delivery),
            recordMemoryIndexDeliveries,
          }),
        );
        acceptTurnOnSend();
        const input = makeExecutePromptInput({
          turn: { promptText: "zero-entry turn" },
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        expect(recordMemoryIndexDeliveries).toHaveBeenCalledOnce();
        expect(recordMemoryIndexDeliveries).toHaveBeenCalledWith({
          conversationId: "conv-1",
          kind: expectedKind,
          composedAt: delivery.composedAt,
          notes: [],
        });
      },
    );

    it("completes the turn when the watermark write fails", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () =>
            memoryBlock(MEMORY_BLOCK, [indexEntry("mem-1", 1)]),
          ),
          recordMemoryIndexDeliveries: vi.fn(async () => {
            throw new Error("watermark store unavailable");
          }),
        }),
      );
      acceptTurnOnSend();
      const input = makeExecutePromptInput({
        turn: { promptText: "resilient turn" },
      });
      registerRuntime(input);

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      expect(lastTurnInput().promptText).toContain(MEMORY_BLOCK);
    });

    it("proceeds without the block when the memory read fails", async () => {
      conversationActors = createTestActorImplementations(
        createMockDeps({
          getMemoryIndexBlock: vi.fn(async () => {
            throw new Error("memory store unavailable");
          }),
        }),
      );
      const input = makeExecutePromptInput({
        turn: { promptText: "resilient turn" },
      });
      registerRuntime(input);

      const result = await conversationActors.executePromptForMachine(input);

      expect(result.error).toBeNull();
      expect(lastTurnInput().promptText).toBe("resilient turn");
    });

    it.each(["claude", "codex", "cursor"] as const)(
      "delivers the static advisory contract in %s's governing instructions and keeps the changing index out of them",
      async (agentBackend) => {
        const getMemoryIndexBlock = vi.fn(async () =>
          memoryBlock(MEMORY_BLOCK),
        );
        mockFactory.createRuntime.mockResolvedValue({
          ...mockBackendRuntime,
          backend: agentBackend,
        });
        conversationActors = createTestActorImplementations(
          createMockDeps({ getMemoryIndexBlock }),
        );
        const input = makeExecutePromptInput({
          turn: {
            promptText: "first turn",
            modelSelection:
              agentBackend === "codex"
                ? {
                    modelId: "gpt-5.4",
                    parameters: { reasoning: "high", fast: "false" },
                  }
                : agentBackend === "cursor"
                  ? { modelId: "composer-2.5", parameters: { fast: "true" } }
                  : null,
          },
          agentBackend,
        });
        registerRuntime(input);

        await conversationActors.executePromptForMachine(input);

        const instructions = createdRuntimeInstructions();
        expect(instructions).toContain(MEMORY_ADVISORY_CONTRACT);
        expect(instructions).not.toContain(MEMORY_BLOCK);
        expect(instructions).not.toContain("- a-lesson [project, just now]");
        expect(lastTurnInput().promptText).toContain(MEMORY_BLOCK);
      },
    );

    it("delivers a note created after turn N in turn N+1 and drops it after archival, through the real composer, for session and project conversations", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider } = createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
          }),
        );

        for (const [label, makeInput] of [
          ["session", makeExecutePromptInput],
          ["project", makeProjectExecutePromptInput],
        ] as const) {
          // A persistent runtime is already alive — its instructions are frozen.
          const existingRuntime = createMockBackendRuntime({
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
          });
          (
            existingRuntime.sendTurn as ReturnType<typeof vi.fn>
          ).mockResolvedValue(defaultTurnResult);
          const first = makeInput({
            turn: { promptText: `${label} turn one` },
          });
          registerConversationRuntime(
            conversationRuntimeKey(
              first.projectPath,
              conversationTargetStoreSessionName(first.target),
              first.target.conversationId,
            ),
            {
              managed: createManagedRuntimeFixture(
                conversationRuntimeKey(
                  first.projectPath,
                  conversationTargetStoreSessionName(first.target),
                  first.target.conversationId,
                ),
                existingRuntime,
              ),
              abortController: new AbortController(),
            },
          );

          await conversationActors.executePromptForMachine(first);
          expect(lastTurnInput().promptText).not.toContain("<memory-index>");

          const created = await memoryService.create(
            {
              scope: "project",
              kind: "lesson",
              slug: `captured-after-${label}-turn-one`,
              hook: `A lesson captured after the ${label} conversation's first turn`,
            },
            {
              kind: "agent",
              conversationId: "elsewhere",
              visibility: { projectPath: "/projects/repo", session: null },
            },
          );
          if (!created.ok) throw new Error(created.error.code);

          await conversationActors.executePromptForMachine(
            makeInput({ turn: { promptText: `${label} turn two` } }),
          );
          const second = lastTurnInput().promptText;
          expect(second).toContain("<memory-index>");
          expect(second).toContain(
            `- captured-after-${label}-turn-one [project, `,
          );
          expect(second).toContain(`${label} turn two`);

          const archived = await memoryService.archive(
            created.value.note.slug,
            { baseRevision: created.value.note.revision },
            {
              kind: "user",
              visibility: { projectPath: "/projects/repo", session: null },
            },
          );
          expect(archived.ok).toBe(true);

          await conversationActors.executePromptForMachine(
            makeInput({ turn: { promptText: `${label} turn three` } }),
          );
          expect(lastTurnInput().promptText).not.toContain(
            `captured-after-${label}-turn-one`,
          );
          expect(mockFactory.createRuntime).not.toHaveBeenCalled();
        }
      } finally {
        db.close();
      }
    });

    it("delivers a revision written after composition in the following turn's delta", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
            resetMemoryIndexDelivery: (conversationId) =>
              telemetry.resetIndexDelivery(conversationId),
          }),
        );
        const actor = {
          kind: "agent" as const,
          conversationId: "elsewhere",
          visibility: { projectPath: "/projects/repo", session: null },
        };
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "revised-in-flight",
            hook: "Revision one was composed",
          },
          actor,
        );
        if (!created.ok) throw new Error(created.error.code);
        mockSendTurn.mockImplementationOnce(
          async (turnInput: ConversationBackendTurnInput) => {
            setNow("2026-07-05T00:01:00.000Z");
            const revised = await memoryService.update(
              created.value.note.slug,
              {
                baseRevision: created.value.note.revision,
                hook: "Revision two landed before acceptance",
              },
              actor,
            );
            if (!revised.ok) throw new Error(revised.error.code);
            await turnInput.onEvent({ type: "input_accepted" });
            return defaultTurnResult;
          },
        );
        const first = makeExecutePromptInput({
          turn: { promptText: "racing turn" },
        });
        registerRuntime(first);

        await conversationActors.executePromptForMachine(first);

        const afterFirst = await telemetry.readIndexDelivery("conv-1");
        expect(afterFirst.state?.lastDeliveryAt).toBe(
          "2026-07-05T00:00:00.000Z",
        );
        expect(afterFirst.watermarks).toEqual([
          expect.objectContaining({
            memoryId: created.value.note.id,
            revision: 1,
          }),
        ]);
        setNow("2026-07-05T00:02:00.000Z");
        acceptTurnOnSend();
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: { promptText: "next turn" },
            promptCount: 1,
          }),
        );

        const nextPrompt = lastTurnInput().promptText;
        expect(nextPrompt).toContain("<memory-index-delta>");
        expect(nextPrompt).toContain("revised-in-flight");
        expect(nextPrompt).toContain("Revision two landed before acceptance");
      } finally {
        db.close();
      }
    });

    it("keeps delta mode when a Command Center conversation-compaction artifact is created between turns", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
            resetMemoryIndexDelivery: (conversationId) =>
              telemetry.resetIndexDelivery(conversationId),
          }),
        );
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "held-across-cc-compaction",
            hook: "CC artifacts do not describe backend context loss",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: { promptText: "first turn" },
        });
        registerRuntime(first);
        await conversationActors.executePromptForMachine(first);
        const before = (await telemetry.readIndexDelivery("conv-1")).state;
        expect(before?.lastFullAt).toBe("2026-07-05T00:00:00.000Z");

        const artifacts = createContextArtifactsRepo(db);
        artifacts.upsert({
          id: "cc-compaction-1",
          kind: "conversation_compaction",
          scope: "session",
          projectPath: "/projects/repo",
          sessionName: "test-session",
          conversationId: "conv-1",
          messageId: null,
          messageIndex: null,
          coveredStartSeq: 0,
          coveredEndSeq: 4,
          sourceHash: "test-source-hash",
          status: "pending",
          error: null,
          backend: "claude",
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          schemaVersion: 1,
          promptVersion: "test-prompt",
          normalizerVersion: "test-normalizer",
          createdBy: "user",
          createdByConversationId: null,
          payload: null,
          createdAt: "2026-07-05T00:01:00.000Z",
          updatedAt: "2026-07-05T00:01:00.000Z",
        });
        setNow("2026-07-05T00:02:00.000Z");
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: { promptText: "second turn" },
            promptCount: 1,
          }),
        );

        expect(artifacts.findById("cc-compaction-1")?.kind).toBe(
          "conversation_compaction",
        );
        expect(lastTurnInput().promptText).toContain("<memory-index-delta>");
        expect(lastTurnInput().promptText).not.toContain("<memory-index>");
        const after = (await telemetry.readIndexDelivery("conv-1")).state;
        expect(after?.lastFullAt).toBe(before?.lastFullAt);
        expect(after?.lastDeliveryAt).toBe("2026-07-05T00:02:00.000Z");
      } finally {
        db.close();
      }
    });

    it("delivers a full block on the first accepted turn and only the new note in the next delta", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
          }),
        );
        const actor = {
          kind: "agent" as const,
          conversationId: "elsewhere",
          visibility: { projectPath: "/projects/repo", session: null },
        };
        const baseline = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "already-in-full",
            hook: "This note belongs only in the full block",
          },
          actor,
        );
        if (!baseline.ok) throw new Error(baseline.error.code);
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: { promptText: "first turn" },
        });
        registerRuntime(first);

        await conversationActors.executePromptForMachine(first);

        const firstPrompt = lastTurnInput().promptText;
        expect(firstPrompt).toContain("<memory-index>");
        expect(firstPrompt).toContain("already-in-full");
        setNow("2026-07-05T00:01:00.000Z");
        const added = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "added-for-delta",
            hook: "This note was captured after the full block",
          },
          actor,
        );
        if (!added.ok) throw new Error(added.error.code);

        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: { promptText: "second turn" },
            promptCount: 1,
          }),
        );

        const secondPrompt = lastTurnInput().promptText;
        expect(secondPrompt).toContain("<memory-index-delta>");
        expect(secondPrompt).toContain("added-for-delta");
        expect(secondPrompt).not.toContain("already-in-full");
        const read = await telemetry.readIndexDelivery("conv-1");
        expect(read.state?.lastFullAt).toBe("2026-07-05T00:00:00.000Z");
        expect(read.state?.lastDeliveryAt).toBe("2026-07-05T00:01:00.000Z");
      } finally {
        db.close();
      }
    });

    it("settles an empty first full delivery so a later note arrives as a delta", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
          }),
        );
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: {
            promptText: "empty first turn",
          },
        });
        registerRuntime(first);

        await conversationActors.executePromptForMachine(first);

        expect(lastTurnInput().promptText).not.toContain("<memory-index>");
        expect(
          (await telemetry.readIndexDelivery("conv-1")).state?.lastFullAt,
        ).toBe("2026-07-05T00:00:00.000Z");
        setNow("2026-07-05T00:01:00.000Z");
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "after-empty-full",
            hook: "This note was captured after an empty full delivery",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);

        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: { promptText: "second turn" },
            promptCount: 1,
          }),
        );

        expect(lastTurnInput().promptText).toContain("<memory-index-delta>");
        expect(lastTurnInput().promptText).toContain("after-empty-full");
      } finally {
        db.close();
      }
    });

    it("settles a quiet delta and advances last delivery without moving last full", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
          }),
        );
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "unchanged-note",
            hook: "This note does not change between turns",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: { promptText: "first turn" },
        });
        registerRuntime(first);
        await conversationActors.executePromptForMachine(first);

        setNow("2026-07-05T00:02:00.000Z");
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: { promptText: "quiet turn" },
            promptCount: 1,
          }),
        );

        const quietBlock = lastTurnInput()
          .promptText.split("\n\n")
          .find((part) => part.startsWith("<memory-index-delta>"));
        expect(quietBlock?.split("\n")).toHaveLength(1);
        const state = (await telemetry.readIndexDelivery("conv-1")).state;
        expect(state?.lastFullAt).toBe("2026-07-05T00:00:00.000Z");
        expect(state?.lastDeliveryAt).toBe("2026-07-05T00:02:00.000Z");
      } finally {
        db.close();
      }
    });

    it("resets a continuing conversation when its runtime is created without a resume handle", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
            resetMemoryIndexDelivery: (conversationId) =>
              telemetry.resetIndexDelivery(conversationId),
          }),
        );
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "survives-runtime-loss",
            hook: "This note must be sent in full after runtime context loss",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: { promptText: "first turn" },
        });
        registerRuntime(first);
        await conversationActors.executePromptForMachine(first);
        expect(lastTurnInput().promptText).toContain("<memory-index>");

        setNow("2026-07-05T00:01:00.000Z");
        registerRuntime(
          makeExecutePromptInput({
            turn: {
              promptText: "runtime restarted",
            },
            promptCount: 1,
            backendRef: null,
          }),
        );
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: {
              promptText: "runtime restarted",
            },
            promptCount: 1,
            backendRef: null,
          }),
        );

        const restartedPrompt = lastTurnInput().promptText;
        expect(restartedPrompt).toContain("<memory-index>");
        expect(restartedPrompt).not.toContain("<memory-index-delta>");
        expect(restartedPrompt).toContain("survives-runtime-loss");
        expect(
          (await telemetry.readIndexDelivery("conv-1")).state?.lastFullAt,
        ).toBe("2026-07-05T00:01:00.000Z");
      } finally {
        db.close();
      }
    });

    it("resets after a Claude turn reports compaction so the next turn receives a full block", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
            resetMemoryIndexDelivery: (conversationId) =>
              telemetry.resetIndexDelivery(conversationId),
          }),
        );
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "resend-after-claude-compaction",
            hook: "This note must return after backend compaction",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        mockSendTurn.mockImplementation(
          async (turnInput: ConversationBackendTurnInput) => {
            await turnInput.onEvent({ type: "input_accepted" });
            return { ...defaultTurnResult, compacted: true };
          },
        );
        const first = makeExecutePromptInput({
          turn: { promptText: "compacting turn" },
        });
        registerRuntime(first);

        await conversationActors.executePromptForMachine(first);

        expect((await telemetry.readIndexDelivery("conv-1")).state).toBeNull();
        setNow("2026-07-05T00:01:00.000Z");
        acceptTurnOnSend();
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: {
              promptText: "after compaction",
            },
            promptCount: 1,
          }),
        );

        expect(lastTurnInput().promptText).toContain("<memory-index>");
        expect(lastTurnInput().promptText).not.toContain(
          "<memory-index-delta>",
        );
        expect(lastTurnInput().promptText).toContain(
          "resend-after-claude-compaction",
        );
      } finally {
        db.close();
      }
    });

    it("resets after an external Claude turn reports compaction so the next user turn receives a full block", async () => {
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        const { memoryService, provider, telemetry, setNow } =
          createRealMemoryDelivery(db);
        let externalTurnEvent:
          | ((event: ConversationBackendEvent) => void)
          | undefined;
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getConversationBackendFactory: vi.fn(() => ({
              ...mockFactory,
              async createRuntime(input: ConversationBackendCreateInput) {
                externalTurnEvent = input.onExternalTurnEvent;
                return mockBackendRuntime;
              },
            })),
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
            recordMemoryIndexDeliveries: (input) =>
              telemetry.recordDelivery({ ...input, channel: "index" }),
            resetMemoryIndexDelivery: (conversationId) =>
              telemetry.resetIndexDelivery(conversationId),
          }),
        );
        const created = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "resend-after-external-compaction",
            hook: "This note must return after an external backend compaction",
          },
          {
            kind: "agent",
            conversationId: "elsewhere",
            visibility: { projectPath: "/projects/repo", session: null },
          },
        );
        if (!created.ok) throw new Error(created.error.code);
        acceptTurnOnSend();
        const first = makeExecutePromptInput({
          turn: { promptText: "first user turn" },
        });
        registerRuntime(first);

        await conversationActors.executePromptForMachine(first);

        expect(
          (await telemetry.readIndexDelivery("conv-1")).state,
        ).not.toBeNull();
        const emitExternalTurn = externalTurnEvent;
        if (emitExternalTurn === undefined) {
          throw new Error(
            "Claude runtime did not receive an external-turn handler",
          );
        }
        emitExternalTurn({
          type: "external_turn_completed",
          result: { ...defaultTurnResult, compacted: true },
        });
        await vi.waitFor(async () => {
          expect(
            (await telemetry.readIndexDelivery("conv-1")).state,
          ).toBeNull();
        });

        setNow("2026-07-05T00:01:00.000Z");
        await conversationActors.executePromptForMachine(
          makeExecutePromptInput({
            turn: {
              promptText: "after external compaction",
            },
            promptCount: 1,
          }),
        );

        expect(lastTurnInput().promptText).toContain("<memory-index>");
        expect(lastTurnInput().promptText).not.toContain(
          "<memory-index-delta>",
        );
        expect(lastTurnInput().promptText).toContain(
          "resend-after-external-compaction",
        );
      } finally {
        db.close();
      }
    });

    it.each<{
      backend: "codex" | "cursor";
      modelSelection: BackendModelSelection;
    }>([
      {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "high", fast: "false" },
        },
      },
      {
        backend: "cursor" as const,
        modelSelection: {
          modelId: "composer-2.5",
          parameters: { fast: "true" },
        },
      },
    ])(
      "does not reset after a $backend result reports no compaction",
      async ({ backend, modelSelection }) => {
        const db = _createTestDb({ inMemory: true });
        try {
          seedSessionRows(db);
          const { memoryService, provider, telemetry, setNow } =
            createRealMemoryDelivery(db);
          conversationActors = createTestActorImplementations(
            createMockDeps({
              getMemoryIndexBlock: (request) =>
                provider.getForConversation(request),
              recordMemoryIndexDeliveries: (input) =>
                telemetry.recordDelivery({ ...input, channel: "index" }),
              resetMemoryIndexDelivery: (conversationId) =>
                telemetry.resetIndexDelivery(conversationId),
            }),
          );
          const created = await memoryService.create(
            {
              scope: "project",
              kind: "lesson",
              slug: `retained-on-${backend}`,
              hook: `This note remains in the ${backend} context`,
            },
            {
              kind: "agent",
              conversationId: "elsewhere",
              visibility: { projectPath: "/projects/repo", session: null },
            },
          );
          if (!created.ok) throw new Error(created.error.code);
          mockSendTurn.mockImplementation(
            async (turnInput: ConversationBackendTurnInput) => {
              await turnInput.onEvent({ type: "input_accepted" });
              return { ...defaultTurnResult, compacted: false };
            },
          );
          const first = makeExecutePromptInput({
            turn: {
              promptText: "first turn",
              modelSelection,
            },
            agentBackend: backend,
          });
          registerConversationRuntime(
            conversationRuntimeKey(
              first.projectPath,
              conversationTargetStoreSessionName(first.target),
              first.target.conversationId,
            ),
            {
              managed: createManagedRuntimeFixture(
                conversationRuntimeKey(
                  first.projectPath,
                  conversationTargetStoreSessionName(first.target),
                  first.target.conversationId,
                ),
                createMockBackendRuntime({
                  backend,
                  modelSelection,
                }),
              ),
              abortController: new AbortController(),
            },
          );

          await conversationActors.executePromptForMachine(first);

          expect(
            (await telemetry.readIndexDelivery("conv-1")).state,
          ).not.toBeNull();
          setNow("2026-07-05T00:01:00.000Z");
          await conversationActors.executePromptForMachine(
            makeExecutePromptInput({
              turn: {
                promptText: "second turn",
                modelSelection,
              },
              agentBackend: backend,
              promptCount: 1,
            }),
          );

          expect(lastTurnInput().promptText).toContain("<memory-index-delta>");
          expect(lastTurnInput().promptText).not.toContain("<memory-index>");
        } finally {
          db.close();
        }
      },
    );

    // Quota reservation (R5.3) through production: the spec a native-SDD run
    // delivers is an active artifact of its lanes, resolved from the typed
    // spec↔graph binding, so a note about-linked only to that spec is cued
    // into the about section instead of competing as an auto hook.
    it("cues a note about-linked only to the run's bound spec into the about section, resolved through the real spec binding", async () => {
      const SPEC_ID = "spec-memory";
      const REVISION_ID = "revision-memory-5";
      const SPEC_EXECUTION_ID = "spec-execution-memory";
      const WORKFLOW_EXECUTION_ID = "wf-exec-memory";
      const db = _createTestDb({ inMemory: true });
      try {
        seedSessionRows(db);
        db.prepare(
          `INSERT INTO specs (id, project_path, slug, name, gate_policy_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          SPEC_ID,
          "/projects/repo",
          "memory",
          "Memory",
          '{"preset":"contract-bearing"}',
          "2026-07-04T00:00:00.000Z",
          "2026-07-04T00:00:00.000Z",
        );
        db.prepare(
          `INSERT INTO spec_revisions (id, spec_id, number, state, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(REVISION_ID, SPEC_ID, 5, "approved", "2026-07-04T00:00:00.000Z");
        db.prepare(
          `INSERT INTO spec_executions
             (id, spec_id, revision_id, scope_json, state, workflow_execution_id, session_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          SPEC_EXECUTION_ID,
          SPEC_ID,
          REVISION_ID,
          "{}",
          "running",
          WORKFLOW_EXECUTION_ID,
          "test-session",
          "2026-07-04T00:00:00.000Z",
          "2026-07-04T00:00:00.000Z",
        );
        createSpecExecutionBindingRepo(db).insert({
          specExecutionId: SPEC_EXECUTION_ID,
          workflowExecutionId: WORKFLOW_EXECUTION_ID,
          binding: {
            schemaVersion: 2,
            candidateId: "candidate-memory",
            candidateHash: `sha256:${"a".repeat(64)}`,
            pinnedRevisionId: REVISION_ID,
            dispositions: [],
            claims: [],
          },
          createdAt: "2026-07-04T00:00:00.000Z",
        });
        const { memoryService, provider } = createRealMemoryDelivery(db);
        conversationActors = createTestActorImplementations(
          createMockDeps({
            getMemoryIndexBlock: (request) =>
              provider.getForConversation(request),
          }),
        );

        const agent = {
          kind: "agent" as const,
          conversationId: "elsewhere",
          visibility: { projectPath: "/projects/repo", session: null },
        };
        const linkedNote = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "about-the-bound-spec",
            hook: "A lesson about the spec this run delivers",
          },
          agent,
        );
        if (!linkedNote.ok) throw new Error(linkedNote.error.code);
        const link = await memoryService.link(
          linkedNote.value.note.slug,
          { kind: "about", artifact: { kind: "spec", specId: SPEC_ID } },
          agent,
        );
        expect(link.ok).toBe(true);
        const unlinked = await memoryService.create(
          {
            scope: "project",
            kind: "lesson",
            slug: "an-unlinked-lesson",
            hook: "A lesson about nothing this run is bound to",
          },
          agent,
        );
        if (!unlinked.ok) throw new Error(unlinked.error.code);

        const laneRuntime = createMockBackendRuntime({
          modelSelection: { modelId: "opus", parameters: { effort: "high" } },
        });
        (laneRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
          defaultTurnResult,
        );
        const input = makeExecutePromptInput({
          turn: {
            promptText: "lane turn",
          },
          target: targetFromStoreSessionName(
            "repo",
            "test-session",
            "conv-lane",
          ),
        });
        registerConversationRuntime(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
          {
            managed: createManagedRuntimeFixture(
              conversationRuntimeKey(
                input.projectPath,
                conversationTargetStoreSessionName(input.target),
                input.target.conversationId,
              ),
              laneRuntime,
            ),
            abortController: new AbortController(),

            workflowContext: {
              executionId: WORKFLOW_EXECUTION_ID,
              contextId: "memory-index-delivery",
            },
          },
        );

        await conversationActors.executePromptForMachine(input);
        const prompt = lastTurnInput().promptText;
        // A lane's own execution context is an active artifact too (memory
        // R10.1): it is the unit linked-only delivery is exact to.
        expect(prompt).toContain(
          `## about spec:${SPEC_ID}, execution:${WORKFLOW_EXECUTION_ID}, context:${WORKFLOW_EXECUTION_ID}/memory-index-delivery (1 of 1)`,
        );
        expect(prompt).toContain("- about-the-bound-spec [project, ");
        expect(prompt).toContain("## auto (1 of 1)");
        expect(prompt).toContain("- an-unlinked-lesson [project, ");
        expect(prompt.indexOf("## about")).toBeLessThan(
          prompt.indexOf("## auto"),
        );
      } finally {
        db.close();
      }
    });
  });
});

// ===========================================================================
// Integration tests: alignment charter injection into the per-turn seam
// ===========================================================================

describe("executePromptForMachine alignment injection", () => {
  let mockDeps: ActorFixtureDependencies;

  const turnResult: ConversationBackendTurnResult = {
    backendRef: { backend: "claude", ref: "sdk-session-align" },
    costUsd: 0.01,
    durationMs: 100,
    numTurns: 1,
    contextTokens: 100,
    contextWindowMax: 200000,
    contentBlocks: [{ type: "text", text: "ok" }],
    aborted: false,
    compacted: false,
    failure: null,
    continuationDisposition: "retain",
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

  /** The charter version selected by the host for the created backend. */
  function capturedAlignmentVersion(): number | null {
    const call = mockFactory.createRuntime.mock.calls[0]?.[0];
    if (!call) throw new Error("Runtime was not created");
    const key = conversationRuntimeKey(
      call.projectPath,
      conversationTargetStoreSessionName(call.conversationTarget),
      call.conversationId,
    );
    return (
      getConversationRuntime(key)?.managed.configurationSnapshot
        ?.alignmentVersion ?? null
    );
  }

  function registerFreshRuntime(input: ExecutePromptInput): void {
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });
  }

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    mockSendTurn.mockResolvedValue(turnResult);
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
    mockFactory.validateModelSelection.mockImplementation(() => {});
  });

  afterEach(() => {
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
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await conversationActors.executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(injection.text);
    expect(instructions).not.toContain(ALIGN_SUGGESTION_INSTRUCTIONS);
    expect(capturedAlignmentVersion()).toBe(3);
    expect(mockDeps.getActiveAlignmentInjection).toHaveBeenCalledWith(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
    );
  });

  it("injects the one-line cctl CLI nudge into every session's instructions", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await conversationActors.executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(CC_CLI_INSTRUCTIONS);
    expect(CC_CLI_INSTRUCTIONS).not.toContain("\n");
  });

  it("selects the enabled ask-question variant when askUserQuestionsEnabled is true", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput({
      turn: { askUserQuestionsEnabled: true },
    });
    registerFreshRuntime(input);

    await conversationActors.executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(ASK_QUESTION_INSTRUCTIONS_ENABLED);
    expect(instructions).not.toContain(ASK_QUESTION_INSTRUCTIONS);
  });

  it("keeps the default ask-question variant when the flag is unset", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => null),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await conversationActors.executePromptForMachine(input);

    const instructions = capturedSessionInstructions();
    expect(instructions).toContain(ASK_QUESTION_INSTRUCTIONS);
    expect(instructions).not.toContain(ASK_QUESTION_INSTRUCTIONS_ENABLED);
  });

  it("never injects the removed <objective> tag and leaves reference docs passive", async () => {
    mockDeps = createMockDeps({
      getSessionState: vi.fn(async () => makeSessionState()),
      getActiveAlignmentInjection: vi.fn(async () => injection),
      getReferenceDocuments: vi.fn(async () => [
        { filePath: "docs/spec.md", description: "the spec" },
      ]),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);

    await conversationActors.executePromptForMachine(input);

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
    conversationActors = createTestActorImplementations(mockDeps);

    const staleClose = vi.fn();
    const staleRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },

      close: staleClose,
    });
    const freshRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
    });
    (freshRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      turnResult,
    );
    mockFactory.createRuntime.mockResolvedValue(freshRuntime);

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key, staleRuntime, {
        ...(await readInstructionConfiguration(mockDeps, input)),
        alignmentVersion: 3,
      }),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(getConversationRuntime(key)?.managed.backend).toBe(freshRuntime);
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
    conversationActors = createTestActorImplementations(mockDeps);

    const reusedClose = vi.fn();
    const reusedRuntime = createMockBackendRuntime({
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },

      close: reusedClose,
    });
    (reusedRuntime.sendTurn as ReturnType<typeof vi.fn>).mockResolvedValue(
      turnResult,
    );

    const input = makeExecutePromptInput();
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(
        key,
        reusedRuntime,
        await readInstructionConfiguration(mockDeps, input),
      ),
      abortController: new AbortController(),
    });

    await conversationActors.executePromptForMachine(input);

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
    mockFactory.validateModelSelection.mockImplementation(() => {});
  });

  afterEach(() => {
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
      conversationActors = createTestActorImplementations(mockDeps);

      // The continuity handle for the live session: the recreated runtime must
      // resume it via persistedRef so conversation history is not lost.
      const continuityRef =
        backend === "claude"
          ? ({ backend: "claude", ref: "sdk-claude-live" } as const)
          : ({ backend: "codex", ref: "thread-codex-live" } as const);
      const modelSelection: BackendModelSelection =
        backend === "codex"
          ? {
              modelId: "gpt-5.4",
              parameters: { fast: "false", reasoning: "high" },
            }
          : { modelId: "opus", parameters: { effort: "high" } };

      // An already-running runtime whose instructions were baked at the PRIOR
      // charter version — the "baked once" state this regression guards against.
      const staleClose = vi.fn();
      const staleRuntime = createMockBackendRuntime({
        backend,
        modelSelection,

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
        failure: null,
        continuationDisposition: "retain",
      } satisfies ConversationBackendTurnResult);
      const freshRuntime = createMockBackendRuntime({
        backend,
        modelSelection,

        sendTurn: freshSendTurn,
      });
      mockFactory.createRuntime.mockResolvedValue(freshRuntime);

      // Pin the complete selection so it matches the live
      // runtime, isolating the alignment version as the sole recreation trigger
      // this regression exercises.
      const input = makeExecutePromptInput({
        agentBackend: backend,
        backendRef: continuityRef,
        turn: { modelSelection },
      });
      const key = conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      );
      registerConversationRuntime(key, {
        managed: createManagedRuntimeFixture(key, staleRuntime, {
          ...(await readInstructionConfiguration(mockDeps, input)),
          alignmentVersion: BAKED_VERSION,
        }),
        abortController: new AbortController(),
      });

      const result = await conversationActors.executePromptForMachine(input);

      // Recreated, not reused.
      expect(staleClose).toHaveBeenCalledTimes(1);
      expect(staleClose).toHaveBeenCalledTimes(1);
      expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);

      // Rebuilt instructions carry the NEW charter governing section + version.
      const createInput = capturedCreateInput();
      expect(createInput["sessionInstructions"] as string[]).toContain(
        NEW_CHARTER_TEXT,
      );
      expect(
        getConversationRuntime(key)?.managed.configurationSnapshot
          ?.alignmentVersion,
      ).toBe(ADVANCED_VERSION);

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
// Integration tests: pending agent notices (lost background tasks)
// ===========================================================================

describe("executePromptForMachine pending agent notices", () => {
  let mockDeps: ActorFixtureDependencies;

  function makeConversationState(
    overrides: Partial<ConversationState> = {},
  ): ConversationState {
    return makeSharedConversationState({
      status: "idle",
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      ...overrides,
    });
  }

  function capturedCreateInput(): Record<string, unknown> {
    expect(mockFactory.createRuntime).toHaveBeenCalledTimes(1);
    return (
      mockFactory.createRuntime.mock.calls as unknown[][]
    )[0]![0] as Record<string, unknown>;
  }

  function registerFreshRuntime(input: ExecutePromptInput): void {
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    registerConversationRuntime(key, {
      managed: createManagedRuntimeFixture(key),
      abortController: new AbortController(),
    });
  }

  function mutatorCalls(label: string): Array<(c: ConversationState) => void> {
    return (mockDeps.mutateConversation as ReturnType<typeof vi.fn>).mock.calls
      .filter((call: unknown[]) => call[3] === label)
      .map((call: unknown[]) => call[4] as (c: ConversationState) => void);
  }

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    mockSendTurn.mockResolvedValue({
      backendRef: { backend: "claude", ref: "sdk-session-notices" },
      costUsd: 0.01,
      durationMs: 100,
      numTurns: 1,
      contextTokens: 100,
      contextWindowMax: 200000,
      contentBlocks: [{ type: "text", text: "ok" }],
      aborted: false,
      compacted: false,
      error: null,
    });
    mockFactory.createRuntime.mockResolvedValue(mockBackendRuntime);
    mockFactory.validateModelSelection.mockImplementation(() => {});
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("injects pending agent notices into the new runtime's session instructions and drains them", async () => {
    mockDeps = createMockDeps({
      getConversation: vi.fn(async () =>
        makeConversationState({
          pendingAgentNotices: ["notice about lost task A", "notice B"],
        }),
      ),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);
    await conversationActors.executePromptForMachine(input);

    const instructions = capturedCreateInput()[
      "sessionInstructions"
    ] as string[];
    const noticesSection = instructions.find((s) =>
      s.includes("notice about lost task A"),
    );
    expect(noticesSection).toBeDefined();
    expect(noticesSection).toContain("notice B");

    // The consumed notices are drained — but only the consumed ones, so a
    // notice recorded between read and drain survives.
    const drains = mutatorCalls("drain_agent_notices");
    expect(drains).toHaveLength(1);
    const state = makeConversationState({
      pendingAgentNotices: [
        "notice about lost task A",
        "notice B",
        "recorded after the read",
      ],
    });
    drains[0]!(state);
    expect(state.pendingAgentNotices).toEqual(["recorded after the read"]);
  });

  it("adds no notices section and performs no drain when none are pending", async () => {
    mockDeps = createMockDeps({
      getConversation: vi.fn(async () => makeConversationState()),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);
    await conversationActors.executePromptForMachine(input);

    const instructions = capturedCreateInput()[
      "sessionInstructions"
    ] as string[];
    expect(instructions.join("\n")).not.toContain("Session notices");
    expect(mutatorCalls("drain_agent_notices")).toHaveLength(0);
  });

  it("wires onBackgroundTasksLost to append a visible notice and persist a capped agent reminder", async () => {
    mockDeps = createMockDeps({
      getConversation: vi.fn(async () => makeConversationState()),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeExecutePromptInput();
    registerFreshRuntime(input);
    await conversationActors.executePromptForMachine(input);

    const onBackgroundTasksLost = capturedCreateInput()[
      "onBackgroundTasksLost"
    ] as (info: {
      tasks: Array<{ taskId: string; description: string | null }>;
      reason: string;
    }) => void;
    expect(onBackgroundTasksLost).toBeTypeOf("function");

    onBackgroundTasksLost({
      tasks: [{ taskId: "task-a", description: "full regression suite" }],
      reason: "pump_completed",
    });
    await new Promise((resolve) => setImmediate(resolve));

    // A visible notice row lands in the transcript.
    const appendCalls = (
      mockDeps.safeAppendTranscriptEntry as ReturnType<typeof vi.fn>
    ).mock.calls;
    const noticeCall = appendCalls.find(
      (call: unknown[]) =>
        (call[1] as { role?: string; type?: string }).role === "notice",
    );
    expect(noticeCall).toBeDefined();
    const noticeEntry = noticeCall![1] as {
      content: Array<{ type: string; text: string }>;
    };
    expect(noticeEntry.content[0]!.text).toContain("full regression suite");
    expect(noticeEntry.content[0]!.text).toContain("pump_completed");

    // The agent reminder is persisted, capped to the most recent entries.
    const persists = mutatorCalls("background_tasks_lost");
    expect(persists).toHaveLength(1);
    const crowded = makeConversationState({
      pendingAgentNotices: Array.from({ length: 12 }, (_, i) => `old-${i}`),
    });
    persists[0]!(crowded);
    expect(crowded.pendingAgentNotices.length).toBeLessThanOrEqual(10);
    expect(
      crowded.pendingAgentNotices[crowded.pendingAgentNotices.length - 1],
    ).toContain("full regression suite");
  });

  it("does not persist agent reminders for project conversations", async () => {
    mockDeps = createMockDeps({
      getConversation: vi.fn(async () => makeConversationState()),
      getSessionState: vi.fn(async () => null),
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeProjectExecutePromptInput();
    registerFreshRuntime(input);
    await conversationActors.executePromptForMachine(input);

    const onBackgroundTasksLost = capturedCreateInput()[
      "onBackgroundTasksLost"
    ] as (info: {
      tasks: Array<{ taskId: string; description: string | null }>;
      reason: string;
    }) => void;
    onBackgroundTasksLost({
      tasks: [{ taskId: "task-a", description: null }],
      reason: "closed",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mutatorCalls("background_tasks_lost")).toHaveLength(0);
  });

  describe("background-activity wiring", () => {
    function backgroundActivityHandler(): (
      activity: ConversationBackgroundActivity | null,
    ) => void {
      return capturedCreateInput()["onBackgroundActivity"] as (
        activity: ConversationBackgroundActivity | null,
      ) => void;
    }

    function snapshot(taskId: string): ConversationBackgroundActivity {
      return {
        updatedAt: "2026-07-28T10:00:01.000Z",
        tasks: [
          {
            taskId,
            description: "full regression suite",
            taskType: null,
            workflowName: null,
            subagentType: null,
            lastToolName: null,
            totalTokens: null,
            toolUses: null,
            startedAt: "2026-07-28T10:00:00.000Z",
            lastActivityAt: "2026-07-28T10:00:01.000Z",
          },
        ],
      };
    }

    beforeEach(() => {
      getBackgroundActivityChannel()._resetForTesting();
      mockDeps = createMockDeps({
        getConversation: vi.fn(async () => makeConversationState()),
      });
      conversationActors = createTestActorImplementations(mockDeps);
    });

    it("records the backend's snapshot against the conversation", async () => {
      const input = makeExecutePromptInput();
      registerFreshRuntime(input);
      await conversationActors.executePromptForMachine(input);

      backgroundActivityHandler()(snapshot("task-a"));

      expect(getBackgroundActivityChannel().get("conv-1")).toEqual(
        snapshot("task-a"),
      );
    });

    it("clears the recorded snapshot when the backend session dies with tasks in flight", async () => {
      const input = makeExecutePromptInput();
      registerFreshRuntime(input);
      await conversationActors.executePromptForMachine(input);

      backgroundActivityHandler()(snapshot("task-a"));
      (
        capturedCreateInput()["onBackgroundTasksLost"] as (info: {
          tasks: Array<{ taskId: string; description: string | null }>;
          reason: string;
        }) => void
      )({
        tasks: [{ taskId: "task-a", description: null }],
        reason: "pump_completed",
      });

      expect(getBackgroundActivityChannel().get("conv-1")).toBe(null);
    });

    it("clears the recorded snapshot before a replacement runtime is created", async () => {
      const input = makeExecutePromptInput();
      registerFreshRuntime(input);
      await conversationActors.executePromptForMachine(input);
      backgroundActivityHandler()(snapshot("task-a"));

      // A second turn that recreates the runtime: the new subprocess starts
      // with an empty set, so the previous subprocess's snapshot must not
      // survive as a phantom "still running" indicator.
      registerFreshRuntime(input);
      await conversationActors.executePromptForMachine(input);

      expect(getBackgroundActivityChannel().get("conv-1")).toBe(null);
    });
  });
});

// ===========================================================================
// Integration tests: runTaskRunTurnForMachine (task_run branch)
// ===========================================================================

describe("runTaskRunTurnForMachine", () => {
  it.each([
    { scope: "session", resumed: true },
    { scope: "project", resumed: true },
    { scope: "session", resumed: false },
    { scope: "project", resumed: false },
  ] as const)(
    "runs Cursor auxiliary tasks in $scope scope (resumed=$resumed) without granting CC API access",
    async ({ scope, resumed }) => {
      const transport = createScriptedTransport({ ref: "agent-conversation" });
      const runner = createCursorTaskRunner({
        transport,
        storePath: (id) => `/state/${id}`,
        resolveModel: async (selection) => ({ ok: true, selection }),
        translatePortableMcpToCursor,
        newRunId: () => "auxiliary-run",
        now: Date.now,
        stallTimeoutMs: 1000,
        cancelSettleTimeoutMs: 50,
      });
      mockDeps = createMockDeps({
        executeAgentCall: defaultExecuteAgentCall,
        getTaskRunner(backend) {
          if (backend !== "cursor") throw new Error(`${backend} unavailable`);
          return runner;
        },
      });
      conversationActors = createTestActorImplementations(mockDeps);
      const ref = { backend: "cursor" as const, ref: "agent-conversation" };
      const result = await conversationActors.runTaskRunTurnForMachine(
        makeRunTaskRunInput({
          target:
            scope === "session"
              ? targetFromStoreSessionName("repo", "test-session", "conv-1")
              : {
                  scope: "project",
                  projectName: "repo",
                  conversationId: "conv-1",
                },
          agentBackend: "cursor",
          backendRef: resumed ? ref : null,
          turn: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "false" },
            },
          },
        }),
      );
      expect(result.error).toBeNull();
      expect(result.backendRef).toEqual(ref);
      expect(transport.startInputs[0]).toMatchObject({
        conversationId: "conv-1",
        storePath: "/state/conv-1",
        target: null,
      });
      expect(transport.workers[0]?.attachments[0]).toMatchObject({
        mode: resumed ? "resume" : "create",
        ...(resumed ? { ref: "agent-conversation" } : {}),
      });
    },
  );

  function makeRunTaskRunInput(
    overrides: Omit<Partial<RunTaskRunInput>, "turn"> & {
      turn?: Partial<RunTaskRunInput["turn"]>;
    } = {},
  ): RunTaskRunInput {
    const input: RunTaskRunInput = {
      role: null,
      persistence: "durable",
      projectPath: "/projects/repo",
      target: targetFromStoreSessionName("repo", "test-session", "conv-1"),

      worktreePath: "/projects/repo/.worktrees/test-session",

      agentBackend: "claude",
      backendRef: null,
      onModelSelectionResolved: async () => {},
      ...overrides,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task" as const,
        promptText: "do the task",
        modelSelection: null,
        backend: overrides.agentBackend ?? "claude",
        ...overrides.turn,
      },
    };
    registerConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    return input;
  }

  function makeMockTaskRunner(
    runImpl: (req: AgentTaskRequest) => Promise<AgentTaskResult>,
    backend: "claude" | "codex" = "claude",
  ): AgentTaskRunner {
    return {
      backend,
      run: vi.fn(runImpl),
    };
  }

  let mockDeps: ActorFixtureDependencies;

  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetForTesting();
  });

  it("preserves the admission code on a refused task result", async () => {
    mockDeps = createMockDeps({
      executeAgentCall: defaultExecuteAgentCall,
      getTaskRunner: vi.fn(() => {
        throw new Error("refused tasks must not resolve a runner");
      }),
    });
    conversationActors = createTestActorImplementations(mockDeps);
    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          requiresPrivilegedInstructions: true,
          executionClass: "governed-execution",
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
        },
        agentBackend: "cursor",
      }),
    );
    expect(result.failure).toMatchObject({
      kind: "capability_unavailable",
      code: "backend-instructions-unsupported",
      retryable: false,
    });
    expect(result.continuationDisposition).toBe("retain");
    expect(mockDeps.getTaskRunner).not.toHaveBeenCalled();
  });

  it("threads the admitted controller into the runner without replacing it", async () => {
    let runnerSignal: AbortSignal | undefined;
    const runner = makeMockTaskRunner(async (req) => {
      runnerSignal = req.signal;
      return {
        backendRef: null,
        text: "task complete",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    });

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeRunTaskRunInput();
    const admittedController = getConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
    )!.abortController;
    await conversationActors.runTaskRunTurnForMachine(input);

    expect(runnerSignal).toBe(admittedController.signal);
    expect(runnerSignal!.aborted).toBe(false);
    admittedController.abort();
    expect(runnerSignal!.aborted).toBe(true);
  });

  it("preserves the admitted controller when the agent call throws", async () => {
    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => {
        throw new Error("no runner available");
      }),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeRunTaskRunInput();
    const runtime = getConversationRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
    )!;
    const controller = runtime.abortController;
    const result = await conversationActors.runTaskRunTurnForMachine(input);
    expect(result.error).toContain("no runner available");
    expect(runtime.abortController).toBe(controller);
  });

  it("releases the conversation worker before a task runner resumes its reference", async () => {
    const input = makeRunTaskRunInput({
      backendRef: { backend: "claude", ref: "conversation-ref" },
    });
    const key = conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
    const managed = createManagedRuntimeFixture(
      key,
      createMockBackendRuntime({}),
    );
    registerConversationRuntime(key, {
      managed,
      abortController: new AbortController(),
    });
    const runner = makeMockTaskRunner(async (request) => {
      if (managed.backend)
        throw new Error("conversation worker still owns the provider session");
      return {
        backendRef: request.resumeRef,
        text: "captured",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    });
    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);
    const result = await conversationActors.runTaskRunTurnForMachine(input);
    expect(result.error).toBeNull();
    expect(result.backendRef).toEqual(input.backendRef);
    expect(result.contentBlocks).toEqual([{ type: "text", text: "captured" }]);
  });

  it("task_run WITHOUT outputFormat: persists exactly one assistant TranscriptMessage and forwards content blocks", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "task complete",
      usage: { inputTokens: 100, outputTokens: 20 },
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeRunTaskRunInput();
    const result = await conversationActors.runTaskRunTurnForMachine(input);

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
      storeSessionName: "test-session",
    });

    expect(result.contentBlocks).toEqual([
      { type: "text", text: "task complete" },
    ]);
    expect(result.error).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.structuredOutput).toBeUndefined();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("task_run WITH outputFormat: routes outputSchema through the facade structured-output protocol, persists one assistant entry, and exposes the parsed structuredOutput", async () => {
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
        failure: null,
        continuationDisposition: "retain",
      };
    });

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const input = makeRunTaskRunInput({
      turn: {
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { result: { type: "string" } },
            required: ["result"],
          },
        },
      },
    });

    const result = await conversationActors.runTaskRunTurnForMachine(input);

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

  // The gate's provenance is the only way a caller can tell a natively-emitted
  // payload from one the gate had to dig out of a fenced reply. A projection
  // that drops it forces every consumer to assume `native`, so a workflow that
  // persists capture provenance (graph-workflow context outputs) records a
  // claim about the backend that is simply false.
  it("task_run WITH outputFormat: forwards the gate's parse provenance for a fenced reply", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: 'Here is the result:\n```json\n{"result":"ok"}\n```',
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          structuredOutputTurns: "single",
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
          },
        },
      }),
    );

    expect(result.structuredOutput).toEqual({ result: "ok" });
    expect(result.structuredOutputParse).toBeDefined();
    expect(result.structuredOutputParse?.source).toBe("fenced");
  });

  // A schema refusal is a VERDICT about the payload, not an infrastructure
  // failure. Dropping the gate's per-issue errors and the refused text leaves
  // the caller with one opaque sentence, so it cannot tell "the model answered
  // badly" (retry with feedback) from "the turn never ran" (fail the turn).
  it("task_run WITH outputFormat: surfaces the gate's per-issue errors and the refused text when validation fails", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: '{"result":42}',
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          structuredOutputTurns: "single",
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            },
          },
        },
      }),
    );

    expect(result.error).not.toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.structuredOutputIssues).toBeDefined();
    expect(result.structuredOutputIssues?.length ?? 0).toBeGreaterThan(0);
    // Instance-path prefixed, so a caller can key an issue to a field.
    expect(result.structuredOutputIssues?.[0]).toContain("$.result");
    // The refused candidate reaches the caller for inspection / retry feedback.
    expect(result.contentBlocks).toEqual([
      { type: "text", text: '{"result":42}' },
    ]);
  });

  it("presents a configured structured-output string field while preserving the full payload", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: '{"message":"Add eligibility checks","resolutionContext":"Keep guard ordering."}',
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain",
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          structuredOutputTurns: "single",
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                message: { type: "string" },
                resolutionContext: { type: "string" },
              },
              required: ["message", "resolutionContext"],
            },
          },
          structuredOutputTextField: "message",
        },
      }),
    );

    expect(result.structuredOutput).toEqual({
      message: "Add eligibility checks",
      resolutionContext: "Keep guard ordering.",
    });
    expect(result.contentBlocks).toEqual([
      { type: "text", text: "Add eligibility checks" },
    ]);
    expect(mockDeps.safeAppendTranscriptEntry).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        content: [{ type: "text", text: "Add eligibility checks" }],
      }),
      expect.anything(),
    );
  });

  it("task_run failure surfaces aborted=true when failureKind is aborted and persists no transcript entry", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: null,
      usage: null,
      error: "user aborted",
      timedOut: false,
      failure: {
        kind: "aborted",
        message: "user aborted",
        retryable: false,
      },
      continuationDisposition: "retain",
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
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput(),
    );

    expect(result.aborted).toBe(true);
    expect(result.error).toBe("user aborted");
    expect(result.contentBlocks).toEqual([]);
    expect(
      vi.mocked(mockDeps.safeAppendTranscriptEntry),
    ).not.toHaveBeenCalled();
  });

  // Whether a failure is worth retrying is decided from the error VALUE (an
  // undelivered prompt is safe to re-dispatch, a mid-turn death is not) and is
  // unrecoverable from the message alone, so the turn result carries the
  // classifier's verdict rather than leaving callers to re-read prose.
  it("task_run failure carries the classifier's verdict on the result", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: null,
      usage: null,
      error: "QuerySession ended before the turn completed",
      timedOut: false,
      failure: {
        kind: "session_died",
        message: "QuerySession ended before the turn completed",
        retryable: true,
      },
      continuationDisposition: "retain",
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
          failureKind: "session_died" as const,
          backend: "claude" as const,
          message: "QuerySession ended before the turn completed",
          retryable: true,
        },
        contentBlocks: [],
      },
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput(),
    );

    expect(result.failure).toEqual({
      kind: "session_died",
      message: "QuerySession ended before the turn completed",
      retryable: true,
    });
  });

  it("task_run failure preserves captured backend transcript without appending an assistant message", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: null,
      usage: null,
      error: "backend error",
      timedOut: false,
      failure: {
        kind: "backend_error",
        message: "backend error",
        retryable: true,
      },
      continuationDisposition: "retain",
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
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput(),
    );

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
      failure: null,
      continuationDisposition: "retain",
    }));

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const origin = {
      source: "workflow" as const,
      workflow: {
        executionId: "exec-42",
        nodeId: "node-validate",
        iterationIndex: 2,
      },
    };

    await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({ turn: { origin } }),
    );

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
      failure: null,
      continuationDisposition: "retain",
    }));
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({ turn: { promptText: "go" } }),
    );

    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request, facadeDeps] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      prompt: "go",
      backend: "claude",
      writeCapability: "write_capable",
    });
    // Semantic execution intent replaces the resolver callback: the facade
    // resolves the runner itself (via the injected getTaskRunner seam).
    expect(facadeDeps.resolveTaskRunner).toBeUndefined();
    expect(facadeDeps.taskExecution).toMatchObject({
      workingDirectory: "/projects/repo/.worktrees/test-session",
      autonomous: true,
    });
    expect(typeof facadeDeps.getTaskRunner).toBe("function");
  });

  it("fills a missing task-run model selection, timeout, and stall settings from the actual backend profile", async () => {
    let received: AgentTaskRequest | undefined;
    const runner = makeMockTaskRunner(async (request) => {
      received = request;
      return {
        backendRef: null,
        text: "done",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    }, "codex");

    mockDeps = createMockDeps({
      readConfig: vi.fn(async () => ({
        agentBackends: {
          claude: {
            modelSelection: {
              modelId: "opus",
              parameters: { effort: "high" },
            },
            timeoutMs: 300_000,
          },
          codex: {
            modelSelection: {
              modelId: "gpt-5.6-sol",
              parameters: { fast: "false", reasoning: "ultra" },
            },
            timeoutMs: 90_000,
            stallTimeoutMs: 45_000,
          },
          cursor: {
            modelSelection: {
              modelId: "composer-2.5",
              parameters: { fast: "true" },
            },
            timeoutMs: null,
          },
        },
      })),
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    let acknowledgeSelection!: () => void;
    const onModelSelectionResolved = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeSelection = resolve;
        }),
    );
    const execution = conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        agentBackend: "codex",
        onModelSelectionResolved,
      }),
    );

    await vi.waitFor(() => {
      expect(onModelSelectionResolved).toHaveBeenCalledWith({
        modelId: "gpt-5.6-sol",
        parameters: { fast: "false", reasoning: "ultra" },
      });
    });
    expect(received).toBeUndefined();

    acknowledgeSelection();
    await execution;

    expect(received).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.6-sol",
        parameters: { fast: "false", reasoning: "ultra" },
      },
      timeoutMs: 90_000,
      stallTimeoutMs: 45_000,
    });
  });

  it("reports and dispatches the canonical selection admitted from a task-run alias", async () => {
    const aliasSelection: BackendModelSelection = {
      modelId: "gpt-latest",
      parameters: { fast: "false", reasoning: "high" },
    };
    const canonicalSelection: BackendModelSelection = {
      modelId: "gpt-5.6-sol",
      parameters: { fast: "false", reasoning: "high" },
    };
    let received: AgentTaskRequest | undefined;
    const runner = makeMockTaskRunner(async (request) => {
      received = request;
      return {
        backendRef: null,
        text: "done",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    }, "codex");
    const admitConfiguredModelSelection = vi.fn(async () => ({
      ok: true as const,
      modelSelection: canonicalSelection,
    }));
    const onModelSelectionResolved = vi.fn(async () => {});
    mockDeps = createMockDeps({
      admitConfiguredModelSelection,
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          modelSelection: aliasSelection,
        },
        agentBackend: "codex",
        onModelSelectionResolved,
      }),
    );

    expect(admitConfiguredModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        projectPath: "/projects/repo",
        modelSelection: aliasSelection,
      }),
    );
    expect(onModelSelectionResolved).toHaveBeenCalledWith(canonicalSelection);
    expect(received?.modelSelection).toEqual(canonicalSelection);
  });

  it("refuses an invalid task-run selection before reporting or provider dispatch", async () => {
    const invalidSelection: BackendModelSelection = {
      modelId: "not-configured",
      parameters: { reasoning: "high" },
    };
    const runner = makeMockTaskRunner(
      async () => ({
        backendRef: null,
        text: "should not run",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      }),
      "codex",
    );
    const admitConfiguredModelSelection = vi.fn(async () => ({
      ok: false as const,
      code: "unknown_model",
      message: 'Unknown model "not-configured".',
      modelId: "not-configured",
    }));
    const onModelSelectionResolved = vi.fn(async () => {});
    mockDeps = createMockDeps({
      admitConfiguredModelSelection,
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          modelSelection: invalidSelection,
        },
        agentBackend: "codex",
        onModelSelectionResolved,
      }),
    );

    expect(result.error).toBe('Unknown model "not-configured".');
    expect(onModelSelectionResolved).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("preserves explicit task-run settings over the backend profile", async () => {
    let received: AgentTaskRequest | undefined;
    const runner = makeMockTaskRunner(async (request) => {
      received = request;
      return {
        backendRef: null,
        text: "done",
        usage: null,
        error: null,
        timedOut: false,
        failure: null,
        continuationDisposition: "retain",
      };
    }, "codex");
    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      executeAgentCall: defaultExecuteAgentCall,
    });
    conversationActors = createTestActorImplementations(mockDeps);

    await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({
        turn: {
          modelSelection: {
            modelId: "gpt-5.5",
            parameters: { fast: "false", reasoning: "low" },
          },
          timeoutMs: 12_000,
        },
        agentBackend: "codex",
      }),
    );

    expect(received).toMatchObject({
      modelSelection: {
        modelId: "gpt-5.5",
        parameters: { fast: "false", reasoning: "low" },
      },
      timeoutMs: 12_000,
    });
  });

  it("rebuilds and prepends the linked ticket block for every task_run turn", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "done",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain" as const,
    }));
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const getLiveTicketBlock = vi.fn(async () =>
      [
        "<active-ticket>",
        "identifier: repo#12",
        "attachments: none",
        "</active-ticket>",
      ].join("\n"),
    );
    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      getLiveTicketBlock,
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({ turn: { promptText: "derive ticket fields" } }),
    );

    expect(getLiveTicketBlock).toHaveBeenCalledWith(
      "/projects/repo",
      "test-session",
    );
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request.prompt).toBe(
      [
        "<active-ticket>",
        "identifier: repo#12",
        "attachments: none",
        "</active-ticket>",
        "",
        "derive ticket fields",
      ].join("\n"),
    );
  });

  it("continues a task_run without ticket context when the focused lookup fails", async () => {
    const runner = makeMockTaskRunner(async () => ({
      backendRef: null,
      text: "done",
      usage: null,
      error: null,
      timedOut: false,
      failure: null,
      continuationDisposition: "retain" as const,
    }));
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const getLiveTicketBlock = vi.fn(async () => {
      throw new Error("ticket database unavailable");
    });
    mockDeps = createMockDeps({
      getTaskRunner: vi.fn(() => runner),
      getLiveTicketBlock,
      executeAgentCall: executeAgentCallSpy as unknown as ReturnType<
        typeof vi.fn
      >,
    } as unknown as Partial<ActorFixtureDependencies>);
    conversationActors = createTestActorImplementations(mockDeps);

    const result = await conversationActors.runTaskRunTurnForMachine(
      makeRunTaskRunInput({ turn: { promptText: "derive ticket fields" } }),
    );

    expect(result.error).toBeNull();
    expect(getLiveTicketBlock).toHaveBeenCalledTimes(1);
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request.prompt).toBe("derive ticket fields");
  });
});
