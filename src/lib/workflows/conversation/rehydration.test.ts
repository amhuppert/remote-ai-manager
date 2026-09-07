import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";

let machineFactory: NonNullable<
  Parameters<typeof createConversationManagerFixture>[0]
>["machine"];
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

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  collectRehydrationCandidates,
  rehydrateConversationActors,
  rehydrateOneConversationActor,
  shouldRehydrateSnapshot,
  type RehydrateConversationActorsDeps,
} from "./rehydration";

import {
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
  type ConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import { _resetForTesting as resetRuntime } from "./runtime-state";
import { conversationMachine } from "./machine";
import { validateRestoredSnapshot } from "./persistence";
import type {
  ConversationInput,
  ExecutePromptInput,
  PrepareTurnInput,
  PrepareTurnOutput,
  PromptActorResult,
} from "./types";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  createCapturingLogger,
  type CapturingLogger,
} from "@/lib/shared/testing/capturing-logger";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { readAllForStartupFromDb } from "@/lib/state-store/startup-reader";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { managerStateSchema, type ManagerState } from "@/lib/projects/schemas";
import {
  createActor,
  fromPromise,
  type AnyActorRef,
  type Snapshot,
} from "xstate";

const ts = "2025-01-01T00:00:00.000Z";

/**
 * Build a Snapshot-typed value from parts without unchecked casts: the
 * Snapshot union's own discriminant fields are written explicitly, and the
 * machine-level fields (`value`, `context`) the rehydration policy reads
 * arrive via spread, which the union admits as structural extras.
 */
function fakeSnapshot(parts: {
  status: Snapshot<unknown>["status"];
  value?: unknown;
  context?: { pendingQuestion?: unknown };
}): Snapshot<unknown> {
  const machineParts = { value: parts.value, context: parts.context };
  return {
    status: parts.status,
    output: undefined,
    error: undefined,
    ...machineParts,
  };
}

function conv(
  overrides: Partial<ConversationState> & { id: string },
): ConversationState {
  return makeConversationState({
    status: "awaiting",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    ...overrides,
  });
}

function stateWith(conversations: ConversationState[]): ManagerState {
  const session = sessionStateSchema.parse({
    sessionName: "feat",
    worktreePath: "/repo/.worktrees/feat",
    branchName: "csm/feat",
    createdAt: ts,
    lastActivityAt: ts,
    conversations,
  });
  return managerStateSchema.parse({
    projects: { "/repo": { rootPath: "/repo", sessions: { feat: session } } },
    archivedProjects: [],
    pinnedProjects: [],
  });
}

const emptyState = (): ManagerState =>
  managerStateSchema.parse({
    projects: {},
    archivedProjects: [],
    pinnedProjects: [],
  });

afterEach(() => {
  managerFixture.dispose();
  resetRuntime();

  _resetConversationQueueDepsForTesting();
});

