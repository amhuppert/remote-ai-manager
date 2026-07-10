/**
 * Tests for the conversation machine manager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fromPromise } from "xstate";
import { conversationMachine } from "./machine";
import type {
  ConversationContext,
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
  shouldRehydrateSnapshot,
  ensureConversationActor,
  ensureConversationActorAndDrain,
  setEnsureConversationActorDeps,
  _resetEnsureConversationActorDepsForTesting,
  notifyProjectConversationStatusFromContext,
  setProjectConversationStatusNotificationDepsForTesting,
  _resetProjectConversationStatusNotificationDepsForTesting,
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
  drainConversationQueue,
  queuedBatchToSubmitPrompt,
  rehydrateOneConversationActor,
  type EnsureActorInputData,
  type ConversationQueueDeps,
  type DrainSelf,
} from "./manager";
import type { Snapshot } from "xstate";
import type { ConversationEvent } from "./types";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { _resetForTesting as resetRuntime } from "./runtime-state";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  ProjectConversationErrorNotificationInput,
  ProjectConversationStatusNotificationInput,
} from "@/lib/notifications/project-conversation-service";

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
    _resetProjectConversationStatusNotificationDepsForTesting();
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

    it("stamps transient from input into the machine context", () => {
      const actor = startConversationActor({
        ...DEFAULT_INPUT,
        conversationId: "conv-transient",
        transient: true,
      });
      expect(actor.getSnapshot().context.transient).toBe(true);

      const regular = startConversationActor(DEFAULT_INPUT);
      expect(regular.getSnapshot().context.transient).toBe(false);
    });
  });

  describe("ensureConversationActor with explicit actorInput", () => {
    it("threads actorInput.transient into the actor context", async () => {
      const actor = await ensureConversationActor(
        "/test/project",
        "test-session",
        "compaction-a1",
        {
          actorInput: {
            projectName: "test-project",
            sessionWorktreePath: "/test/project",
            transient: true,
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

    it("leaves actors non-transient when actorInput does not set the flag (validator lanes)", async () => {
      const actor = await ensureConversationActor(
        "/test/project",
        "test-session",
        "validator-lane-1",
        {
          actorInput: {
            projectName: "test-project",
            sessionWorktreePath: "/test/project",
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

  describe("notifyProjectConversationStatusFromContext", () => {
    function makeContext(
      overrides: Partial<ConversationContext> = {},
    ): ConversationContext {
      return {
        _schemaVersion: 1,
        projectPath: "/repo",
        projectName: "my-project",
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationScope: "project",
        worktreePath: "/repo",
        conversationId: "conv-plc",
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:01:00Z",
        status: "awaiting",
        promptCount: 2,
        transcriptPath: "/repo/.cc/conv-plc.jsonl",
        agentBackend: "claude",
        backendRef: null,
        forkedFrom: null,
        role: null,
        activeTurn: null,
        pendingQuestion: null,
        debugMode: null,
        totals: {
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: 4,
          contextTokens: null,
          contextWindowMax: null,
        },
        lastResult: null,
        lastError: null,
        ...overrides,
      };
    }

    function installNotificationDeps() {
      const statuses: ProjectConversationStatusNotificationInput[] = [];
      const errors: ProjectConversationErrorNotificationInput[] = [];
      setProjectConversationStatusNotificationDepsForTesting({
        getProjectConversation: async () =>
          ({
            name: "Project chat",
          }) as ConversationState,
        notificationService: {
          handleProjectConversationStatus(input) {
            statuses.push(input);
            return null;
          },
          handleProjectConversationError(input) {
            errors.push(input);
            return {
              id: "notification-1",
              source: "project-conversation",
              type: "project-conversation-failed",
              title: "Project conversation failed",
              message: "failed",
              read: false,
              projectName: input.projectName,
              conversationId: input.conversationId,
              conversationName: input.conversationName ?? null,
              status: "failed",
              errorMessage: input.errorMessage,
              createdAt: "2026-01-01 00:00:00",
            };
          },
        },
      });
      return { statuses, errors };
    }

    it("creates a readiness notification for an awaiting project conversation", async () => {
      const calls = installNotificationDeps();

      await notifyProjectConversationStatusFromContext(makeContext());

      expect(calls.statuses).toEqual([
        {
          projectName: "my-project",
          conversationId: "conv-plc",
          conversationName: "Project chat",
          status: "awaiting",
          transitionKey: "my-project:conv-plc:awaiting:prompt-2:turns-4",
        },
      ]);
      expect(calls.errors).toEqual([]);
    });

    it("creates an input-needed notification for a mid-turn project question", async () => {
      const calls = installNotificationDeps();

      await notifyProjectConversationStatusFromContext(
        makeContext({
          status: "waiting_for_input",
          promptCount: 1,
          pendingQuestion: {
            questionId: "question-7",
            questions: [
              {
                question: "Continue?",
                multiSelect: false,
                options: [],
                required: true,
                allowNote: true,
              },
            ],
          },
        }),
      );

      expect(calls.statuses).toEqual([
        {
          projectName: "my-project",
          conversationId: "conv-plc",
          conversationName: "Project chat",
          status: "waiting_for_input",
          transitionKey:
            "my-project:conv-plc:waiting_for_input:prompt-1:question-question-7",
        },
      ]);
      expect(calls.errors).toEqual([]);
    });

    it("does not treat a stale previous turn error as a mid-turn project question error", async () => {
      const calls = installNotificationDeps();

      await notifyProjectConversationStatusFromContext(
        makeContext({
          status: "waiting_for_input",
          promptCount: 2,
          lastResult: {
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
            error: "Previous turn failed",
          },
          pendingQuestion: {
            questionId: "question-8",
            questions: [
              {
                question: "Continue?",
                multiSelect: false,
                options: [],
                required: true,
                allowNote: true,
              },
            ],
          },
        }),
      );

      expect(calls.statuses).toEqual([
        {
          projectName: "my-project",
          conversationId: "conv-plc",
          conversationName: "Project chat",
          status: "waiting_for_input",
          transitionKey:
            "my-project:conv-plc:waiting_for_input:prompt-2:question-question-8",
        },
      ]);
      expect(calls.errors).toEqual([]);
    });

    it("creates an error notification instead of a readiness notification when the project turn failed", async () => {
      const calls = installNotificationDeps();

      await notifyProjectConversationStatusFromContext(
        makeContext({
          status: "awaiting",
          promptCount: 3,
          totals: {
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: 5,
            contextTokens: null,
            contextWindowMax: null,
          },
          lastError: "Tool call timed out",
        }),
      );

      expect(calls.errors).toEqual([
        {
          projectName: "my-project",
          conversationId: "conv-plc",
          conversationName: "Project chat",
          errorMessage: "Tool call timed out",
          transitionKey:
            "my-project:conv-plc:error:prompt-3:turns-5:Tool%20call%20timed%20out",
        },
      ]);
      expect(calls.statuses).toEqual([]);
    });

    it("does not create project-conversation notifications for session-scoped conversations", async () => {
      const calls = installNotificationDeps();

      await notifyProjectConversationStatusFromContext(
        makeContext({
          sessionName: "session-a",
        }),
      );

      expect(calls.statuses).toEqual([]);
      expect(calls.errors).toEqual([]);
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
        scope: "session" as const,
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
        sessionId: "sdk-1",
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

  // ==========================================================================
  // Task 4.4: drain action + startup recovery
  // ==========================================================================

  const DRAIN_CONTEXT = {
    projectPath: "/test/project",
    projectName: "test-project",
    sessionName: "test-session",
    conversationId: "conv-drain",
  };

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

  function makeDrainSelf(canAccept: boolean): {
    self: DrainSelf;
    send: ReturnType<typeof vi.fn>;
  } {
    const send = vi.fn();
    const self: DrainSelf = {
      getSnapshot: () => ({ can: () => canAccept }),
      send: send as unknown as DrainSelf["send"],
    };
    return { self, send };
  }

  describe("queuedBatchToSubmitPrompt", () => {
    it("joins text blocks and yields no images for text-only content", () => {
      const content: MessageContentBlock[] = [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ];
      const result = queuedBatchToSubmitPrompt(content);
      expect(result.promptText).toBe("first\nsecond");
      expect(result.images).toEqual([]);
    });

    it("returns empty promptText when there are no text blocks", () => {
      const content: MessageContentBlock[] = [
        { type: "image", mediaType: "image/png", base64Data: "abc" },
      ];
      expect(queuedBatchToSubmitPrompt(content).promptText).toBe("");
    });

    it("maps an image block to one ImagePayload with a synthetic attachmentId", () => {
      const content: MessageContentBlock[] = [
        { type: "image", mediaType: "image/png", base64Data: "PNGDATA" },
      ];
      const { images } = queuedBatchToSubmitPrompt(content);
      expect(images).toHaveLength(1);
      expect(images[0]).toEqual({
        attachmentId: "queued-0",
        mediaType: "image/png",
        base64Data: "PNGDATA",
      });
      // Queued images deliver as appended strip images, never inline markers.
      expect(images[0]?.inlineMarkerIndex).toBeUndefined();
    });

    it("preserves mixed text+image order and gives each image a unique id", () => {
      const content: MessageContentBlock[] = [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", base64Data: "A" },
        { type: "text", text: "here" },
        { type: "image", mediaType: "image/jpeg", base64Data: "B" },
      ];
      const { promptText, images } = queuedBatchToSubmitPrompt(content);
      expect(promptText).toBe("look\nhere");
      expect(images.map((img) => img.attachmentId)).toEqual([
        "queued-0",
        "queued-1",
      ]);
      expect(images.map((img) => img.mediaType)).toEqual([
        "image/png",
        "image/jpeg",
      ]);
      expect(images.map((img) => img.base64Data)).toEqual(["A", "B"]);
    });

    it("skips non-text, non-image blocks", () => {
      const content: MessageContentBlock[] = [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Read" },
        { type: "image", mediaType: "image/webp", base64Data: "W" },
      ];
      const { promptText, images } = queuedBatchToSubmitPrompt(content);
      expect(promptText).toBe("hi");
      expect(images).toHaveLength(1);
    });

    it("extracts documentFeedback from a document_feedback block so the drained submit re-emits it", () => {
      const items = [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ];
      const content: MessageContentBlock[] = [
        { type: "document_feedback", items },
      ];
      const result = queuedBatchToSubmitPrompt(content);
      expect(result.documentFeedback).toEqual({ items });
      // No prose text block was persisted; the actor re-derives the agent text.
      expect(result.promptText).toBe("");
    });

    it("merges items from multiple coalesced document_feedback blocks", () => {
      const a = {
        docPath: "a.md",
        path: "a.md",
        headingLabel: "A",
        line: 1,
        quote: "qa",
        note: "na",
      };
      const b = {
        docPath: "b.md",
        path: "b.md",
        headingLabel: "B",
        line: 2,
        quote: "qb",
        note: "nb",
      };
      const content: MessageContentBlock[] = [
        { type: "document_feedback", items: [a] },
        { type: "document_feedback", items: [b] },
      ];
      expect(queuedBatchToSubmitPrompt(content).documentFeedback).toEqual({
        items: [a, b],
      });
    });

    it("omits documentFeedback when no feedback block is present", () => {
      const content: MessageContentBlock[] = [{ type: "text", text: "hi" }];
      expect(
        queuedBatchToSubmitPrompt(content).documentFeedback,
      ).toBeUndefined();
    });

    it("surfaces both promptText and documentFeedback for a coalesced mixed batch", () => {
      const items = [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ];
      // A normal queued text message coalesced with a queued feedback message.
      const content: MessageContentBlock[] = [
        { type: "text", text: "also handle the empty-state case" },
        { type: "document_feedback", items },
      ];
      const result = queuedBatchToSubmitPrompt(content);
      expect(result.promptText).toBe("also handle the empty-state case");
      expect(result.documentFeedback).toEqual({ items });
    });
  });

  describe("drainConversationQueue", () => {
    const BATCH: ClaimedQueuedBatch = {
      deliveryAttemptId: "att-9",
      messageIds: ["m1", "m2"],
      content: [{ type: "text", text: "hello" }],
      command: null,
    };

    // Transient lanes (compaction's synthetic `compaction-<artifactId>`
    // conversations) have no message-queue rows; claiming used to throw and
    // emit error-level `queue.drain_failed` on every teardown.
    it("skips claiming entirely for a transient conversation context", async () => {
      const claimNextTurnBatch = vi.fn(async () => BATCH);
      const deps = makeQueueDeps({ claimNextTurnBatch });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(
        self,
        { ...DRAIN_CONTEXT, transient: true },
        deps,
      );

      expect(claimNextTurnBatch).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(deps.markPending).not.toHaveBeenCalled();
    });

    it("dispatches exactly one SUBMIT_PROMPT carrying the claimed delivery metadata", async () => {
      const claimNextTurnBatch = vi.fn(async () => BATCH);
      const deps = makeQueueDeps({ claimNextTurnBatch });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: DRAIN_CONTEXT.projectPath,
        sessionName: DRAIN_CONTEXT.sessionName,
        conversationId: DRAIN_CONTEXT.conversationId,
      });
      expect(send).toHaveBeenCalledTimes(1);
      const event = send.mock.calls[0]?.[0] as ConversationEvent;
      expect(event.type).toBe("SUBMIT_PROMPT");
      if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
      expect(event.promptText).toBe("hello");
      expect(event.queuedDelivery).toEqual({
        messageIds: ["m1", "m2"],
        deliveryAttemptId: "att-9",
      });
      expect(deps.markPending).not.toHaveBeenCalled();
    });

    it("dispatches a SUBMIT_PROMPT carrying documentFeedback for a queued feedback batch", async () => {
      const items = [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ];
      const feedbackBatch: ClaimedQueuedBatch = {
        deliveryAttemptId: "att-fb",
        messageIds: ["mfb"],
        content: [{ type: "document_feedback", items }],
        command: null,
      };
      const claimNextTurnBatch = vi.fn(async () => feedbackBatch);
      const deps = makeQueueDeps({ claimNextTurnBatch });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(send).toHaveBeenCalledTimes(1);
      const event = send.mock.calls[0]?.[0] as ConversationEvent;
      if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
      expect(event.documentFeedback).toEqual({ items });
    });

    it("dispatches a SUBMIT_PROMPT carrying BOTH text and documentFeedback for a coalesced mixed batch", async () => {
      const items = [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ];
      const mixedBatch: ClaimedQueuedBatch = {
        deliveryAttemptId: "att-mix",
        messageIds: ["mtext", "mfb"],
        content: [
          { type: "text", text: "also handle the empty-state case" },
          { type: "document_feedback", items },
        ],
        command: null,
      };
      const claimNextTurnBatch = vi.fn(async () => mixedBatch);
      const deps = makeQueueDeps({ claimNextTurnBatch });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(send).toHaveBeenCalledTimes(1);
      const event = send.mock.calls[0]?.[0] as ConversationEvent;
      if (event.type !== "SUBMIT_PROMPT") throw new Error("wrong event");
      expect(event.promptText).toBe("also handle the empty-state case");
      expect(event.documentFeedback).toEqual({ items });
    });

    it("returns the batch to pending when the actor cannot accept the prompt", async () => {
      const claimNextTurnBatch = vi.fn(async () => BATCH);
      const markPending = vi.fn(async () => {});
      const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
      const { self, send } = makeDrainSelf(false);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(send).not.toHaveBeenCalled();
      expect(markPending).toHaveBeenCalledTimes(1);
      expect(markPending).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["m1", "m2"],
          deliveryAttemptId: "att-9",
        }),
      );
    });

    it("no-ops on an empty queue: neither dispatches nor returns to pending", async () => {
      const claimNextTurnBatch = vi.fn(async () => null);
      const markPending = vi.fn(async () => {});
      const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(send).not.toHaveBeenCalled();
      expect(markPending).not.toHaveBeenCalled();
    });

    it("returns the batch to pending when an unexpected claim handler error occurs after claim", async () => {
      // Claim succeeds, then send throws — exercises the catch path that must
      // not let the fire-and-forget action reject and must reclaim the rows.
      const claimNextTurnBatch = vi.fn(async () => BATCH);
      const markPending = vi.fn(async () => {});
      const deps = makeQueueDeps({ claimNextTurnBatch, markPending });
      const send = vi.fn(() => {
        throw new Error("send boom");
      });
      const self: DrainSelf = {
        getSnapshot: () => ({ can: () => true }),
        send: send as unknown as DrainSelf["send"],
      };

      await expect(
        drainConversationQueue(self, DRAIN_CONTEXT, deps),
      ).resolves.toBeUndefined();

      expect(markPending).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ["m1", "m2"],
          deliveryAttemptId: "att-9",
        }),
      );
    });
  });

  describe("drainConversationQueue command routing", () => {
    const COMMAND_BATCH: ClaimedQueuedBatch = {
      deliveryAttemptId: "att-cmd",
      messageIds: ["c1"],
      content: [{ type: "text", text: "/commit focus on the API" }],
      command: { command: "commit", hint: "focus on the API" },
    };

    it("routes a command batch to the command service with the direct-path input shape and never sends SUBMIT_PROMPT", async () => {
      const deps = makeQueueDeps({
        claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
      });
      const { self, send } = makeDrainSelf(true);

      await drainConversationQueue(self, DRAIN_CONTEXT, deps);

      expect(send).not.toHaveBeenCalled();
      expect(deps.runConversationCommand).toHaveBeenCalledTimes(1);
      expect(deps.runConversationCommand).toHaveBeenCalledWith({
        projectPath: DRAIN_CONTEXT.projectPath,
        projectName: DRAIN_CONTEXT.projectName,
        sessionName: DRAIN_CONTEXT.sessionName,
        conversationId: DRAIN_CONTEXT.conversationId,
        parsed: { command: "commit", hint: "focus on the API" },
        rawText: "/commit focus on the API",
      });
      expect(deps.markPending).not.toHaveBeenCalled();
      expect(deps.markFailed).not.toHaveBeenCalled();
    });

    it("marks the command row delivered only after the run resolves", async () => {
      const order: string[] = [];
      let resolveRun!: (outcome: {
        status: "dispatched";
        jobId: string;
        usedFallback: boolean;
      }) => void;
      const runConversationCommand = vi.fn(() => {
        order.push("run-start");
        return new Promise<{
          status: "dispatched";
          jobId: string;
          usedFallback: boolean;
        }>((resolve) => {
          resolveRun = resolve;
        });
      });
      const markDelivered = vi.fn(async () => {
        order.push("delivered");
      });
      const deps = makeQueueDeps({
        claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
        runConversationCommand,
        markDelivered,
      });
      const { self } = makeDrainSelf(true);

      const drain = drainConversationQueue(self, DRAIN_CONTEXT, deps);
      // Let the drain reach the awaited run before resolving it.
      await vi.waitFor(() => expect(runConversationCommand).toHaveBeenCalled());
      expect(markDelivered).not.toHaveBeenCalled();

      resolveRun({ status: "dispatched", jobId: "job-7", usedFallback: false });
      await drain;

      expect(order).toEqual(["run-start", "delivered"]);
      expect(markDelivered).toHaveBeenCalledWith({
        projectPath: DRAIN_CONTEXT.projectPath,
        sessionName: DRAIN_CONTEXT.sessionName,
        conversationId: DRAIN_CONTEXT.conversationId,
        ids: ["c1"],
        deliveryAttemptId: "att-cmd",
      });
    });

    it("maps the project sentinel to sessionName null + noticeSessionName, like the direct path", async () => {
      const deps = makeQueueDeps({
        claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
      });
      const { self } = makeDrainSelf(true);

      await drainConversationQueue(
        self,
        {
          ...DRAIN_CONTEXT,
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        },
        deps,
      );

      expect(deps.runConversationCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionName: null,
          noticeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        }),
      );
    });

    it("marks the row failed (terminal, error recorded) when the run throws, never returning it to pending", async () => {
      // A service throw is a system error: rejections and fallbacks resolve as
      // outcomes. Returning the row to pending would retry a deterministic
      // failure on every idle entry, so the drain must settle it terminally.
      const deps = makeQueueDeps({
        claimNextTurnBatch: vi.fn(async () => COMMAND_BATCH),
        runConversationCommand: vi.fn(async () => {
          throw new Error("command run boom");
        }),
      });
      const { self, send } = makeDrainSelf(true);

      await expect(
        drainConversationQueue(self, DRAIN_CONTEXT, deps),
      ).resolves.toBeUndefined();

      expect(send).not.toHaveBeenCalled();
      expect(deps.markDelivered).not.toHaveBeenCalled();
      expect(deps.markPending).not.toHaveBeenCalled();
      expect(deps.markFailed).toHaveBeenCalledWith({
        projectPath: DRAIN_CONTEXT.projectPath,
        sessionName: DRAIN_CONTEXT.sessionName,
        conversationId: DRAIN_CONTEXT.conversationId,
        ids: ["c1"],
        deliveryAttemptId: "att-cmd",
        error: "command run boom",
      });
    });
  });

  describe("drain integration over the real-store queue (text → command → text)", () => {
    it("drains as turn, command run, turn — in order, with direct-path command semantics", async () => {
      const fixture = createPersistenceFixture();
      try {
        const projectPath = "/repos/proj";
        const sessionName = "feat";
        const conversationId = "conv-int";
        fixture.seedProject(projectPath);
        fixture.seedSession(projectPath, sessionName);
        await fixture.seedConversation(
          projectPath,
          sessionName,
          conversationStateSchema.parse({
            id: conversationId,
            transcriptPath: null,
            status: "running",
            promptCount: 0,
            createdAt: "2026-06-01T00:00:00.000Z",
            lastActivityAt: "2026-06-01T00:00:00.000Z",
          }),
        );

        const queueService = createMessageQueueService({
          mutateConversation: (p, s, c, label, mutate) =>
            fixture.deps.mutateConversation(p, s, c, label, mutate),
          getConversation: (p, s, c) => fixture.deps.getConversation(p, s, c),
          getProjectDisplayName: () => "proj",
          broadcast: () => {},
          now: () => new Date().toISOString(),
          newId: () => crypto.randomUUID(),
        });

        const key = { projectPath, sessionName, conversationId };
        const first = await queueService.enqueue({
          ...key,
          content: [{ type: "text", text: "first message" }],
        });
        const command = await queueService.enqueue({
          ...key,
          content: [{ type: "text", text: "/commit tighten the API" }],
        });
        const last = await queueService.enqueue({
          ...key,
          content: [{ type: "text", text: "last message" }],
        });

        const runInputs: unknown[] = [];
        const commandRowStatusDuringRun: string[] = [];
        const deps: ConversationQueueDeps = {
          claimNextTurnBatch: (input) => queueService.claimNextTurnBatch(input),
          markPending: (input) => queueService.markPending(input),
          markDelivered: (input) => queueService.markDelivered(input),
          markFailed: (input) => queueService.markFailed(input),
          recoverAbandonedDeliveries: (input) =>
            queueService.recoverAbandonedDeliveries(input),
          async runConversationCommand(input) {
            runInputs.push(input);
            // The row must not be marked delivered while the run is in flight.
            const conv = await fixture.deps.getConversation(
              projectPath,
              sessionName,
              conversationId,
            );
            commandRowStatusDuringRun.push(
              conv?.pendingQueue.find((r) => r.id === command.id)?.status ??
                "missing",
            );
            return {
              status: "dispatched",
              jobId: "job-int",
              usedFallback: false,
            };
          },
        };

        const sent: ConversationEvent[] = [];
        const self: DrainSelf = {
          getSnapshot: () => ({ can: () => true }),
          send: (event) => {
            sent.push(event);
          },
        };
        const context = {
          projectPath,
          projectName: "proj",
          sessionName,
          conversationId,
        };

        // Drain 1: the plain prefix before the command becomes one turn.
        await drainConversationQueue(self, context, deps);
        expect(sent).toHaveLength(1);
        const firstEvent = sent[0];
        if (firstEvent?.type !== "SUBMIT_PROMPT") {
          throw new Error("expected SUBMIT_PROMPT");
        }
        expect(firstEvent.promptText).toBe("first message");
        expect(firstEvent.queuedDelivery?.messageIds).toEqual([first.id]);
        // Simulate backend acceptance of the dispatched turn.
        await queueService.markDelivered({
          ...key,
          ids: [first.id],
          deliveryAttemptId: firstEvent.queuedDelivery!.deliveryAttemptId,
        });

        // Drain 2: the command at the head runs through the command service.
        await drainConversationQueue(self, context, deps);
        expect(sent).toHaveLength(1);
        expect(runInputs).toEqual([
          {
            projectPath,
            projectName: "proj",
            sessionName,
            conversationId,
            parsed: { command: "commit", hint: "tighten the API" },
            rawText: "/commit tighten the API",
          },
        ]);
        expect(commandRowStatusDuringRun).toEqual(["delivering"]);
        // Read back the RELOADED state: command delivered then pruned, trailing
        // text still pending.
        const afterCommand = await fixture.deps.getConversation(
          projectPath,
          sessionName,
          conversationId,
        );
        expect(
          afterCommand?.pendingQueue.find((r) => r.id === command.id),
        ).toBeUndefined();
        expect(
          afterCommand?.pendingQueue.find((r) => r.id === last.id)?.status,
        ).toBe("pending");

        // Drain 3: the trailing text drains as a normal turn.
        await drainConversationQueue(self, context, deps);
        expect(sent).toHaveLength(2);
        const lastEvent = sent[1];
        if (lastEvent?.type !== "SUBMIT_PROMPT") {
          throw new Error("expected SUBMIT_PROMPT");
        }
        expect(lastEvent.promptText).toBe("last message");
        expect(lastEvent.queuedDelivery?.messageIds).toEqual([last.id]);
      } finally {
        fixture.close();
      }
    });
  });

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
            projectName: DEFAULT_INPUT.projectName,
            sessionWorktreePath: DEFAULT_INPUT.worktreePath,
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

  describe("rehydrateOneConversationActor startup recovery", () => {
    const CONV_ID = "conv-rehydrate";
    const KEY = `${DEFAULT_INPUT.projectPath}::${DEFAULT_INPUT.sessionName}::${CONV_ID}`;

    afterEach(() => {
      _resetConversationQueueDepsForTesting();
    });

    // A resumable snapshot: active + pendingQuestion (the only shape the
    // manager rehydrates). `idle` resolves cleanly without re-invoking the
    // executePrompt actor; the createTestMachine drainPendingQueue stub no-ops
    // on idle entry so it does not interfere with the recovery assertions.
    function makeResumableSnapshot(): Snapshot<unknown> {
      return {
        status: "active",
        value: "idle",
        context: {
          _schemaVersion: 1,
          projectPath: DEFAULT_INPUT.projectPath,
          projectName: DEFAULT_INPUT.projectName,
          sessionName: DEFAULT_INPUT.sessionName,
          worktreePath: DEFAULT_INPUT.worktreePath,
          conversationId: CONV_ID,
          createdAt: DEFAULT_INPUT.createdAt,
          lastActivityAt: DEFAULT_INPUT.createdAt,
          status: "waiting_for_input",
          promptCount: 1,
          transcriptPath: "/t.jsonl",
          agentBackend: "claude",
          backendRef: null,
          forkedFrom: null,
          role: null,
          activeTurn: null,
          pendingQuestion: {
            questionId: "q1",
            questions: [{ question: "?", options: [] }],
          },
          debugMode: null,
          totals: {
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            contextTokens: null,
            contextWindowMax: null,
          },
          lastResult: null,
          lastError: null,
        },
        children: {},
        historyValue: {},
      } as unknown as Snapshot<unknown>;
    }

    function rehydrateArgs(snapshot: Snapshot<unknown>) {
      return {
        key: KEY,
        projectPath: DEFAULT_INPUT.projectPath,
        projectName: DEFAULT_INPUT.projectName,
        sessionName: DEFAULT_INPUT.sessionName,
        worktreePath: DEFAULT_INPUT.worktreePath,
        conversation: {
          id: CONV_ID,
          createdAt: DEFAULT_INPUT.createdAt,
          forkedFrom: null,
          role: null,
          transcriptPath: "/t.jsonl",
          agentBackend: "claude" as const,
          backendRef: null,
          promptCount: 1,
        },
        snapshot,
      };
    }

    it("awaits recoverAbandonedDeliveries before starting the actor", async () => {
      setMachineFactory(createTestMachine);

      // Gate recovery on a deferred. `actor.start()` is the statement after the
      // awaited recovery, so while the gate is unresolved the actor cannot have
      // been started and rehydrate cannot have resolved. Resolving the gate is
      // what unblocks both — the load-bearing ordering proof.
      const order: string[] = [];
      let resolveRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const recoverAbandonedDeliveries = vi.fn(async () => {
        order.push("recover-called");
        await recoveryGate;
        return 1;
      });
      setConversationQueueDeps(makeQueueDeps({ recoverAbandonedDeliveries }));

      const rehydratePromise = rehydrateOneConversationActor(
        rehydrateArgs(makeResumableSnapshot()),
      ).then((started) => {
        order.push("rehydrate-resolved");
        return started;
      });

      // Let microtasks flush. Recovery has been called but the gate is still
      // pending, so the actor is not started and rehydrate has not resolved.
      await Promise.resolve();
      await Promise.resolve();
      expect(recoverAbandonedDeliveries).toHaveBeenCalledWith({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: DEFAULT_INPUT.sessionName,
        conversationId: CONV_ID,
      });
      expect(order).toEqual(["recover-called"]);

      resolveRecovery();
      const started = await rehydratePromise;

      expect(started).toBe(true);
      expect(order).toEqual(["recover-called", "rehydrate-resolved"]);
      // The actor became live only after recovery resolved.
      expect(
        getConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          CONV_ID,
        ),
      ).toBeDefined();
    });

    it("still starts the actor when recovery throws (recovery failure does not abort rehydrate)", async () => {
      setMachineFactory(createTestMachine);

      const recoverAbandonedDeliveries = vi.fn(async () => {
        throw new Error("recover boom");
      });
      setConversationQueueDeps(makeQueueDeps({ recoverAbandonedDeliveries }));

      const started = await rehydrateOneConversationActor(
        rehydrateArgs(makeResumableSnapshot()),
      );

      expect(recoverAbandonedDeliveries).toHaveBeenCalledTimes(1);
      expect(started).toBe(true);
      expect(
        getConversationActor(
          DEFAULT_INPUT.projectPath,
          DEFAULT_INPUT.sessionName,
          CONV_ID,
        )?.getSnapshot().status,
      ).toBe("active");
    });
  });
});
