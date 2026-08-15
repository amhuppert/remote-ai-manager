/**
 * Integration: a runtime constructed `persistence: "ephemeral"` (compaction
 * lanes, workflow-graph validator lanes — neither backed by a
 * `ConversationState` record) performs ZERO durable conversation writes across
 * a full turn, and therefore never logs the `Conversation not found in session`
 * mutation failure that a per-call-site persistence decision produced 1,314
 * times in the two-week audit (Design 4).
 *
 * The machine is the exact production-provided one the manager starts actors
 * with (`createProvidedMachine`) with a chosen adapter, driven with a fake
 * backend and injected state-store seams. No `vi.mock` of internal project
 * modules — every seam is injected (AGENTS.md testing boundaries).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fromPromise, createActor, type AnyActorRef } from "xstate";

// Shared logger so warnings emitted from any module under test (the
// conversation manager, the persistence adapter) are observable by the test.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("@/lib/logging", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/logging")>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  createProvidedMachine,
  _resetForTesting as resetManagerActors,
  _resetMachineFactoryForTesting,
} from "./manager";
import {
  durableConversationPersistence,
  ephemeralConversationPersistence,
  setConversationPersistenceAdapterDeps,
  _resetConversationPersistenceAdapterDepsForTesting,
  type ConversationPersistenceAdapterDeps,
} from "./persistence-adapter";
import {
  setPersistenceDeps,
  _resetForTesting as resetPersistenceForTesting,
} from "./persistence";
import {
  setActorDeps,
  _resetActorDepsForTesting,
  type ActorImplementationDeps,
} from "./actor-implementations";
import {
  executeWorkflowTaskRun,
  _resetExecuteWorkflowTaskRunForTesting,
} from "./execute-workflow-task-run";
import { _resetForTesting as resetRuntimeState } from "./runtime-state";
import {
  setConversationQueueDeps,
  _resetConversationQueueDepsForTesting,
} from "@/lib/conversations/message-queue-drain";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import { createProjectConversationNotificationService } from "@/lib/notifications/project-conversation-service";
import {
  setProjectConversationStatusNotificationDepsForTesting,
  _resetProjectConversationStatusNotificationDepsForTesting,
} from "@/lib/project-conversations/status-notifications";
import type { Db } from "@/lib/state-store/schemas";
import type {
  ConversationInput,
  PromptActorResult,
  PrepareTurnInput,
  PrepareTurnOutput,
  RunTaskRunInput,
} from "./types";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";

// ============================================================
// Fake backend actors — no real agent, no filesystem, no DB
// ============================================================

const fakeTaskRunResult: PromptActorResult = {
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
};

/**
 * The production-provided machine with a chosen persistence adapter and fake
 * `prepareTurn` / `runTaskRun` actors substituted for the real backend. Only
 * the two backend actors are overridden; every durable side effect still flows
 * through the real provided actions and the injected adapter.
 */
function providedMachineWithFakeBackend(
  adapter: typeof durableConversationPersistence,
) {
  return createProvidedMachine(adapter).provide({
    actors: {
      prepareTurn: fromPromise<PrepareTurnOutput, PrepareTurnInput>(
        async () => ({ transcriptPath: "/tmp/transcript.jsonl" }),
      ),
      runTaskRun: fromPromise<PromptActorResult, RunTaskRunInput>(
        async () => fakeTaskRunResult,
      ),
    },
  });
}