describe("collectRehydrationCandidates", () => {
  it.each(["session", "project"] as const)(
    "recovers an ordinary %s queue even without a resumable snapshot",
    async (scope) => {
      const fixture = createPersistenceFixture();
      const projectPath = "/queue-startup";
      const sessionName =
        scope === "project" ? PROJECT_CONVERSATION_SESSION_SENTINEL : "session";
      const conversationId = `queued-${scope}`;
      const key = { projectPath, sessionName, conversationId };
      try {
        fixture.seedProject(projectPath);
        const conversation = makeConversationState({
          id: conversationId,
          scope,
          agentBackend: "cursor",
          status: "running",
          activeTurnSource: "user",
          totalCostUsd: 0.42,
        });
        if (scope === "project")
          await fixture.seedProjectConversation(projectPath, conversation);
        else {
          fixture.seedSession(projectPath, sessionName);
          await fixture.seedConversation(
            projectPath,
            sessionName,
            conversation,
          );
        }
        const queue = createMessageQueueService({
          ...fixture.deps,
          getProjectDisplayName: () => "queue-startup",
          broadcast: () => {},
          now: () => ts,
          newId: () => crypto.randomUUID(),
        });
        await queue.enqueue({
          ...key,
          content: [{ type: "text", text: "in flight at crash" }],
        });
        await queue.claimNextTurnBatch(key);
        await queue.enqueue({
          ...key,
          content: [{ type: "text", text: "later" }],
        });
        setConversationQueueDeps({
          submitTurn: managerFixture.manager.submitConversationTurn,
          ...queue,
          runConversationCommand: async () => {
            throw new Error("not a command");
          },
        });
        machineFactory = createTestMachine;
        const count = await rehydrateConversationActors({
          ...rehydrationInfrastructure(),
          mutateConversation: fixture.store.mutateConversation,
          readAllForStartup: () => readAllForStartupFromDb(fixture.db),
          listAllProjectConversations:
            fixture.store.listAllProjectConversations,
          getProjectDisplayName: () => "queue-startup",
          getConversationMachineSnapshot: () =>
            scope === "project" ? { interrupted: true } : null,
          validateRestoredSnapshot: () =>
            fakeSnapshot({ status: "active", value: "executing", context: {} }),
        });
        expect(count).toBe(1);
        expect(
          managerFixture
            .actor(projectPath, sessionName, conversationId)
            ?.getSnapshot().value,
        ).toBe("idle");
        const reloaded = await fixture
          .recreateStore()
          .getConversation(projectPath, sessionName, conversationId);
        expect(reloaded?.pendingQueue.map((row) => row.status)).toEqual([
          "uncertain",
          "pending",
        ]);
        expect(reloaded?.status).toBe("awaiting");
        expect(reloaded?.activeTurnSource).toBeNull();
        expect(reloaded?.totalCostUsd).toBe(0.42);
        expect(await queue.claimNextTurnBatch(key)).toBeNull();
      } finally {
        managerFixture.dispose();
        fixture.close();
      }
    },
  );
  it("flattens session and project conversations with the right keying", () => {
    const state = stateWith([conv({ id: "s1" })]);
    const candidates = collectRehydrationCandidates(state, [
      {
        projectPath: "/repo",
        conversation: conv({ id: "p1", scope: "project" }),
      },
    ]);

    const session = candidates.find((c) => c.conversation.id === "s1");
    expect(session?.storeSessionName).toBe("feat");
    expect(session?.worktreePath).toBe("/repo/.worktrees/feat");

    const project = candidates.find((c) => c.conversation.id === "p1");
    expect(project?.storeSessionName).toBe(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(project?.worktreePath).toBe("/repo");
    expect(project?.projectPath).toBe("/repo");
  });
});

describe("rehydrateConversationActors (project conversations)", () => {
  function makeDeps(
    projectConvs: { projectPath: string; conversation: ConversationState }[],
    validate: RehydrateConversationActorsDeps["validateRestoredSnapshot"],
    snapshots: Record<string, unknown> = {},
  ): RehydrateConversationActorsDeps {
    return {
      ...rehydrationInfrastructure(),
      readAllForStartup: () => emptyState(),
      listAllProjectConversations: async () => projectConvs,
      getProjectDisplayName: () => "demo",
      getConversationMachineSnapshot: (owner, conversationId) => {
        // Project conversations own their sidecar rows under the `project`
        // discriminator; assert the rehydrator routes them there.
        expect(owner).toBe("project");
        return snapshots[conversationId] ?? null;
      },
      validateRestoredSnapshot: validate,
    };
  }

  it("walks a project conversation's sidecar snapshot via the injected validator", async () => {
    const projConv = conv({ id: "p1", scope: "project" });
    const validate = vi.fn(() => null); // treat as invalid → no actor
    const count = await rehydrateConversationActors(
      makeDeps([{ projectPath: "/repo", conversation: projConv }], validate, {
        p1: { marker: "p1-snapshot" },
      }),
    );
    expect(count).toBe(0);
    expect(validate).toHaveBeenCalledWith({ marker: "p1-snapshot" }, "p1", 1);
  });

  it("skips a non-resumable project snapshot (active without a pending question)", async () => {
    const projConv = conv({ id: "p1", scope: "project" });
    const nonResumable = fakeSnapshot({
      status: "active",
      value: "running",
      context: {},
    });
    const count = await rehydrateConversationActors(
      makeDeps(
        [{ projectPath: "/repo", conversation: projConv }],
        () => nonResumable,
        { p1: { x: 1 } },
      ),
    );
    expect(count).toBe(0);
  });

  it("does not validate a project conversation with no persisted sidecar snapshot", async () => {
    const projConv = conv({ id: "p1", scope: "project" });
    const validate = vi.fn(() => null);
    const count = await rehydrateConversationActors(
      // No sidecar snapshot registered for p1.
      makeDeps([{ projectPath: "/repo", conversation: projConv }], validate),
    );
    expect(count).toBe(0);
    expect(validate).not.toHaveBeenCalled();
  });
});

describe("workflow-result post-commit reconciliation", () => {
  it("replays pending effects for a session even when it has no conversation actors", async () => {
    const reconcileWorkflowResultEffects = vi.fn(async () => 1);

    const count = await rehydrateConversationActors({
      ...rehydrationInfrastructure(),
      readAllForStartup: () => stateWith([]),
      listAllProjectConversations: async () => [],
      getProjectDisplayName: () => "demo",
      getConversationMachineSnapshot: () => null,
      validateRestoredSnapshot: () => null,
      reconcileWorkflowResultEffects,
    });

    expect(count).toBe(0);
    expect(reconcileWorkflowResultEffects).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      "feat",
    );
  });

  it("recovers abandoned claims for a session with no remaining conversations", async () => {
    const recoverWorkflowResultClaims = vi.fn(async () => 1);

    const count = await rehydrateConversationActors({
      ...rehydrationInfrastructure(),
      readAllForStartup: () => stateWith([]),
      listAllProjectConversations: async () => [],
      getProjectDisplayName: () => "demo",
      getConversationMachineSnapshot: () => null,
      validateRestoredSnapshot: () => null,
      recoverWorkflowResultClaims,
    });

    expect(count).toBe(0);
    expect(recoverWorkflowResultClaims).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      "feat",
    );
  });
});

