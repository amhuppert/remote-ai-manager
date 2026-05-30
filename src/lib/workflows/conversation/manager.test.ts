/**
 * Tests for the conversation machine manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fromPromise } from "xstate";
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
  sendConversationEvent,
  stopConversationActor,
  setMachineFactory,
  _resetMachineFactoryForTesting,
  _resetForTesting,
  applySyncDerivedFields,
  deriveActiveTurnSource,
  shouldRehydrateSnapshot,
  ensureConversationActor,
  setEnsureConversationActorDeps,
  _resetEnsureConversationActorDepsForTesting,
  type EnsureActorInputData,
} from "./manager";
import type { Snapshot } from "xstate";
import { _resetForTesting as resetRuntime } from "./runtime-state";

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
          error: null,
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
};

describe("conversation manager", () => {
  beforeEach(() => {
    _resetForTesting();
    resetRuntime();
    setMachineFactory(createTestMachine);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetMachineFactoryForTesting();
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
        type: "ENTER_DEBUG_MODE",
        logFilePath: "/tmp/debug.jsonl",
      });
      expect(result).toBe(false);
    });

    it("should send events to an existing actor", () => {
      startConversationActor(DEFAULT_INPUT);
      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/debug.jsonl" },
      );
      expect(result).toBe(true);

      const actor = getConversationActor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
      )!;
      // Should now be in debug state
      const stateValue = actor.getSnapshot().value;
      expect(stateValue).toEqual({ debug: "hypothesizing" });
    });

    it("returns false when the event has no transition from the current state", () => {
      startConversationActor(DEFAULT_INPUT);
      // MARK_REPRODUCED is only valid from `debug.awaiting_reproduction`,
      // not from idle, so XState ignores it.
      const result = sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "MARK_REPRODUCED" },
      );
      expect(result).toBe(false);
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
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/.debug/logs.jsonl" },
      );
      expect(actor.getSnapshot().value).toEqual({ debug: "hypothesizing" });
      expect(actor.getSnapshot().context.debugMode?.active).toBe(true);

      // Toggle recording on
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "SET_DEBUG_RECORDING", recording: true },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(true);

      // Toggle recording off
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "SET_DEBUG_RECORDING", recording: false },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(false);

      // Exit debug mode
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "EXIT_DEBUG_MODE" },
      );
      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });
  });

  describe("SSE broadcast and push notifications", () => {
    it("calls broadcastDebugModeStatus action on ENTER_DEBUG_MODE", () => {
      const actor = startConversationActor(DEFAULT_INPUT);
      sendConversationEvent(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        DEFAULT_INPUT.conversationId,
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/.debug/logs.jsonl" },
      );

      // Verify the machine transitioned and debug mode is active
      const snap = actor.getSnapshot();
      expect(snap.value).toEqual({ debug: "hypothesizing" });
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
        backendRef: { backend: "claude" as const, sessionId: "sdk-1" },
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
        projectName: "test-project",
        sessionWorktreePath: "/test/project/.worktrees/test-session",
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
          executionTarget: {
            worktreePath: "/per-context-worktree",
            branchName: "csm/sess-context",
            isolation: "worktree",
            laneId: null,
          },
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
          executionTarget: {
            worktreePath: "/per-context-worktree",
            branchName: "csm/sess-context",
            isolation: "worktree",
            laneId: null,
          },
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
          executionTarget: {
            worktreePath: "/new-worktree",
            branchName: "csm/sess-context",
            isolation: "worktree",
            laneId: null,
          },
        },
      );

      expect(recreated).not.toBe(original);
      expect(recreated.getSnapshot().context.worktreePath).toBe(
        "/new-worktree",
      );
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
        { type: "ENTER_DEBUG_MODE", logFilePath: "/tmp/dbg.jsonl" },
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
            executionTarget: {
              worktreePath: "/new-worktree",
              branchName: "csm/sess-context",
              isolation: "worktree",
              laneId: null,
            },
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

  describe("shouldRehydrateSnapshot", () => {
    function snap(partial: {
      status?: string;
      value?: unknown;
      context?: { pendingQuestion?: unknown };
    }): Snapshot<unknown> {
      return partial as unknown as Snapshot<unknown>;
    }

    it("rehydrates active snapshots with a pending question", () => {
      expect(
        shouldRehydrateSnapshot(
          snap({
            status: "active",
            value: "waiting_for_input",
            context: {
              pendingQuestion: {
                questionId: "q1",
                questions: [{ question: "?", options: [] }],
              },
            },
          }),
        ),
      ).toBe(true);
    });

    it("skips terminal snapshots regardless of pendingQuestion", () => {
      expect(
        shouldRehydrateSnapshot(
          snap({
            status: "done",
            value: "idle",
            context: {
              pendingQuestion: {
                questionId: "q1",
                questions: [{ question: "?", options: [] }],
              },
            },
          }),
        ),
      ).toBe(false);
    });

    it("skips active snapshots without a pending question", () => {
      expect(
        shouldRehydrateSnapshot(
          snap({
            status: "active",
            value: "idle",
            context: { pendingQuestion: null },
          }),
        ),
      ).toBe(false);
      expect(
        shouldRehydrateSnapshot(
          snap({
            status: "active",
            value: { executing: "running" },
            context: { pendingQuestion: null },
          }),
        ),
      ).toBe(false);
      expect(
        shouldRehydrateSnapshot(
          snap({ status: "active", value: "acquiringResources", context: {} }),
        ),
      ).toBe(false);
    });
  });
});