function waitForState(
  actor: AnyActorRef,
  stateName: string,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out waiting for state "${stateName}", current: ${JSON.stringify(
              actor.getSnapshot().value,
            )}`,
          ),
        ),
      timeoutMs,
    );
    const check = (value: unknown): boolean =>
      (typeof value === "string" ? value : JSON.stringify(value)).includes(
        stateName,
      );
    const sub = actor.subscribe((snapshot) => {
      if (check(snapshot.value)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Drive one full `task_run` turn (the shape every compaction / validator lane
 * dispatches) and wait for the machine to settle back to idle.
 */
async function driveTaskRunTurn(
  input: ConversationInput,
  adapter: typeof durableConversationPersistence,
): Promise<AnyActorRef> {
  const actor = createActor(providedMachineWithFakeBackend(adapter), { input });
  actor.start();
  const settled = waitForState(actor, "idle");
  actor.send({
    type: "SUBMIT_TASK_RUN",
    promptText: "Validate the context.",
    timeoutMs: 30_000,
  });
  await settled;
  return actor;
}

// ============================================================
// Fixtures
// ============================================================

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess"; // non-sentinel: project-notification path stays dormant

function makeInput(
  overrides: Partial<ConversationInput> &
    Pick<ConversationInput, "persistence">,
): ConversationInput {
  return {
    conversationScope: "session",
    projectPath: PROJECT_PATH,
    projectName: "proj",
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    conversationId: "conv-1",
    createdAt: "2026-01-01T00:00:00Z",
    forkedFrom: null,
    role: null,
    transcriptPath: "/tmp/transcript.jsonl",
    agentBackend: "claude",
    backendRef: null,
    promptCount: 0,
    ...overrides,
  };
}

/**
 * A `mutateConversation` seam that behaves like the production store for a lane
 * with no `ConversationState` record: every call throws
 * `Conversation not found in session`. A correct ephemeral runtime never calls
 * it; a durable runtime calls it and the adapter logs the failure.
 */
function makeMissingConversationDeps(): {
  deps: ConversationPersistenceAdapterDeps;
  mutate: ReturnType<typeof vi.fn>;
} {
  const mutate = vi.fn(async () => {
    throw new Error("Conversation not found in session");
  });
  return {
    mutate,
    deps: {
      mutateConversation: mutate,
      publishSessionStatus: () => ({ delivered: true }),
      queueAutoName: () => {},
    },
  };
}

function syncDerivedWarnCalls(): unknown[][] {
  return warnSpy.mock.calls.filter(
    (call) => call[0] === "conversation-manager.sync_derived_failed",
  );
}

// This describe verifies the MACHINE-ACTION delegation (syncDerivedFields /
// mark-read/unread routed through the adapter) at the machine level, with fake
// XState actors standing in for the backend — it is not the durable-write
// contract. The zero-DB-change contract below drives the production child-actor
// path (real actors, fake backend) and diffs the real database.
describe("ephemeral conversation runtime — no durable writes (machine-action delegation)", () => {
  beforeEach(() => {
    warnSpy.mockClear();
    // Inert snapshot + queue seams so a durable runtime's OTHER writes cannot
    // reach a real store during the contrast case; the assertion is scoped to
    // the derived-field mutation the audit flagged.
    setPersistenceDeps({
      getConversationMachineSnapshot: () => null,
      upsertConversationMachineSnapshot: async () => {},
      deleteConversationMachineSnapshot: async () => {},
    });
    setConversationQueueDeps({
      claimNextTurnBatch: async () => null,
      markPending: async () => {},
      markDelivered: async () => {},
      markFailed: async () => {},
      recoverAbandonedDeliveries: async () => 0,
      runConversationCommand: async () => ({
        status: "dispatched",
        jobId: "job-1",
        usedFallback: false,
      }),
    });
  });

  afterEach(() => {
    _resetConversationPersistenceAdapterDepsForTesting();
    resetPersistenceForTesting();
    _resetConversationQueueDepsForTesting();
  });

  it("requires an explicit persistence choice at construction (no default)", () => {
    // AC #1: constructing a runtime without deciding persistence fails to
    // compile. The required, no-default field is the mechanism.
    // @ts-expect-error persistence is required on ConversationInput
    const missing: ConversationInput = {
      projectPath: PROJECT_PATH,
      projectName: "proj",
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      conversationId: "conv-1",
      createdAt: "2026-01-01T00:00:00Z",
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "claude",
      backendRef: null,
      promptCount: 0,
    };
    // The choice reaches the machine as the derived `transient` flag.
    void missing;
    const ephemeral = createActor(
      providedMachineWithFakeBackend(ephemeralConversationPersistence),
      { input: makeInput({ persistence: "ephemeral" }) },
    );
    ephemeral.start();
    expect(ephemeral.getSnapshot().context.transient).toBe(true);
    ephemeral.stop();
  });

  it("a validator-style ephemeral runtime never attempts a durable mutation and logs no conversation-not-found warning", async () => {
    const { deps, mutate } = makeMissingConversationDeps();
    setConversationPersistenceAdapterDeps(deps);

    const actor = await driveTaskRunTurn(
      makeInput({
        conversationId:
          "__validator__:exec-1:context-1:context_validator:claude",
        persistence: "ephemeral",
      }),
      ephemeralConversationPersistence,
    );
    // Let any (wrongly) scheduled fire-and-forget adapter work run.
    await Promise.resolve();
    await Promise.resolve();

    expect(actor.getSnapshot().context.transient).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
    expect(syncDerivedWarnCalls()).toHaveLength(0);
    actor.stop();
  });

  it("a durable runtime on the same drive DOES attempt the mutation and surfaces the failure (contrast: not a dead drive)", async () => {
    const { deps, mutate } = makeMissingConversationDeps();
    setConversationPersistenceAdapterDeps(deps);

    const actor = await driveTaskRunTurn(
      makeInput({ conversationId: "conv-durable-1", persistence: "durable" }),
      durableConversationPersistence,
    );

    // Durable adapter writes are fire-and-forget async: wait for the derived
    // sync to attempt its mutation and the adapter to log the not-found failure
    // — the exact 1,314× symptom the ephemeral facet removes.
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalled();
      const calls = syncDerivedWarnCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(calls)).toContain("Conversation not found");
    });
    actor.stop();
  });
});

// ============================================================
// Contract test (AC #4): zero DB-table changes, diffed against a real store
// ============================================================

/**
 * Dump every user table's contents as a stable string, so before/after can be
 * compared byte-for-byte. Diffing table CONTENTS (not write-queue call counts)
 * catches any durable write regardless of which seam issued it — a queue-call
 * count would miss a path that bypassed the queue (Design 4's contract).
 */
function dumpAllTables(db: Db): Record<string, string> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const dump: Record<string, string> = {};
  for (const { name } of tables) {
    dump[name] = JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
  }
  return dump;
}

/**
 * A completed AgentCall from a fake backend — the substitute the validator
 * asked for: a fake backend *beneath* the production `runTaskRun` actor, not a
 * fake XState actor replacing it. `deps.executeAgentCall` is the actor's single
 * backend seam, so faking it exercises the whole production child-actor path
 * (locks, config, abort registry, transcript append) while doing no real work.
 */
const fakeCompletedAgentCall: AgentCallResult = {
  backend: "claude",
  backendRef: null,
  capabilities: capabilityViewForBackend("claude"),
  usage: {},
  artifacts: [],
  outcome: { kind: "completed", text: "ok" },
  continuationDisposition: "retain",
};

/**
 * Full `ActorImplementationDeps` for the production `runTaskRun` / `prepareTurn`
 * actors with a fake backend. Every durable state-store WRITE dep is routed to
 * the fixture store so a stray actor write would land in the diffed database;
 * the backend call and transcript/lock/slot seams are inert doubles. Deps the
 * task_run path never touches throw if called, so an unexpected reach is loud.
 */
function makeFakeBackendActorDeps(
  fixture: ReturnType<typeof createPersistenceFixture>,
): ActorImplementationDeps {
  const unusedInTaskRun = (name: string) => (): never => {
    throw new Error(`fake backend: ${name} is not used on the task_run path`);
  };
  return {
    log: createCapturingLogger(),
    acquireConversationLock: () => () => {},
    acquireQuerySlot: async () => () => {},
    getTranscriptPath: async (id) => `/tmp/cc-ephemeral-test/${id}.jsonl`,
    readConfig: async () => ({
      agentBackends: {
        claude: { model: "opus", timeoutMs: 300_000 },
        codex: { model: "gpt-5.4", timeoutMs: null },
      },
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
    }),
    getProjectDisplayName: (p) => p.split("/").pop() ?? p,
    getConversationBackendFactory: unusedInTaskRun(
      "getConversationBackendFactory",
    ),
    getConversationCapabilities: () => undefined,
    registerBackendRuntime: () => {},
    unregisterBackendRuntime: () => {},
    mintConversationCapability: () => null,
    buildChildEnv: () => process.env,
    resolvePluginPaths: async () => [],
    getCodexToolPromptHint: () => "",
    // Durable state-store writes → the fixture, so a stray one shows in the diff.
    mutateConversation: fixture.store.mutateConversation,
    getConversation: fixture.store.getConversation,
    getSessionState: fixture.store.getSession,
    getActiveAlignmentInjection: async () => null,
    getActiveAlignmentVersion: async () => null,
    getLiveTicketBlock: async () => null,
    claimWorkflowResults: (input) =>
      fixture.store.claimGraphWorkflowResultDeliveries(
        input.projectPath,
        input.sessionName,
        input.originConversationId,
        input.attemptId,
      ),
    settleWorkflowResults: (input) =>
      fixture.store.settleGraphWorkflowResultDeliveries(
        input.projectPath,
        input.sessionName,
        input.originConversationId,
        input.attemptId,
      ),
    releaseWorkflowResults: (input) =>
      fixture.store.releaseGraphWorkflowResultDeliveries(
        input.projectPath,
        input.sessionName,
        input.originConversationId,
        input.attemptId,
      ),
    createReferenceDocument: fixture.store.createReferenceDocument,
    getReferenceDocuments: async () => [],
    readConversationMessages: async () => [],
    fileExists: () => false,
    registerAbortController: () => {},
    unregisterAbortController: () => {},
    composePortableMcpForConversation: async () => ({ servers: [] }),
    applyMcpAtTurnStart: async () => ({
      conversationId: "c",
      backend: "claude",
      disposition: "applied_now",
      effectiveConfigHash: "hash",
    }),
    applyCapabilityAtTurnStart: async () => ({}),
    applyCapabilityWhenIdle: async () => ({}),
    composeCapabilityConfigForConversation: async () => undefined,
    composeCapabilityConfigForProjectConversation: async () => undefined,
    executeAgentCall: async () => fakeCompletedAgentCall,
    getTaskRunner: unusedInTaskRun("getTaskRunner"),
    safeAppendTranscriptEntry: async () => {},
    saveTranscriptImage: async () => "/tmp/img.png",
    getNextImageIndex: async () => 0,
    getDebugLogUrl: (id) => `http://localhost/debug/${id}`,
    markQueuedDelivered: async () => {},
    markQueuedPending: async () => {},
    markQueuedFailed: async () => {},
  };
}

