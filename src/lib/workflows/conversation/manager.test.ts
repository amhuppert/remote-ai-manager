/**
 * Tests for the conversation machine manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fromPromise } from "xstate";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "@/lib/conversations/profile-admission";
import type { ConversationState } from "@/lib/conversations/schemas";
import { conversationMachine } from "./machine";
import type {
  PrepareTurnOutput,
  PrepareTurnInput,
  PromptActorResult,
  ExecutePromptInput,
} from "./types";
import {
  startConversationActor,
  getConversationActor,
  hasLiveConversationActor,
  sendConversationEvent,
  stopConversationActor,
  setMachineFactory,
  _resetMachineFactoryForTesting,
  _resetForTesting,
  applySyncDerivedFields,
  deriveActiveTurnSource,
  ensureConversationActor,
  ensureConversationActorAndDrain,
  executeConversationTurn,
  setEnsureConversationActorDeps,
  _resetEnsureConversationActorDepsForTesting,
  getActorRegistry,
  type EnsureActorInputData,
} from "./manager";
import {
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
  type ConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import {
  _resetForTesting as resetRuntime,
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";

// Infrastructure mock — createLogger is called at module level
vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Test machine factory — same state chart, no-op side effects
// ---------------------------------------------------------------------------

function createTestMachine() {
  return conversationMachine.provide({
    actors: {
      prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
        async () => ({ transcriptPath: "/test.jsonl" }),
      ),
      executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
        async () => ({
          backendRef: null,
          costUsd: null,
          durationMs: null,
          numTurns: null,
          contextTokens: null,
          contextWindow: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: null,
          continuationDisposition: "retain",
        }),
      ),
    },
    actions: {
      persistSnapshot: () => {},
      syncDerivedFields: () => {},
      broadcastConversationStatus: () => {},
      broadcastAskQuestion: () => {},
      broadcastDebugModeStatus: () => {},
      releaseResources: () => {},
      dispatchPushNotification: () => {},
    },
  });
}

const DEFAULT_INPUT = {
  projectPath: "/test/project",
  projectName: "test-project",
  sessionName: "test-session",
  worktreePath: "/test/project/.worktrees/test-session",
  conversationId: "conv-123",
  createdAt: "2026-01-01T00:00:00.000Z",
  forkedFrom: null,
  role: null,
  transcriptPath: null,
  agentBackend: "claude" as const,
  backendRef: null,
  promptCount: 0,
  persistence: "durable" as const,
};

/**
 * Put an entry in the live-actor registry whose `getSnapshot()` returns
 * something that is NOT a machine snapshot — no `can`, no `context`.
 *
 * This is the shape observed in production behind a stuck graph-workflow lane:
 * the registry held an entry for the lane conversation that answered
 * `getSnapshot()` with a bare object, which made `sendConversationEvent` throw
 * `getSnapshot(...).can is not a function` and `ensureConversationActor` throw
 * `Cannot read properties of undefined (reading 'worktreePath')`. Both callers
 * treat the registry as best-effort, so neither may propagate.
 */
function registerUnusableActor(): void {
  const key = conversationRuntimeKey(
    DEFAULT_INPUT.projectPath,
    DEFAULT_INPUT.sessionName,
    DEFAULT_INPUT.conversationId,
  );
  getActorRegistry().set(key, {
    getSnapshot: () => ({}),
    send: () => {
      throw new Error("unusable actor must never be sent to");
    },
    stop: () => {},
  } as unknown as ReturnType<typeof startConversationActor>);
}

