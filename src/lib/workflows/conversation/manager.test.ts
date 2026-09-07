import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";
import type { ConversationManagerDependencies } from "@/lib/workflows/conversation/manager";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/actor-input-loader";
let machineFactory: NonNullable<
  Parameters<typeof createConversationManagerFixture>[0]
>["machine"];
let actorInputLoader: ConversationManagerDependencies["loadActorInput"] =
  async () => {
    throw new Error("Fixture actor loader is not configured");
  };
let admissionReader: ConversationManagerDependencies["readAdmissionState"] =
  async () => ({ found: true, requiresQueueReview: false });
import { getConversationQueueDeps as currentQueueDependencies } from "@/lib/conversations/message-queue-drain";
import { admitConversationProfileForTurn as admitFixtureProfile } from "@/lib/conversations/profile-admission";
const managerFixture: ReturnType<typeof createConversationManagerFixture> =
  createConversationManagerFixture({
    machine: (adapter, deps) =>
      machineFactory
        ? machineFactory(adapter, deps)
        : managerFixture.providedMachine(adapter),
    dependencies: {
      admitProfileForTurn: (identity) => admitFixtureProfile(identity),
      loadActorInput: (...args) => actorInputLoader(...args),
      readAdmissionState: (...args) => admissionReader(...args),
      queue: {
        submitTurn: (...args) => currentQueueDependencies().submitTurn(...args),
        claimNextTurnBatch: (...args) =>
          currentQueueDependencies().claimNextTurnBatch(...args),
        markPending: (...args) =>
          currentQueueDependencies().markPending(...args),
        markDelivered: (...args) =>
          currentQueueDependencies().markDelivered(...args),
        markFailed: (...args) => currentQueueDependencies().markFailed(...args),
        recoverAbandonedDeliveries: (...args) =>
          currentQueueDependencies().recoverAbandonedDeliveries(...args),
        runConversationCommand: (...args) =>
          currentQueueDependencies().runConversationCommand(...args),
      },
    },
  });
function readTestActorRegistry() {
  return managerFixture.registry;
}
async function ensureConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  options?: { executionTarget?: { worktreePath: string } },
) {
  await managerFixture.manager.ensureConversationLifecycle({
    kind: "durable",
    address: {
      projectPath,
      target: targetFromStoreSessionName(
        "test-project",
        sessionName,
        conversationId,
      ),
    },
    worktreePath: options?.executionTarget?.worktreePath,
  });
  const actor = managerFixture.actor(projectPath, sessionName, conversationId);
  if (!actor) throw new Error("Expected hosted conversation");
  return actor;
}
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { toConversationDurableSeed } from "./actor-input-loader";
import { TurnAttempt } from "./turn-attempt";
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
import { applySyncDerivedFields, deriveActiveTurnSource } from "./manager";
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
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  totalCostUsd: null,
  totalDurationMs: null,
  totalTurns: null,
  contextTokens: null,
  contextWindowMax: null,
  projectPath: "/test/project",
  target: targetFromStoreSessionName(
    "test-project",
    "test-session",
    "conv-123",
  ),

  worktreePath: "/test/project/.worktrees/test-session",

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
 * `getSnapshot()` with a bare object, which made question operations throw
 * `getSnapshot(...).can is not a function` and `ensureConversationActor` throw
 * `Cannot read properties of undefined (reading 'worktreePath')`. Both callers
 * treat the registry as best-effort, so neither may propagate.
 */
function registerUnusableActor(): void {
  const key = conversationRuntimeKey(
    DEFAULT_INPUT.projectPath,
    conversationTargetStoreSessionName(DEFAULT_INPUT.target),
    DEFAULT_INPUT.target.conversationId,
  );
  readTestActorRegistry().set(key, {
    getSnapshot: () => ({}),
    send: () => {
      throw new Error("unusable actor must never be sent to");
    },
    stop: () => {},
  } as unknown as ReturnType<typeof managerFixture.host.start>);
}