describe("ephemeral runtime — zero database writes (contract, real actors + fake backend)", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let notificationCalls: number;

  beforeEach(() => {
    warnSpy.mockClear();
    // Real machine factory + real actors: no factory override, no provide().
    _resetMachineFactoryForTesting();
    _resetExecuteWorkflowTaskRunForTesting();
    resetManagerActors();
    resetRuntimeState();

    fixture = createPersistenceFixture();
    // Every durable seam points at the fixture, so ANY write the runtime makes
    // lands in the diffed database (Design 4: verify against the DB, not queue
    // call counts). The ephemeral facet must leave all of them untouched.
    setPersistenceDeps({
      getConversationMachineSnapshot:
        fixture.store.getConversationMachineSnapshot,
      upsertConversationMachineSnapshot:
        fixture.store.upsertConversationMachineSnapshot,
      deleteConversationMachineSnapshot:
        fixture.store.deleteConversationMachineSnapshot,
    });
    setConversationPersistenceAdapterDeps({
      mutateConversation: fixture.store.mutateConversation,
      publishSessionStatus: () => ({ delivered: true }),
      queueAutoName: () => {},
    });
    setConversationQueueDeps({
      claimNextTurnBatch: async () => null,
      markPending: async () => {},
      markDelivered: async () => {},
      markFailed: async () => {},
      recoverAbandonedDeliveries: async () => 0,
      runConversationCommand: async () => ({
        status: "dispatched",
        jobId: "job-1",
        usedFallback: false,
      }),
    });
    setActorDeps(makeFakeBackendActorDeps(fixture));

    // Route the project-conversation notification durable write to the fixture's
    // own `notifications` table, so a wrongly-notifying ephemeral project
    // compaction would insert a row the table diff catches.
    notificationCalls = 0;
    const notifRepo = createNotificationsRepo(fixture.db);
    const notificationService = createProjectConversationNotificationService({
      createProjectConversationNotification: (input) => {
        notificationCalls += 1;
        return notifRepo.createProjectConversationNotification(input)
          .notification;
      },
    });
    setProjectConversationStatusNotificationDepsForTesting({
      getProjectConversation: async () => null,
      notificationService,
    });
  });

  afterEach(() => {
    resetManagerActors();
    resetRuntimeState();
    _resetMachineFactoryForTesting();
    _resetExecuteWorkflowTaskRunForTesting();
    _resetActorDepsForTesting();
    _resetConversationPersistenceAdapterDepsForTesting();
    resetPersistenceForTesting();
    _resetConversationQueueDepsForTesting();
    _resetProjectConversationStatusNotificationDepsForTesting();
    fixture.close();
  });

  /** Drive one production `task_run` turn through the real actors + fake backend. */
  async function driveTaskRun(opts: {
    sessionName: string;
    worktreePath: string;
    conversationId: string;
    persistence: "durable" | "ephemeral";
  }): Promise<void> {
    await executeWorkflowTaskRun({
      projectPath: PROJECT_PATH,
      sessionName: opts.sessionName,
      conversationId: opts.conversationId,
      kind: "task_run",
      prompt: "Do the task.",
      timeoutMs: 30_000,
      actorInput: {
        conversationScope: "session",
        projectName: "proj",
        sessionWorktreePath: opts.worktreePath,
        persistence: opts.persistence,
        conversation: {
          createdAt: "2026-01-01T00:00:00Z",
          forkedFrom: null,
          role: null,
          transcriptPath: null,
          agentBackend: "claude",
          backendRef: null,
          promptCount: 0,
          debugMode: null,
        },
      },
    });
    // Let the finalize transition's fire-and-forget durable writes settle.
    await vi.waitFor(() => expect(warnSpy).toBeDefined());
    await Promise.resolve();
    await Promise.resolve();
  }

  it("session-scoped ephemeral validator lane makes zero table changes and logs no not-found error", async () => {
    // A project + session exist, but NO conversation row — exactly a validator
    // lane. Byte-identical dump afterwards proves the turn inserted no row.
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    const before = dumpAllTables(fixture.db);

    await driveTaskRun({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      conversationId: "__validator__:exec-1:context-1:context_validator:claude",
      persistence: "ephemeral",
    });

    expect(dumpAllTables(fixture.db)).toEqual(before);
    expect(syncDerivedWarnCalls()).toHaveLength(0);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
      "Conversation not found",
    );
  });

  it("project-sentinel ephemeral compaction inserts no notification row (zero table changes)", async () => {
    // The __project__-sentinel gap the first attempt missed: a project
    // compaction settles to `awaiting`, which for a durable runtime would insert
    // a `notifications` row. The ephemeral facet must suppress it entirely.
    fixture.seedProject(PROJECT_PATH);
    const before = dumpAllTables(fixture.db);

    await driveTaskRun({
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: PROJECT_PATH,
      conversationId: "compaction-artifact-1",
      persistence: "ephemeral",
    });

    expect(dumpAllTables(fixture.db)).toEqual(before);
    expect(notificationCalls).toBe(0);
    expect(
      (
        fixture.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(syncDerivedWarnCalls()).toHaveLength(0);
  });

  it("durable session runtime persists across the same drive (guards against a vacuous fixture)", async () => {
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      conversationStateSchema.parse({
        id: "conv-durable-1",
        transcriptPath: "/tmp/transcript.jsonl",
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        agentBackend: "claude",
      }),
    );
    const before = dumpAllTables(fixture.db);

    await driveTaskRun({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      conversationId: "conv-durable-1",
      persistence: "durable",
    });

    await vi.waitFor(async () => {
      const row = await fixture.deps.getConversation(
        PROJECT_PATH,
        SESSION_NAME,
        "conv-durable-1",
      );
      expect(row?.promptCount).toBe(1);
      expect(row?.status).toBe("awaiting");
    });
    expect(dumpAllTables(fixture.db)).not.toEqual(before);
  });

  it("durable project conversation writes a notification row (proves the ephemeral suppression is a real difference)", async () => {
    fixture.seedProject(PROJECT_PATH);
    const before = dumpAllTables(fixture.db);

    await driveTaskRun({
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      worktreePath: PROJECT_PATH,
      conversationId: "proj-conv-1",
      persistence: "durable",
    });

    await vi.waitFor(() => {
      expect(notificationCalls).toBeGreaterThan(0);
      expect(
        (
          fixture.db
            .prepare("SELECT COUNT(*) AS n FROM notifications")
            .get() as { n: number }
        ).n,
      ).toBeGreaterThan(0);
    });
    expect(dumpAllTables(fixture.db)).not.toEqual(before);
  });
});