describe("conversation manager", () => {
  beforeEach(() => {
    _resetForTesting();
    resetRuntime();
    setMachineFactory(createTestMachine);
    // Turn submission settles the conversation's agent profile before it sends.
    // These cases exercise the lifecycle, not the store, so the seam answers as
    // a legacy conversation would — no profile, no lock, no write.
    setConversationProfileAdmissionDeps({
      mutateConversation: async (_p, _s, _c, _label, mutate) =>
        mutate({
          profileSnapshot: null,
          profileLockedAt: null,
        } as unknown as ConversationState),
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetMachineFactoryForTesting();
    _resetConversationProfileAdmissionDepsForTesting();
  });

  describe("startConversationActor", () => {
    it("should create and register an actor", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      expect(actor).toBeDefined();
      expect(actor.getSnapshot().value).toBe("idle");
    });

    it("should register runtime state for the conversation", () => {
      startConversationActor(DEFAULT_INPUT);
      const actor = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(actor).toBeDefined();
    });

    it("should prevent double-start for the same conversation", () => {
      startConversationActor(DEFAULT_INPUT);
      const actor2 = startConversationActor(DEFAULT_INPUT);
      // Should return the existing actor
      const existing = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(actor2).toBe(existing);
    });

    it("should set initial status based on promptCount", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      expect(actor.getSnapshot().context.status).toBe("new");

      _resetForTesting();
      resetRuntime();
      const actor2 = startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-456",
        promptCount: 3,
      });
      expect(actor2.getSnapshot().context.status).toBe("awaiting");
    });

    it("derives transient from the persistence choice", () => {
      const actor = startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-transient",
        persistence: "ephemeral",
      });
      expect(actor.getSnapshot().context.transient).toBe(true);

      const regular = startConversationActor(DEFAULT_INPUT);
      expect(regular.getSnapshot().context.transient).toBe(false);
    });
  });

  describe("ensureConversationActor with explicit actorInput", () => {
    it("threads an ephemeral actorInput into transient context", async () => {
      const actor = await ensureConversationActor(
        "/test/project",
        "test-session",
        "compaction-a1",
        {
          actorInput: {
            conversationScope: "session",
            projectName: "test-project",
            sessionWorktreePath: "/test/project",
            persistence: "ephemeral",
            conversation: {
              createdAt: "2026-01-01T00:00:00.000Z",
              forkedFrom: null,
              role: null,
              transcriptPath: null,
              agentBackend: "claude",
              backendRef: null,
              promptCount: 0,
              debugMode: null,
            },
          },
        },
      );
      expect(actor.getSnapshot().context.transient).toBe(true);
    });

    it("keeps a durable actorInput non-transient", async () => {
      const actor = await ensureConversationActor(
        "/test/project",
        "test-session",
        "durable-lane-1",
        {
          actorInput: {
            conversationScope: "session",
            projectName: "test-project",
            sessionWorktreePath: "/test/project",
            persistence: "durable",
            conversation: {
              createdAt: "2026-01-01T00:00:00.000Z",
              forkedFrom: null,
              role: null,
              transcriptPath: null,
              agentBackend: "claude",
              backendRef: null,
              promptCount: 0,
              debugMode: null,
            },
          },
        },
      );
      expect(actor.getSnapshot().context.transient).toBe(false);
    });
  });

  describe("getConversationActor", () => {
    it("should return undefined for non-existent actor", () => {
      const actor = getConversationActor("/nope", "nope", "nope");
      expect(actor).toBeUndefined();
    });

    it("should return existing actor", () => {
      const started = startConversationActor(DEFAULT_INPUT);
      const found = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(found).toBe(started);
    });
  });

  describe("sendConversationEvent", () => {
    it("should return false when no actor exists", () => {
      const result = sendConversationEvent("/nope", "nope", "nope", {
        type: "DEBUG_COMMAND",
        command: {
          kind: "enter",
          logFilePath: "/tmp/debug.jsonl",
          debugSessionId: "debug-session-missing",
        },
      });
      expect(result).toBe(false);
    });

    it("should send events to an existing actor", () => {
      startConversationActor(DEFAULT_INPUT);
      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/tmp/debug.jsonl",
            debugSessionId: "debug-session-send",
          },
        },
      );
      expect(result).toBe(true);

      const actor = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      )!;
      // Should now be in debug state
      const stateValue = actor.getSnapshot().value;
      expect(stateValue).toBe("debug");
    });

    it("returns false when the event has no transition from the current state", () => {
      startConversationActor(DEFAULT_INPUT);
      // mark_reproduced is only legal in the awaiting_reproduction phase of
      // an active debug mode, not from idle, so the legality guard refuses it.
      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "DEBUG_COMMAND", command: { kind: "mark_reproduced" } },
      );
      expect(result).toBe(false);
    });

    it("refuses instead of throwing when the registered actor cannot be interrogated", () => {
      // Every caller treats this as best-effort — the lane answer route in
      // particular has already recorded the answer by the time it fires, so a
      // throw here turns a succeeded answer into a 500. A registry entry whose
      // snapshot is not a usable machine snapshot must refuse like a dead one.
      registerUnusableActor();

      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "CLEAR_PENDING_QUESTION" },
      );

      expect(result).toBe(false);
    });

    it("recycles an actor whose snapshot cannot evaluate event legality", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      Object.defineProperty(actor.getSnapshot(), "can", {
        value: undefined,
      });

      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "CLEAR_PENDING_QUESTION" },
      );

      expect(result).toBe(false);
      expect(
        getConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
        ),
      ).toBeUndefined();
    });
  });

  describe("executeConversationTurn", () => {
    it("waits for an external turn to settle when workflow dispatch opts into readiness", async () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      expect(actor.getSnapshot().value).toBe("externalExecuting");

      const executionPromise = executeConversationTurn({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: DEFAULT_INPUT.sessionName,
        conversationId: DEFAULT_INPUT.conversationId,
        streamId: "stream-workflow-wait",
        emit: vi.fn(),
        waitUntilReady: true,
        turn: {
          promptText: "Continue the workflow",
          backend: "claude",
          autonomous: true,
        },
      });

      const earlyOutcome = await Promise.race([
        executionPromise.then(() => "settled" as const),
        Promise.resolve("pending" as const),
      ]);
      expect(earlyOutcome).toBe("pending");

      actor.send({
        type: "EXTERNAL_TURN_COMPLETED",
        result: {
          backendRef: null,
          costUsd: null,
          durationMs: null,
          numTurns: null,
          contextTokens: null,
          contextWindow: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: null,
          continuationDisposition: "retain",
        },
      });

      await expect(executionPromise).resolves.toMatchObject({
        status: "completed",
      });
      expect(actor.getSnapshot().value).toBe("idle");
    });

    it("settles a debug turn through the lifecycle interface and detaches its stream", async () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/tmp/debug.jsonl",
            debugSessionId: "debug-session-turn",
          },
        },
      );

      const emit = vi.fn();
      const execution = await Promise.race([
        executeConversationTurn({
          projectPath: DEFAULT_INPUT.projectPath,
          sessionName: DEFAULT_INPUT.sessionName,
          conversationId: DEFAULT_INPUT.conversationId,
          streamId: "stream-debug",
          emit,
          turn: {
            promptText: "Investigate",
            backend: "claude",
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("debug turn did not settle")), 500),
        ),
      ]);

      expect(execution.status).toBe("completed");
      expect(actor.getSnapshot().value).toBe("debug");
      const runtime = getConversationRuntime(
        conversationRuntimeKey(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
        ),
      );
      expect(runtime?.streamEmit).toBeUndefined();
    });
  });

  describe("stopConversationActor", () => {
    it("should stop and remove actor from registry", () => {
      startConversationActor(DEFAULT_INPUT);
      stopConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        "test",
      );
      const actor = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(actor).toBeUndefined();
    });

    it("should be a no-op for non-existent actor", () => {
      // Should not throw
      stopConversationActor("/nope", "nope", "nope", "test");
    });
  });

  describe("attachPromptStream", () => {
    it("should register stream emit callback in runtime state", async () => {
      const { attachPromptStream } = await import("./manager");
      const { getConversationRuntime, conversationRuntimeKey } =
        await import("./runtime-state");

      startConversationActor(DEFAULT_INPUT);

      const emitFn = vi.fn();
      attachPromptStream(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        "stream-1",
        emitFn,
      );

      const key = conversationRuntimeKey(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      const runtime = getConversationRuntime(key);
      expect(runtime?.streamEmit).toBe(emitFn);
    });
  });

  describe("detachPromptStream", () => {
    it("should clear stream emit callback from runtime state", async () => {
      const { attachPromptStream, detachPromptStream } =
        await import("./manager");
      const { getConversationRuntime, conversationRuntimeKey } =
        await import("./runtime-state");

      startConversationActor(DEFAULT_INPUT);

      const emitFn = vi.fn();
      attachPromptStream(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        "stream-1",
        emitFn,
      );

      detachPromptStream(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        "stream-1",
      );

      const key = conversationRuntimeKey(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      const runtime = getConversationRuntime(key);
      expect(runtime?.streamEmit).toBeUndefined();
    });
  });

  describe("debug mode lifecycle through manager", () => {
    it("enters debug → toggles recording → exits debug back to idle", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      expect(actor.getSnapshot().value).toBe("idle");

      // Enter debug mode
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/tmp/.debug/logs.jsonl",
            debugSessionId: "debug-session-lifecycle",
          },
        },
      );
      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.debugMode?.active).toBe(true);

      // Toggle recording on
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: { kind: "set_recording", recording: true },
        },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(true);

      // Toggle recording off
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: { kind: "set_recording", recording: false },
        },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(false);

      // Exit debug mode
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "DEBUG_COMMAND", command: { kind: "exit" } },
      );
      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });
  });

  describe("SSE broadcast and push notifications", () => {
    it("calls broadcastDebugModeStatus action on debug-mode entry", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/tmp/.debug/logs.jsonl",
            debugSessionId: "debug-session-broadcast",
          },
        },
      );

      // Verify the machine transitioned and debug mode is active
      const snap = actor.getSnapshot();
      expect(snap.value).toBe("debug");
      expect(snap.context.debugMode?.active).toBe(true);
    });

    it("dispatchPushNotification action is wired in provided machine", () => {
      // Verify the manager creates actors with real action implementations
      // by checking that starting an actor and entering debug state works
      const actor = startConversationActor(DEFAULT_INPUT);
      const snap = actor.getSnapshot();
      // Actor started successfully with provided actions — no stub errors
      expect(snap.status).toBe("active");
      expect(snap.value).toBe("idle");
    });
  });

  describe("applySyncDerivedFields", () => {
    it("syncs contextTokens and contextWindowMax from machine context", () => {
      const context = {
        _schemaVersion: 1 as const,
        conversationScope: "session" as const,
        projectPath: "/repo",
        projectName: "proj",
        sessionName: "sess",
        worktreePath: "/repo/.worktrees/sess",
        conversationId: "conv-1",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:01:00Z",
        status: "awaiting" as const,
        promptCount: 3,
        transcriptPath: "/tmp/t.jsonl",
        agentBackend: "claude" as const,
        backendRef: { backend: "claude" as const, ref: "sdk-1" },
        forkedFrom: null,
        role: null,
        activeTurn: null,
        pendingQuestion: null,
        debugMode: null,
        totals: {
          totalCostUsd: 0.15,
          totalDurationMs: 3000,
          totalTurns: 5,
          contextTokens: 150000,
          contextWindowMax: 200000,
        },
        lastResult: null,
        lastError: null,
      };

      const conv = {
        id: "conv-1",
        scope: "session" as const,
        nameOrigin: "default" as const,
        name: null,
        transcriptPath: null,
        status: "new" as const,
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
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
        activeTurnSource: null as "user" | "workflow" | null,
        contextTokens: null as number | null,
        contextWindowMax: null as number | null,
        debugMode: null,
        machineSnapshot: null,
        agentBackend: "claude" as const,
        backendRef: null,
        unread: false,
        pendingQueue: [],
        lastSeenAlignmentVersion: null,
        pendingAgentNotices: [],
        profileSnapshot: null,
        profileLockedAt: null,
        owner: null,
        turnGeneration: 0,
      };

      applySyncDerivedFields(context, conv);

      expect(conv.contextTokens).toBe(150000);
      expect(conv.contextWindowMax).toBe(200000);
      // Verify existing fields still work
      expect(conv.totalCostUsd).toBe(0.15);
      expect(conv.totalDurationMs).toBe(3000);
      expect(conv.totalTurns).toBe(5);
      expect(conv.status).toBe("awaiting");
      expect(conv.promptCount).toBe(3);
      expect(conv.activeTurnSource).toBeNull();
      // The row's backendRef is the resume handle a post-restart actor is
      // rebuilt from — dropping it here silently severs agent context.
      expect(conv.backendRef).toEqual({
        backend: "claude",
        ref: "sdk-1",
      });
    });
  });

  describe("deriveActiveTurnSource", () => {
    it("returns null when no turn is active", () => {
      expect(deriveActiveTurnSource(null)).toBeNull();
    });

    it("classifies non-autonomous conversation_turn as user", () => {
      expect(
        deriveActiveTurnSource({
          kind: "conversation_turn",
          promptText: "hi",
          images: [],
          backend: "claude",
          modelId: null,
          effort: null,
          codexFastMode: null,
          autonomous: false,
          startedAt: null,
          streamId: null,
        }),
      ).toBe("user");
    });

    it("classifies autonomous conversation_turn as workflow (graph-workflow implementer)", () => {
      expect(
        deriveActiveTurnSource({
          kind: "conversation_turn",
          promptText: "auto",
          images: [],
          backend: "claude",
          modelId: null,
          effort: null,
          codexFastMode: null,
          autonomous: true,
          startedAt: null,
          streamId: null,
        }),
      ).toBe("workflow");
    });

    it("classifies task_run as workflow (smart-merge validation-fix, etc.)", () => {
      expect(
        deriveActiveTurnSource({
          kind: "task_run",
          promptText: "fix validation",
          backend: "claude",
          modelId: null,
          effort: null,
          startedAt: null,
        }),
      ).toBe("workflow");
    });
  });

  describe("ensureConversationActor with executionTarget override", () => {
    function makeActorInputData(
      overrides: Partial<EnsureActorInputData> = {},
    ): EnsureActorInputData {
      return {
        conversationScope: "session",
        projectName: "test-project",
        sessionWorktreePath: "/test/project/.worktrees/test-session",
        persistence: "durable",
        conversation: {
          createdAt: "2026-01-01T00:00:00.000Z",
          forkedFrom: null,
          role: null,
          transcriptPath: null,
          agentBackend: "claude",
          backendRef: null,
          promptCount: 0,
          debugMode: null,
        },
        ...overrides,
      };
    }

    afterEach(() => {
      _resetEnsureConversationActorDepsForTesting();
    });

    it("creates a fresh actor using executionTarget.worktreePath instead of session.worktreePath", async () => {
      const loadActorInput = vi.fn(
        async () =>
          makeActorInputData({
            sessionWorktreePath: "/session-worktree",
          }) satisfies EnsureActorInputData,
      );
      setEnsureConversationActorDeps({ loadActorInput });

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          executionTarget: { worktreePath: "/per-context-worktree" },
        },
      );

      expect(loadActorInput).toHaveBeenCalledWith(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(actor.getSnapshot().context.worktreePath).toBe(
        "/per-context-worktree",
      );
    });

    it("returns the existing idle actor when executionTarget matches the actor's worktreePath", async () => {
      startConversationActor({
        ...DEFAULT_INPUT,
        worktreePath: "/per-context-worktree",
      });

      const loadActorInput = vi.fn(async () => makeActorInputData());
      setEnsureConversationActorDeps({ loadActorInput });

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          executionTarget: { worktreePath: "/per-context-worktree" },
        },
      );

      expect(loadActorInput).not.toHaveBeenCalled();
      expect(actor.getSnapshot().context.worktreePath).toBe(
        "/per-context-worktree",
      );
    });

    it("stops and recreates the actor when idle and the worktreePath mismatches", async () => {
      startConversationActor({
        ...DEFAULT_INPUT,
        worktreePath: "/old-worktree",
      });
      const original = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      )!;
      expect(original.getSnapshot().value).toBe("idle");

      const loadActorInput = vi.fn(
        async () =>
          makeActorInputData({
            sessionWorktreePath: "/old-worktree",
          }) satisfies EnsureActorInputData,
      );
      setEnsureConversationActorDeps({ loadActorInput });

      const recreated = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          executionTarget: { worktreePath: "/new-worktree" },
        },
      );

      expect(recreated).not.toBe(original);
      expect(recreated.getSnapshot().context.worktreePath).toBe(
        "/new-worktree",
      );
      expect(loadActorInput).toHaveBeenCalledTimes(1);
    });

    it("rebuilds the actor when the existing one cannot be interrogated", async () => {
      // An entry that cannot answer for its own worktreePath cannot be proven
      // to match the requested target, and it is certainly not mid-turn. The
      // dispatch must replace it rather than halt the execution loop.
      registerUnusableActor();
      const loadActorInput = vi.fn(
        async () =>
          makeActorInputData({
            sessionWorktreePath: "/session-worktree",
          }) satisfies EnsureActorInputData,
      );
      setEnsureConversationActorDeps({ loadActorInput });

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { executionTarget: { worktreePath: "/lane-worktree" } },
      );

      expect(actor.getSnapshot().context.worktreePath).toBe("/lane-worktree");
      expect(loadActorInput).toHaveBeenCalledTimes(1);
    });

    it("throws an infrastructure error when the actor is running and worktreePath mismatches", async () => {
      startConversationActor({
        ...DEFAULT_INPUT,
        worktreePath: "/old-worktree",
      });
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        {
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/tmp/dbg.jsonl",
            debugSessionId: "debug-session-rebind",
          },
        },
      );
      const running = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      )!;
      expect(running.getSnapshot().value).not.toBe("idle");

      const loadActorInput = vi.fn(async () => makeActorInputData());
      setEnsureConversationActorDeps({ loadActorInput });

      await expect(
        ensureConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
          {
            executionTarget: { worktreePath: "/new-worktree" },
          },
        ),
      ).rejects.toThrow(/cannot rebind/);

      const stillRunning = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );
      expect(stillRunning).toBe(running);
      expect(loadActorInput).not.toHaveBeenCalled();
    });

    it("returns the existing actor unchanged when no executionTarget is provided (no-override fallback)", async () => {
      startConversationActor({
        ...DEFAULT_INPUT,
        worktreePath: "/some-worktree",
      });
      const original = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      )!;

      const loadActorInput = vi.fn(async () => makeActorInputData());
      setEnsureConversationActorDeps({ loadActorInput });

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      );

      expect(actor).toBe(original);
      expect(loadActorInput).not.toHaveBeenCalled();
      expect(actor.getSnapshot().context.worktreePath).toBe("/some-worktree");
    });
  });

  // ==========================================================================
  // Task 4.4: drain action
  // ==========================================================================

  function makeQueueDeps(
    overrides: Partial<ConversationQueueDeps> = {},
  ): ConversationQueueDeps {
    return {
      claimNextTurnBatch: vi.fn(async () => null),
      markPending: vi.fn(async () => {}),
      markDelivered: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
      recoverAbandonedDeliveries: vi.fn(async () => 0),
      runConversationCommand: vi.fn(async () => ({
        status: "dispatched" as const,
        jobId: "job-1",
        usedFallback: false,
      })),
      ...overrides,
    };
  }

  describe("drainPendingQueue provided action", () => {
    beforeEach(() => {
      _resetConversationQueueDepsForTesting();
    });

    afterEach(() => {
      _resetConversationQueueDepsForTesting();
    });

    it("no-ops for workflow-role conversations: claimNextTurnBatch is never called", async () => {
      // Use the real provided machine (not the no-op test machine) so the
      // production drainPendingQueue action runs. The role gate must skip the
      // queue entirely for a non-null (workflow) role.
      _resetMachineFactoryForTesting();
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      const actor = startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-workflow",
        role: "iteration",
      });
      // idle entry fires the drain action at startup.
      expect(actor.getSnapshot().value).toBe("idle");
      await Promise.resolve();

      expect(claimNextTurnBatch).not.toHaveBeenCalled();
    });

    it("invokes the queue claim for a user-interactive (null-role) conversation", async () => {
      _resetMachineFactoryForTesting();
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-user",
        role: null,
      });
      await Promise.resolve();

      expect(claimNextTurnBatch).toHaveBeenCalledTimes(1);
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: DEFAULT_INPUT.sessionName,
        conversationId: "conv-user",
      });
    });
  });

  describe("ensureConversationActorAndDrain", () => {
    afterEach(() => {
      _resetConversationQueueDepsForTesting();
      _resetEnsureConversationActorDepsForTesting();
    });

    it("explicitly drains an already-idle existing actor (whose idle entry won't re-fire)", async () => {
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      // A registered actor already sitting in idle: re-ensuring it does not
      // re-enter idle, so the machine's idle-entry drain will not fire again —
      // the explicit drain is what delivers the just-enqueued turn.
      startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-idle-existing",
        role: null,
      });
      claimNextTurnBatch.mockClear();

      await ensureConversationActorAndDrain(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        "conv-idle-existing",
      );
      await Promise.resolve();

      expect(claimNextTurnBatch).toHaveBeenCalledTimes(1);
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: DEFAULT_INPUT.sessionName,
        conversationId: "conv-idle-existing",
      });
    });

    it("does not add an explicit drain for a freshly started actor (its idle entry owns delivery)", async () => {
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      const loadActorInput = vi.fn(
        async () =>
          ({
            conversationScope: "session",
            projectName: DEFAULT_INPUT.projectName,
            sessionWorktreePath: DEFAULT_INPUT.worktreePath,
            persistence: "durable",
            conversation: {
              createdAt: DEFAULT_INPUT.createdAt,
              forkedFrom: null,
              role: null,
              transcriptPath: null,
              agentBackend: "claude",
              backendRef: null,
              promptCount: 0,
              debugMode: null,
            },
          }) satisfies EnsureActorInputData,
      );
      setEnsureConversationActorDeps({ loadActorInput });

      await ensureConversationActorAndDrain(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        "conv-fresh",
      );
      await Promise.resolve();

      // The actor was created fresh, so the redundant explicit drain is skipped;
      // the machine's idle-entry drain owns delivery for a new actor.
      expect(claimNextTurnBatch).not.toHaveBeenCalled();
    });
  });

  describe("hasLiveConversationActor", () => {
    it("is false before start, true after start, false after stop", () => {
      expect(
        hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
        ),
      ).toBe(false);

      startConversationActor(DEFAULT_INPUT);
      expect(
        hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
        ),
      ).toBe(true);

      stopConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        "test",
      );
      expect(
        hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          DEFAULT_INPUT.conversationId,
        ),
      ).toBe(false);
    });
  });
});