describe("waitingForInput rehydration contract", () => {
  // The turn must stay open until ASK_QUESTION lands, so executePrompt
  // resolves only when the test releases it.
  let releaseTurn: (() => void) | null = null;

  const stubbedMachine = () =>
    conversationMachine.provide({
      actors: {
        prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
          async () => ({ transcriptPath: "/tmp/t.jsonl" }),
        ),
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          () =>
            new Promise((resolve) => {
              releaseTurn = () => resolve(promptResult());
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
        markUnreadOnFinish: () => {},
        markReadOnUserTurnStart: () => {},
        drainPendingQueue: () => {},
      },
    });

  function promptResult(): PromptActorResult {
    return {
      backendRef: null,
      costUsd: null,
      durationMs: null,
      numTurns: 1,
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
      structuredOutput: undefined,
    };
  }

  const actorInput: ConversationInput = {
    lastActivityAt: ts,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    contextTokens: null,
    contextWindowMax: null,
    projectPath: "/repo",
    target: targetFromStoreSessionName("demo", "feat", "c-wfi"),

    worktreePath: "/repo/.worktrees/feat",

    createdAt: ts,
    forkedFrom: null,
    role: null,
    transcriptPath: null,
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    persistence: "durable",
  };

  const claimNextTurnBatch = vi.fn(async () => null);
  const noopQueueDeps: ConversationQueueDeps = {
    submitTurn: managerFixture.manager.submitConversationTurn,
    claimNextTurnBatch,
    markPending: async () => {},
    markDelivered: async () => {},
    markFailed: async () => {},
    recoverAbandonedDeliveries: async () => 0,
    runConversationCommand: async () => {
      throw new Error("not used");
    },
  };

  /** Drive a throwaway actor into waitingForInput and capture its persisted
   *  snapshot — the exact payload persistSnapshot would have written. */
  async function captureWaitingForInputSnapshot(): Promise<unknown> {
    const actor = createActor(stubbedMachine(), { input: actorInput });
    actor.start();
    actor.send({ type: "SUBMIT_PROMPT", promptText: "hi", streamId: "s1" });
    await waitForValue(actor, (v) => JSON.stringify(v).includes("executing"));
    await new Promise((r) => setTimeout(r, 10));
    actor.send({ type: "ASK_QUESTION", questionId: "q-9", questions: [] });
    releaseTurn!();
    await waitForValue(actor, (v) => v === "waitingForInput");
    const persisted = actor.getPersistedSnapshot();
    actor.stop();
    return persisted;
  }

  function waitForValue(
    actor: AnyActorRef,
    predicate: (value: unknown) => boolean,
    timeoutMs = 3000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out; current: ${JSON.stringify(actor.getSnapshot().value)}`,
            ),
          ),
        timeoutMs,
      );
      if (predicate(actor.getSnapshot().value)) {
        clearTimeout(timer);
        resolve();
        return;
      }
      const sub = actor.subscribe((s) => {
        if (predicate(s.value)) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve();
        }
      });
    });
  }

  it("a conversation persisted in waitingForInput wakes in waitingForInput after restart", async () => {
    const persisted = await captureWaitingForInputSnapshot();
    machineFactory = stubbedMachine;
    setConversationQueueDeps(noopQueueDeps);

    const conversation = conv({
      id: "c-wfi",
      status: "waiting_for_input",
    });
    const deps: RehydrateConversationActorsDeps = {
      ...rehydrationInfrastructure(),
      readAllForStartup: () => stateWith([conversation]),
      listAllProjectConversations: async () => [],
      getProjectDisplayName: () => "demo",
      getConversationMachineSnapshot: (owner, conversationId) => {
        expect(owner).toBe("session");
        return conversationId === "c-wfi" ? persisted : null;
      },
      validateRestoredSnapshot: (raw) => raw as Snapshot<unknown>,
    };

    const count = await rehydrateConversationActors(deps);
    expect(count).toBe(1);

    const actor = managerFixture.actor("/repo", "feat", "c-wfi");
    expect(actor).toBeDefined();
    const snap = actor!.getSnapshot();
    expect(snap.value).toBe("waitingForInput");
    expect(snap.context.pendingQuestion).toEqual({
      questionId: "q-9",
      questions: [],
    });
    // The woken actor accepts the answer/supersede turn claim.
    expect(
      snap.can({ type: "SUBMIT_PROMPT", promptText: "answer", streamId: "s2" }),
    ).toBe(true);

    // Restored actors never re-fire entry drains; the rehydrator must drain
    // explicitly so rows enqueued before the restart deliver.
    await vi.waitFor(() => {
      expect(claimNextTurnBatch).toHaveBeenCalledWith({
        projectPath: "/repo",
        sessionName: "feat",
        conversationId: "c-wfi",
      });
    });
  });

  it("a legacy-shape snapshot rehydrates with a canonical backendRef in the actor context", async () => {
    const persisted = await captureWaitingForInputSnapshot();
    // Shape the snapshot the way a pre-migration build persisted it: a
    // discriminated legacy ref in the machine context.
    (persisted as { context: { backendRef: unknown } }).context.backendRef = {
      backend: "claude",
      sessionId: "sess-legacy-snap",
    };
    machineFactory = stubbedMachine;
    setConversationQueueDeps(noopQueueDeps);

    const conversation = conv({
      id: "c-wfi",
      status: "waiting_for_input",
    });
    const deps: RehydrateConversationActorsDeps = {
      ...rehydrationInfrastructure(),
      readAllForStartup: () => stateWith([conversation]),
      listAllProjectConversations: async () => [],
      getProjectDisplayName: () => "demo",
      getConversationMachineSnapshot: (_owner, conversationId) =>
        conversationId === "c-wfi" ? persisted : null,
      validateRestoredSnapshot,
    };

    const count = await rehydrateConversationActors(deps);
    expect(count).toBe(1);

    const actor = managerFixture.actor("/repo", "feat", "c-wfi");
    expect(actor).toBeDefined();
    expect(actor!.getSnapshot().context.backendRef).toEqual({
      backend: "claude",
      ref: "sess-legacy-snap",
    });
  });

  it("restores a runtime through the real startup reader + sidecar (persistence fixture)", async () => {
    // End-to-end over a real SQLite database: seed a session conversation and
    // its resume-token snapshot in the sidecar table, then rehydrate through the
    // production `readAllForStartup` (which enumerates the seeded tree without
    // loading the snapshot column) and the production sidecar read. Proves the
    // startup reader + on-demand sidecar path restores runtimes correctly.
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject("/repo");
      fixture.seedSession("/repo", "feat");
      await fixture.seedConversation(
        "/repo",
        "feat",
        conv({
          id: "c-db",
          status: "waiting_for_input",
          promptCount: 8,
          totalCostUsd: 4.5,
          totalDurationMs: 9000,
          totalTurns: 17,
          contextTokens: 1200,
          contextWindowMax: 200000,
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        }),
      );
      const persisted = await captureWaitingForInputSnapshot();
      await fixture.store.upsertConversationMachineSnapshot(
        "session",
        "c-db",
        persisted,
      );

      machineFactory = stubbedMachine;
      setConversationQueueDeps(noopQueueDeps);

      const count = await rehydrateConversationActors({
        ...rehydrationInfrastructure(),
        readAllForStartup: () => readAllForStartupFromDb(fixture.db),
        listAllProjectConversations: fixture.store.listAllProjectConversations,
        getProjectDisplayName: () => "demo",
        getConversationMachineSnapshot:
          fixture.store.getConversationMachineSnapshot,
        validateRestoredSnapshot: (raw) => raw as Snapshot<unknown>,
      });

      expect(count).toBe(1);
      const actor = managerFixture.actor("/repo", "feat", "c-db");
      expect(actor).toBeDefined();
      expect(actor!.getSnapshot().context.totals).toEqual({
        totalCostUsd: 4.5,
        totalDurationMs: 9000,
        totalTurns: 17,
        contextTokens: 1200,
        contextWindowMax: 200000,
      });
      expect(actor!.getSnapshot().context.promptCount).toBe(8);
      expect(actor!.getSnapshot().context.lastActivityAt).toBe(
        "2026-02-01T00:00:00.000Z",
      );
      expect(actor!.getSnapshot().value).toBe("waitingForInput");
    } finally {
      fixture.close();
    }
  });
});

describe("shouldRehydrateSnapshot", () => {
  it("rehydrates active snapshots with a pending question", () => {
    expect(
      shouldRehydrateSnapshot(
        fakeSnapshot({
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
        fakeSnapshot({
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
        fakeSnapshot({
          status: "active",
          value: "idle",
          context: { pendingQuestion: null },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRehydrateSnapshot(
        fakeSnapshot({
          status: "active",
          value: { executing: "running" },
          context: { pendingQuestion: null },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRehydrateSnapshot(
        fakeSnapshot({
          status: "active",
          value: "acquiringResources",
          context: {},
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rehydrateOneConversationActor startup recovery
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = {
  projectPath: "/test/project",
  projectName: "test-project",
  sessionName: "test-session",
  worktreePath: "/test/project/.worktrees/test-session",
  createdAt: "2026-01-01T00:00:00.000Z",
};

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

describe("rehydrateOneConversationActor startup recovery", () => {
  const CONV_ID = "conv-rehydrate";
  const KEY = `${DEFAULT_INPUT.projectPath}::${DEFAULT_INPUT.sessionName}::${CONV_ID}`;

  // A restorable snapshot produced by a real actor of the same machine the
  // rehydrator restores onto: active, settled in `idle` with the machine's
  // genuine persisted shape. `idle` resolves cleanly without re-invoking the
  // executePrompt actor, and the recovery-ordering contract under test is
  // independent of which resumable state the snapshot captured.
  function makeResumableSnapshot(): Snapshot<unknown> {
    const input: ConversationInput = {
      lastActivityAt: DEFAULT_INPUT.createdAt,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: DEFAULT_INPUT.projectPath,
      target: targetFromStoreSessionName(
        DEFAULT_INPUT.projectName,
        DEFAULT_INPUT.sessionName,
        CONV_ID,
      ),

      worktreePath: DEFAULT_INPUT.worktreePath,

      createdAt: DEFAULT_INPUT.createdAt,
      forkedFrom: null,
      role: null,
      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 1,
      persistence: "durable",
    };
    const actor = createActor(createTestMachine(), { input });
    actor.start();
    const snapshot = actor.getPersistedSnapshot();
    actor.stop();
    return snapshot;
  }

  function rehydrateArgs(snapshot: Snapshot<unknown>) {
    return {
      key: KEY,
      projectPath: DEFAULT_INPUT.projectPath,
      projectName: DEFAULT_INPUT.projectName,
      storeSessionName: DEFAULT_INPUT.sessionName,
      worktreePath: DEFAULT_INPUT.worktreePath,
      conversation: {
        lastActivityAt: DEFAULT_INPUT.createdAt,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        id: CONV_ID,
        createdAt: DEFAULT_INPUT.createdAt,
        forkedFrom: null,
        role: null,
        transcriptPath: "/t.jsonl",
        agentBackend: "claude" as const,
        backendRef: null,
        promptCount: 1,
        debugMode: null,
      },
      snapshot,
    };
  }

  it("awaits recoverAbandonedDeliveries before starting the actor", async () => {
    machineFactory = createTestMachine;

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
      rehydrationInfrastructure(),
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
      managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        CONV_ID,
      ),
    ).toBeDefined();
  });

  it("does not start an actor when durable recovery fails", async () => {
    machineFactory = createTestMachine;

    const recoverAbandonedDeliveries = vi.fn(async () => {
      throw new Error("recover boom");
    });
    setConversationQueueDeps(makeQueueDeps({ recoverAbandonedDeliveries }));

    const started = await rehydrateOneConversationActor(
      rehydrateArgs(makeResumableSnapshot()),
      rehydrationInfrastructure(),
    );

    expect(recoverAbandonedDeliveries).toHaveBeenCalledTimes(1);
    expect(started).toBe(false);
    expect(
      managerFixture.actor(
        DEFAULT_INPUT.projectPath,
        DEFAULT_INPUT.sessionName,
        CONV_ID,
      ),
    ).toBeUndefined();
  });

  it("resets abandoned workflow-result claims through a restarted store before actor selection", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject("/repo");
      fixture.seedSession("/repo", "feat");
      const deliveries = createGraphWorkflowResultDeliveriesRepo(fixture.db);
      deliveries.record({
        executionId: "exec-restart",
        boundarySeq: 7,
        projectPath: "/repo",
        sessionName: "feat",
        originConversationId: CONV_ID,
        payload: { status: "completed" },
        recordedAt: "2026-08-14T12:00:00.000Z",
        state: "pending",
        attemptId: null,
        attemptCount: 0,
        deliveredAt: null,
        effectsDeliveredAt: null,
      });
      deliveries.markDelivering(
        "/repo",
        "feat",
        "exec-restart",
        7,
        "abandoned-attempt",
      );
      const restartedStore = fixture.recreateStore();

      await rehydrateConversationActors({
        ...rehydrationInfrastructure(),
        readAllForStartup: () => stateWith([conv({ id: CONV_ID })]),
        listAllProjectConversations: async () => [],
        getProjectDisplayName: () => "demo",
        getConversationMachineSnapshot: () => null,
        validateRestoredSnapshot: () => null,
        recoverWorkflowResultClaims: (projectPath, sessionName) =>
          restartedStore.recoverGraphWorkflowResultDeliveries(
            projectPath,
            sessionName,
          ),
      } as RehydrateConversationActorsDeps & {
        recoverWorkflowResultClaims(
          projectPath: string,
          sessionName: string,
        ): Promise<number>;
      });

      expect(
        createGraphWorkflowResultDeliveriesRepo(fixture.db).findByBoundary(
          "/repo",
          "feat",
          "exec-restart",
          7,
        ),
      ).toMatchObject({ state: "pending", attemptId: null, attemptCount: 1 });
    } finally {
      fixture.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Project-scope rehydration diagnostics (R1.3)
// ---------------------------------------------------------------------------

// Startup rehydration is a project path that never runs a prompt: it restores a
// project conversation's actor from its persisted snapshot. The candidate for a
// project conversation carries the sentinel as its store session name, and both
// of this stage's structured events reported it as a session identity.
describe("project-scope rehydration diagnostics", () => {
  const PROJECT_CONV_ID = "conv-project-rehydrate";
  const PROJECT_PATH = "/test/project";
  const PROJECT_KEY = `${PROJECT_PATH}::${PROJECT_CONVERSATION_SESSION_SENTINEL}::${PROJECT_CONV_ID}`;

  afterEach(() => {
    managerFixture.dispose();

    _resetConversationQueueDepsForTesting();
    resetRuntime();
  });

  function makeProjectSnapshot(): Snapshot<unknown> {
    const input: ConversationInput = {
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName(
        "test-project",
        PROJECT_CONVERSATION_SESSION_SENTINEL,
        PROJECT_CONV_ID,
      ),

      // The runtime/state-store key for a project conversation (A5).

      worktreePath: PROJECT_PATH,

      createdAt: "2026-01-01T00:00:00.000Z",
      forkedFrom: null,
      role: null,
      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 1,
      persistence: "durable",
    };
    const actor = createActor(createTestMachine(), { input });
    actor.start();
    const snapshot = actor.getPersistedSnapshot();
    actor.stop();
    return snapshot;
  }

  function projectRehydrateArgs(log: CapturingLogger) {
    return {
      key: PROJECT_KEY,
      projectPath: PROJECT_PATH,
      projectName: "test-project",
      storeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: PROJECT_PATH,
      conversation: {
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        id: PROJECT_CONV_ID,
        createdAt: "2026-01-01T00:00:00.000Z",
        forkedFrom: null,
        role: null,
        transcriptPath: "/t.jsonl",
        agentBackend: "claude" as const,
        backendRef: null,
        promptCount: 1,
        debugMode: null,
      },
      snapshot: makeProjectSnapshot(),
      log,
    };
  }

  it("reports scope:project on the rehydrated event", async () => {
    machineFactory = createTestMachine;
    setConversationQueueDeps(makeQueueDeps());
    const log = createCapturingLogger();

    const started = await rehydrateOneConversationActor(
      projectRehydrateArgs(log),
      rehydrationInfrastructure(),
    );

    expect(started).toBe(true);
    const rehydrated = log.entries.find(
      (e) => e.message === "conversation-manager.rehydrated",
    );
    expect(rehydrated?.fields).toMatchObject({
      scope: "project",
      conversationId: PROJECT_CONV_ID,
    });
    expect(rehydrated?.fields).not.toHaveProperty("sessionName");
    expect(log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("reports scope:project when abandoned-delivery recovery fails", async () => {
    machineFactory = createTestMachine;
    setConversationQueueDeps(
      makeQueueDeps({
        recoverAbandonedDeliveries: vi.fn(async () => {
          throw new Error("recover boom");
        }),
      }),
    );
    const log = createCapturingLogger();

    const started = await rehydrateOneConversationActor(
      projectRehydrateArgs(log),
      rehydrationInfrastructure(),
    );

    expect(started).toBe(false);
    const failed = log.entries.find(
      (e) => e.message === "queue.recover_failed",
    );
    expect(failed?.fields).toMatchObject({ scope: "project" });
    expect(failed?.fields).not.toHaveProperty("sessionName");
    expect(log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("still reports the real session name for a session conversation", async () => {
    machineFactory = createTestMachine;
    setConversationQueueDeps(makeQueueDeps());
    const log = createCapturingLogger();

    const args = projectRehydrateArgs(log);
    const sessionInput: ConversationInput = {
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName(
        "test-project",
        "feat",
        PROJECT_CONV_ID,
      ),

      worktreePath: `${PROJECT_PATH}/.worktrees/feat`,

      createdAt: "2026-01-01T00:00:00.000Z",
      forkedFrom: null,
      role: null,
      transcriptPath: "/t.jsonl",
      agentBackend: "claude",
      backendRef: null,
      promptCount: 1,
      persistence: "durable",
    };
    const seedActor = createActor(createTestMachine(), { input: sessionInput });
    seedActor.start();
    const snapshot = seedActor.getPersistedSnapshot();
    seedActor.stop();

    await rehydrateOneConversationActor(
      {
        ...args,
        key: `${PROJECT_PATH}::feat::${PROJECT_CONV_ID}`,
        storeSessionName: "feat",
        worktreePath: `${PROJECT_PATH}/.worktrees/feat`,
        snapshot,
      },
      rehydrationInfrastructure(),
    );

    const rehydrated = log.entries.find(
      (e) => e.message === "conversation-manager.rehydrated",
    );
    expect(rehydrated?.fields).toMatchObject({
      scope: "session",
      sessionName: "feat",
    });
  });
});

function rehydrationInfrastructure() {
  return {
    host: managerFixture.host,
    queue: currentQueueDependencies(),
    mutateConversation: async () => {},
  };
}