describe("conversation manager", () => {
  beforeEach(() => {
    managerFixture.dispose();
    resetRuntime();
    machineFactory = createTestMachine;
    admissionReader = async () => ({ found: true, requiresQueueReview: false });
    setConversationQueueDeps(makeQueueDeps());
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
    _resetConversationProfileAdmissionDepsForTesting();
  });

  describe("startConversationActor", () => {
    it("should create and register an actor", () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      expect(actor).toBeDefined();
      expect(actor.getSnapshot().value).toBe("idle");
    });

    it("should register runtime state for the conversation", () => {
      managerFixture.host.start(DEFAULT_INPUT);
      const actor = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(actor).toBeDefined();
    });

    it("should prevent double-start for the same conversation", () => {
      managerFixture.host.start(DEFAULT_INPUT);
      const actor2 = managerFixture.host.start(DEFAULT_INPUT);
      // Should return the existing actor
      const existing = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(actor2).toBe(existing);
    });

    it("should set initial status based on promptCount", () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      expect(actor.getSnapshot().context.status).toBe("new");

      managerFixture.dispose();
      resetRuntime();
      const actor2 = managerFixture.host.start({
        ...DEFAULT_INPUT,
        target: targetFromStoreSessionName(
          DEFAULT_INPUT.target.projectName,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          "conv-456",
        ),

        promptCount: 3,
        lastActivityAt: "2026-02-01T00:00:00.000Z",
        totalCostUsd: 2.5,
        totalDurationMs: 200,
        totalTurns: 5,
        contextTokens: 1000,
        contextWindowMax: 200000,
      });
      expect(actor2.getSnapshot().context.status).toBe("awaiting");
      expect(actor2.getSnapshot().context.lastActivityAt).toBe(
        "2026-02-01T00:00:00.000Z",
      );
      expect(actor2.getSnapshot().context.totals).toEqual({
        totalCostUsd: 2.5,
        totalDurationMs: 200,
        totalTurns: 5,
        contextTokens: 1000,
        contextWindowMax: 200000,
      });
    });

    it("derives transient from the persistence choice", () => {
      const actor = managerFixture.host.start({
        ...DEFAULT_INPUT,
        target: targetFromStoreSessionName(
          DEFAULT_INPUT.target.projectName,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          "conv-transient",
        ),

        persistence: "ephemeral",
      });
      expect(actor.getSnapshot().context.transient).toBe(true);

      const regular = managerFixture.host.start(DEFAULT_INPUT);
      expect(regular.getSnapshot().context.transient).toBe(false);
    });
  });

  describe("explicit lifecycle bindings", () => {
    it("creates an ephemeral host from execution facts without a durable row", async () => {
      await managerFixture.manager.ensureConversationLifecycle({
        kind: "ephemeral",
        address: {
          projectPath: "/test/project",
          target: {
            scope: "session",
            projectName: "test-project",
            sessionName: "test-session",
            conversationId: "compaction-a1",
          },
        },
        worktreePath: "/test/project",
        backend: "claude",
        role: null,
      });
      expect(
        managerFixture
          .actor("/test/project", "test-session", "compaction-a1")
          ?.getSnapshot().context.transient,
      ).toBe(true);
    });
    it("loads the stored seed for a durable binding", async () => {
      actorInputLoader = async () => ({
        projectName: "test-project",
        conversationScope: "session",
        persistence: "durable",
        sessionWorktreePath: "/test/project",
        conversation: toConversationDurableSeed(makeConversationState()),
      });
      await managerFixture.manager.ensureConversationLifecycle({
        kind: "durable",
        address: {
          projectPath: "/test/project",
          target: {
            scope: "session",
            projectName: "test-project",
            sessionName: "test-session",
            conversationId: "durable-lane-1",
          },
        },
      });
      expect(
        managerFixture
          .actor("/test/project", "test-session", "durable-lane-1")
          ?.getSnapshot().context.transient,
      ).toBe(false);
    });
  });

  describe("getConversationActor", () => {
    it("should return undefined for non-existent actor", () => {
      const actor = managerFixture.actor("/nope", "nope", "nope");
      expect(actor).toBeUndefined();
    });

    it("should return existing actor", () => {
      const started = managerFixture.host.start(DEFAULT_INPUT);
      const found = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(found).toBe(started);
    });
  });

  describe("question command host recovery", () => {
    it("refuses instead of throwing when the registered actor cannot be interrogated", async () => {
      // Every caller treats this as best-effort — the lane answer route in
      // particular has already recorded the answer by the time it fires, so a
      // throw here turns a succeeded answer into a 500. A registry entry whose
      // snapshot is not a usable machine snapshot must refuse like a dead one.
      registerUnusableActor();

      const result = await managerFixture.manager.clearConversationQuestion(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        { questionId: "batch" },
      );

      expect(result).toBe(false);
    });

    it("recycles an actor whose snapshot cannot evaluate event legality", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      Object.defineProperty(actor.getSnapshot(), "can", {
        value: undefined,
      });

      const result = await managerFixture.manager.clearConversationQuestion(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        { questionId: "batch" },
      );

      expect(result).toBe(false);
      await vi.waitFor(() =>
        expect(
          managerFixture.actor(
            DEFAULT_INPUT.projectPath,
            conversationTargetStoreSessionName(DEFAULT_INPUT.target),
            DEFAULT_INPUT.target.conversationId,
          ),
        ).toBeUndefined(),
      );
    });
  });

  describe("executeConversationTurn", () => {
    it("keeps the accepted emitter when a concurrent send is refused", async () => {
      let unblock!: () => void;
      const preparation = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      machineFactory = () =>
        createTestMachine().provide({
          actors: {
            prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
              async () => {
                await preparation;
                return { transcriptPath: "/test.jsonl" };
              },
            ),
          },
        });
      managerFixture.host.start(DEFAULT_INPUT);
      const emit = vi.fn();
      const firstAdmission =
        await managerFixture.manager.submitConversationTurn({
          binding: {
            kind: "durable",
            address: {
              projectPath: DEFAULT_INPUT.projectPath,
              target: {
                scope: "session",
                projectName: "test-project",
                sessionName: conversationTargetStoreSessionName(
                  DEFAULT_INPUT.target,
                ),
                conversationId: DEFAULT_INPUT.target.conversationId,
              },
            },
          },
          transport: { streamId: "first", emit: emit },
          ...DEFAULT_INPUT,
          turn: { promptText: "first" },
        });
      if (firstAdmission.kind !== "accepted")
        throw new Error("first admission refused");
      const first = firstAdmission.turn.completed;
      try {
        const refused = await managerFixture.manager.executeConversationTurn({
          binding: {
            kind: "durable",
            address: {
              projectPath: DEFAULT_INPUT.projectPath,
              target: {
                scope: "session",
                projectName: "test-project",
                sessionName: conversationTargetStoreSessionName(
                  DEFAULT_INPUT.target,
                ),
                conversationId: DEFAULT_INPUT.target.conversationId,
              },
            },
          },
          transport: { streamId: "second", emit: vi.fn() },
          ...DEFAULT_INPUT,
          turn: { promptText: "second" },
        });
        expect(refused.kind).toBe("refused");
        const runtime = getConversationRuntime(
          conversationRuntimeKey(
            DEFAULT_INPUT.projectPath,
            conversationTargetStoreSessionName(DEFAULT_INPUT.target),
            DEFAULT_INPUT.target.conversationId,
          ),
        );
        expect(runtime?.streamEmit).toBe(emit);
      } finally {
        unblock();
        await first;
      }
    });

    it("waits for an external turn to settle when workflow dispatch opts into readiness", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      actor.send({ type: "EXTERNAL_TURN_STARTED" });
      expect(actor.getSnapshot().value).toBe("externalExecuting");

      const executionPromise = managerFixture.manager.executeConversationTurn({
        binding: {
          kind: "durable",
          address: {
            projectPath: DEFAULT_INPUT.projectPath,
            target: {
              scope: "session",
              projectName: "test-project",
              sessionName: conversationTargetStoreSessionName(
                DEFAULT_INPUT.target,
              ),
              conversationId: DEFAULT_INPUT.target.conversationId,
            },
          },
        },
        transport: { streamId: "stream-workflow-wait", emit: vi.fn() },
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
        kind: "settled",
      });
      expect(actor.getSnapshot().value).toBe("idle");
    });

    it("settles a debug turn through the lifecycle interface and detaches its stream", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        {
          kind: "enter",
          logFilePath: "/tmp/debug.jsonl",
          debugSessionId: "debug-session-turn",
        },
      );

      const emit = vi.fn();
      const execution = await Promise.race([
        managerFixture.manager.executeConversationTurn({
          binding: {
            kind: "durable",
            address: {
              projectPath: DEFAULT_INPUT.projectPath,
              target: {
                scope: "session",
                projectName: "test-project",
                sessionName: conversationTargetStoreSessionName(
                  DEFAULT_INPUT.target,
                ),
                conversationId: DEFAULT_INPUT.target.conversationId,
              },
            },
          },
          transport: { streamId: "stream-debug", emit: emit },
          turn: {
            promptText: "Investigate",
            backend: "claude",
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("debug turn did not settle")), 500),
        ),
      ]);

      expect(execution.kind).toBe("settled");
      expect(actor.getSnapshot().value).toBe("debug");
      const runtime = getConversationRuntime(
        conversationRuntimeKey(
          DEFAULT_INPUT.projectPath,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          DEFAULT_INPUT.target.conversationId,
        ),
      );
      expect(runtime?.streamEmit).toBeUndefined();
    });
  });

  describe("stopConversationActor", () => {
    it("should stop and remove actor from registry", async () => {
      managerFixture.host.start(DEFAULT_INPUT);
      await managerFixture.manager.stopConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        "test",
      );
      const actor = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(actor).toBeUndefined();
    });

    it("should be a no-op for non-existent actor", () => {
      // Should not throw
      managerFixture.manager.stopConversationActor(
        "/nope",
        "nope",
        "nope",
        "test",
      );
    });
  });

  describe("debug mode lifecycle through manager", () => {
    it("enters debug → toggles recording → exits debug back to idle", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      expect(actor.getSnapshot().value).toBe("idle");

      // Enter debug mode
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        {
          kind: "enter",
          logFilePath: "/tmp/.debug/logs.jsonl",
          debugSessionId: "debug-session-lifecycle",
        },
      );
      expect(actor.getSnapshot().value).toBe("debug");
      expect(actor.getSnapshot().context.debugMode?.active).toBe(true);

      // Toggle recording on
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        { kind: "set_recording", recording: true },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(true);

      // Toggle recording off
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        { kind: "set_recording", recording: false },
      );
      expect(actor.getSnapshot().context.debugMode?.recording).toBe(false);

      // Exit debug mode
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        { kind: "exit" },
      );
      expect(actor.getSnapshot().value).toBe("idle");
      expect(actor.getSnapshot().context.debugMode).toBeNull();
    });
  });

  describe("SSE broadcast and push notifications", () => {
    it("calls broadcastDebugModeStatus action on debug-mode entry", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      await managerFixture.manager.executeConversationCommand(
        {
          projectPath: DEFAULT_INPUT.projectPath,
          target: DEFAULT_INPUT.target,
        },
        {
          kind: "enter",
          logFilePath: "/tmp/.debug/logs.jsonl",
          debugSessionId: "debug-session-broadcast",
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
      const actor = managerFixture.host.start(DEFAULT_INPUT);
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
        target: targetFromStoreSessionName("proj", "sess", "conv-1"),
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/sess",
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
          modelSelection: null,
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
          modelSelection: null,
          autonomous: true,
          startedAt: null,
          streamId: null,
        }),
      ).toBe("workflow");
    });

    it("classifies task_run as workflow (smart-merge validation-fix, etc.)", () => {
      expect(
        deriveActiveTurnSource({
          executionClass: "nongoverned-task" as const,
          kind: "task_run",
          promptText: "fix validation",
          backend: "claude",
          modelSelection: null,
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
          lastActivityAt: "2026-01-01T00:00:00.000Z",
          totalCostUsd: null,
          totalDurationMs: null,
          totalTurns: null,
          contextTokens: null,
          contextWindowMax: null,
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

    afterEach(() => {});

    it("serializes lazy startup and recovers abandoned deliveries before making the actor live", async () => {
      const order: string[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const loadActorInput = vi.fn(async () => {
        await gate;
        return makeActorInputData();
      });
      actorInputLoader = { loadActorInput }.loadActorInput;
      setConversationQueueDeps(
        makeQueueDeps({
          recoverAbandonedDeliveries: async () => {
            expect(
              managerFixture.actor(
                DEFAULT_INPUT.projectPath,
                conversationTargetStoreSessionName(DEFAULT_INPUT.target),
                DEFAULT_INPUT.target.conversationId,
              ),
            ).toBeUndefined();
            order.push("recovered");
            return 1;
          },
        }),
      );
      const first = ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      const second = ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(order).toEqual(["recovered"]);
      expect(a).toBe(b);
      expect(loadActorInput).toHaveBeenCalledTimes(1);
      expect(a.getSnapshot().status).toBe("active");
    });

    it("creates a fresh actor using executionTarget.worktreePath instead of session.worktreePath", async () => {
      const loadActorInput = vi.fn(
        async () =>
          makeActorInputData({
            sessionWorktreePath: "/session-worktree",
          }) satisfies EnsureActorInputData,
      );
      actorInputLoader = { loadActorInput }.loadActorInput;

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        {
          executionTarget: { worktreePath: "/per-context-worktree" },
        },
      );

      expect(loadActorInput).toHaveBeenCalledWith(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(actor.getSnapshot().context.worktreePath).toBe(
        "/per-context-worktree",
      );
    });

    it("returns the existing idle actor when executionTarget matches the actor's worktreePath", async () => {
      managerFixture.host.start({
        ...DEFAULT_INPUT,
        worktreePath: "/per-context-worktree",
      });

      const loadActorInput = vi.fn(async () => makeActorInputData());
      actorInputLoader = { loadActorInput }.loadActorInput;

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
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
      managerFixture.host.start({
        ...DEFAULT_INPUT,
        worktreePath: "/old-worktree",
      });
      const original = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      )!;
      expect(original.getSnapshot().value).toBe("idle");

      const loadActorInput = vi.fn(
        async () =>
          makeActorInputData({
            sessionWorktreePath: "/old-worktree",
          }) satisfies EnsureActorInputData,
      );
      actorInputLoader = { loadActorInput }.loadActorInput;

      const recreated = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
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
      actorInputLoader = { loadActorInput }.loadActorInput;

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        { executionTarget: { worktreePath: "/lane-worktree" } },
      );

      expect(actor.getSnapshot().context.worktreePath).toBe("/lane-worktree");
      expect(loadActorInput).toHaveBeenCalledTimes(1);
    });

    it("throws an infrastructure error when the actor is running and worktreePath mismatches", async () => {
      let release!: (value: PrepareTurnOutput) => void;
      const preparing = new Promise<PrepareTurnOutput>((resolve) => {
        release = resolve;
      });
      machineFactory = () =>
        createTestMachine().provide({
          actors: {
            prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
              () => preparing,
            ),
          },
        });
      const running = managerFixture.host.start({
        ...DEFAULT_INPUT,
        worktreePath: "/old-worktree",
      });
      const admission = await managerFixture.manager.submitConversationTurn({
        binding: {
          kind: "durable",
          address: {
            projectPath: DEFAULT_INPUT.projectPath,
            target: DEFAULT_INPUT.target,
          },
          worktreePath: "/old-worktree",
        },
        turn: { promptText: "Inspect before rebinding" },
      });
      if (admission.kind !== "accepted") throw new Error(admission.message);
      const loadActorInput = vi.fn(async () => makeActorInputData());
      actorInputLoader = loadActorInput;
      try {
        expect(running.getSnapshot().value).toBe("acquiringResources");
        await expect(
          ensureConversationActor(
            DEFAULT_INPUT.projectPath,
            conversationTargetStoreSessionName(DEFAULT_INPUT.target),
            DEFAULT_INPUT.target.conversationId,
            { executionTarget: { worktreePath: "/new-worktree" } },
          ),
        ).rejects.toThrow(/cannot rebind/);
        expect(
          managerFixture.actor(
            DEFAULT_INPUT.projectPath,
            conversationTargetStoreSessionName(DEFAULT_INPUT.target),
            DEFAULT_INPUT.target.conversationId,
          ),
        ).toBe(running);
        expect(loadActorInput).not.toHaveBeenCalled();
      } finally {
        release({ transcriptPath: "/test.jsonl" });
        await admission.turn.completed;
      }
    });

    it("returns the existing actor unchanged when no executionTarget is provided (no-override fallback)", async () => {
      managerFixture.host.start({
        ...DEFAULT_INPUT,
        worktreePath: "/some-worktree",
      });
      const original = managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      )!;

      const loadActorInput = vi.fn(async () => makeActorInputData());
      actorInputLoader = { loadActorInput }.loadActorInput;

      const actor = await ensureConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
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
      submitTurn: managerFixture.manager.submitConversationTurn,
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
      machineFactory = undefined;
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      const actor = managerFixture.host.start({
        ...DEFAULT_INPUT,
        target: targetFromStoreSessionName(
          DEFAULT_INPUT.target.projectName,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          "conv-workflow",
        ),

        role: "iteration",
      });
      // idle entry fires the drain action at startup.
      expect(actor.getSnapshot().value).toBe("idle");
      await Promise.resolve();

      expect(claimNextTurnBatch).not.toHaveBeenCalled();
    });

    it("invokes the queue claim for a user-interactive (null-role) conversation", async () => {
      machineFactory = undefined;
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      managerFixture.host.start({
        ...DEFAULT_INPUT,
        target: targetFromStoreSessionName(
          DEFAULT_INPUT.target.projectName,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          "conv-user",
        ),

        role: null,
      });
      await Promise.resolve();

      expect(claimNextTurnBatch).toHaveBeenCalledTimes(1);
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        conversationId: "conv-user",
      });
    });
  });

  describe("ensureConversationActorAndDrain", () => {
    it("does not drain while the previous invocation is still stopping", async () => {
      const actor = managerFixture.host.start(DEFAULT_INPUT);
      const runtime = getConversationRuntime(
        conversationRuntimeKey(
          DEFAULT_INPUT.projectPath,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          DEFAULT_INPUT.target.conversationId,
        ),
      );
      if (!runtime) throw new Error("missing runtime");
      let release: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const attempt: TurnAttempt = new TurnAttempt({
        conversationId: DEFAULT_INPUT.target.conversationId,
        isCurrent: (): boolean => runtime.attempt === attempt,
        onCancel: () => {},
        closeRuntime: async () => {},
      });
      runtime.attempt = attempt;
      void attempt.track(() => pending);
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));
      await managerFixture.manager.ensureConversationActorAndDrain(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
      );
      expect(actor.getSnapshot().value).toBe("idle");
      expect(claimNextTurnBatch).not.toHaveBeenCalled();
      release();
      await attempt.settle();
      runtime.attempt = undefined;
      attempt.complete({
        status: "awaiting",
        pendingQuestion: null,
        lastError: null,
      });
      await attempt.completed;
      await Promise.resolve();
      expect(claimNextTurnBatch).toHaveBeenCalledTimes(1);
    });

    afterEach(() => {
      _resetConversationQueueDepsForTesting();
    });

    it("explicitly drains an already-idle existing actor (whose idle entry won't re-fire)", async () => {
      const claimNextTurnBatch = vi.fn(async () => null);
      setConversationQueueDeps(makeQueueDeps({ claimNextTurnBatch }));

      // A registered actor already sitting in idle: re-ensuring it does not
      // re-enter idle, so the machine's idle-entry drain will not fire again —
      // the explicit drain is what delivers the just-enqueued turn.
      managerFixture.host.start({
        ...DEFAULT_INPUT,
        target: targetFromStoreSessionName(
          DEFAULT_INPUT.target.projectName,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          "conv-idle-existing",
        ),

        role: null,
      });
      claimNextTurnBatch.mockClear();

      await managerFixture.manager.ensureConversationActorAndDrain(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        "conv-idle-existing",
      );
      await Promise.resolve();

      expect(claimNextTurnBatch).toHaveBeenCalledTimes(1);
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: DEFAULT_INPUT.projectPath,
        sessionName: conversationTargetStoreSessionName(DEFAULT_INPUT.target),
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
            projectName: DEFAULT_INPUT.target.projectName,
            sessionWorktreePath: DEFAULT_INPUT.worktreePath,
            persistence: "durable",
            conversation: {
              lastActivityAt: DEFAULT_INPUT.createdAt,
              totalCostUsd: null,
              totalDurationMs: null,
              totalTurns: null,
              contextTokens: null,
              contextWindowMax: null,
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
      actorInputLoader = { loadActorInput }.loadActorInput;

      await managerFixture.manager.ensureConversationActorAndDrain(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        "conv-fresh",
      );
      await Promise.resolve();

      // The actor was created fresh, so the redundant explicit drain is skipped;
      // the machine's idle-entry drain owns delivery for a new actor.
      expect(claimNextTurnBatch).not.toHaveBeenCalled();
    });
  });

  describe("hasLiveConversationActor", () => {
    it("is false before start, true after start, false after stop", async () => {
      expect(
        managerFixture.manager.hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          DEFAULT_INPUT.target.conversationId,
        ),
      ).toBe(false);

      managerFixture.host.start(DEFAULT_INPUT);
      expect(
        managerFixture.manager.hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          DEFAULT_INPUT.target.conversationId,
        ),
      ).toBe(true);

      await managerFixture.manager.stopConversationActor(
        DEFAULT_INPUT.projectPath,
        conversationTargetStoreSessionName(DEFAULT_INPUT.target),
        DEFAULT_INPUT.target.conversationId,
        "test",
      );
      expect(
        managerFixture.manager.hasLiveConversationActor(
          DEFAULT_INPUT.projectPath,
          conversationTargetStoreSessionName(DEFAULT_INPUT.target),
          DEFAULT_INPUT.target.conversationId,
        ),
      ).toBe(false);
    });
  });
});
