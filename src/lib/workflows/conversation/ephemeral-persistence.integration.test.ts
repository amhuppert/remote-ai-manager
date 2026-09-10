import { createConversationManagerFixture } from "@/lib/workflows/conversation/testing/manager-fixture";
import type { ConversationManagerDependencies } from "@/lib/workflows/conversation/manager";
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
    loadActors: async () => conversationActors,
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
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import type { ActorFixtureDependencies } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { loadActorInput } from "./actor-input-loader";

import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "@/lib/conversations/profile-admission";

import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createMemoryTelemetryService } from "@/lib/memory/telemetry";
import { createMemoryTelemetryRepo } from "@/lib/state-store/memory-telemetry-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";

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
const { warnSpy, errorSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));
vi.mock("@/lib/logging", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/logging")>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

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
  return managerFixture.providedMachine(adapter).provide({
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
    kind: "task_run",
    executionClass: "nongoverned-task" as const,
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
    lastActivityAt: "2026-01-01T00:00:00Z",
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    contextTokens: null,
    contextWindowMax: null,
    target: targetFromStoreSessionName("proj", SESSION_NAME, "conv-1"),

    projectPath: PROJECT_PATH,

    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,

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

function persistenceFailureCalls(): unknown[][] {
  return errorSpy.mock.calls.filter(
    (call) => call[0] === "conversation.persistence_failed",
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
    errorSpy.mockClear();
    // Inert snapshot + queue seams so a durable runtime's OTHER writes cannot
    // reach a real store during the contrast case; the assertion is scoped to
    // the derived-field mutation the audit flagged.
    setPersistenceDeps({
      getConversationMachineSnapshot: () => null,
      upsertConversationMachineSnapshot: async () => {},
      deleteConversationMachineSnapshot: async () => {},
    });
    setConversationQueueDeps({
      submitTurn: managerFixture.manager.submitConversationTurn,
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
      lastActivityAt: "2026-01-01T00:00:00Z",
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName("proj", SESSION_NAME, "conv-1"),

      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,

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
        target: targetFromStoreSessionName(
          "proj",
          "test-session",
          "__validator__:exec-1:context-1:context_validator:claude",
        ),

        persistence: "ephemeral",
      }),
      ephemeralConversationPersistence,
    );
    // Let any (wrongly) scheduled fire-and-forget adapter work run.
    await Promise.resolve();
    await Promise.resolve();

    expect(actor.getSnapshot().context.transient).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
    expect(persistenceFailureCalls()).toHaveLength(0);
    actor.stop();
  });

  it("a durable runtime on the same drive DOES attempt the mutation and surfaces the failure (contrast: not a dead drive)", async () => {
    const { deps, mutate } = makeMissingConversationDeps();
    setConversationPersistenceAdapterDeps(deps);

    const actor = await driveTaskRunTurn(
      makeInput({
        target: targetFromStoreSessionName(
          "proj",
          "test-session",
          "conv-durable-1",
        ),
        persistence: "durable",
      }),
      durableConversationPersistence,
    );

    // The durable control drive must reach the same write seam that the
    // ephemeral adapter suppresses, and retain its storage failure.
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalled();
      const calls = persistenceFailureCalls();
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
 * Full `ActorFixtureDependencies` for the production `runTaskRun` / `prepareTurn`
 * actors with a fake backend. Every durable state-store WRITE dep is routed to
 * the fixture store so a stray actor write would land in the diffed database;
 * the backend call and transcript/lock/slot seams are inert doubles. Deps the
 * task_run path never touches throw if called, so an unexpected reach is loud.
 */
function makeFakeBackendActorDeps(
  fixture: ReturnType<typeof createPersistenceFixture>,
): ActorFixtureDependencies {
  const unusedInTaskRun = (name: string) => (): never => {
    throw new Error(`fake backend: ${name} is not used on the task_run path`);
  };
  return {
    log: createCapturingLogger(),
    checkpoint: {
      repo: unusedInTaskRun("checkpoint.repo"),
      now: () => new Date().toISOString(),
    },
    acquireConversationLock: () => () => {},
    acquireQuerySlot: async () => () => {},
    getTranscriptPath: async (id) => `/tmp/cc-ephemeral-test/${id}.jsonl`,
    readConfig: async () => ({
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
    }),
    getProjectDisplayName: (p) => p.split("/").pop() ?? p,
    getConversationBackendFactory: unusedInTaskRun(
      "getConversationBackendFactory",
    ),
    admitConfiguredModelSelection: async ({ modelSelection }) => ({
      ok: true,
      modelSelection,
    }),
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
    getMemoryIndexBlock: async () => null,
    readLiveReference: async () => null,
    readNotepadForInjection: async () => null,
    recordNotepadDeliveries: async () => {},
    recordMemoryIndexDeliveries: async () => {},
    resetMemoryIndexDelivery: async () => {},
    prepareNotepadChangeNotice: async (conversationId: string) => ({
      conversationId,
      block: null,
      advances: [],
    }),
    settleNotepadChangeNotice: async () => {},
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
    appendTranscriptEntryOnce: async () => {},
    safeAppendTranscriptEntryOnce: async () => {},
    saveTranscriptImage: async () => "/tmp/img.png",
    getNextImageIndex: async () => 0,
    getDebugLogUrl: (id) => `http://localhost/debug/${id}`,
    confirmQueuedDelivery: async () => 0,
    markQueuedUncertain: async () => {},
    markQueuedPending: async () => {},
    markQueuedFailed: async () => {},
  };
}

describe("ephemeral runtime — zero database writes (contract, real actors + fake backend)", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let notificationCalls: number;

  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    // Real machine factory + real actors: no factory override, no provide().

    managerFixture.dispose();
    resetRuntimeState();

    fixture = createPersistenceFixture();
    actorInputLoader = (p, s, c) =>
      loadActorInput(
        {
          getSession: fixture.store.getSession,
          getProjectConversation: fixture.store.getProjectConversation,
          getProjectDisplayName: () => "proj",
          hydrateCheckpointAuthority: async () => ({
            projection: null,
            state: { active: null, latestAccepted: null },
            outcome: { kind: "none" as const },
            continuationRetired: false,
          }),
        },
        p,
        s,
        c,
      );
    admissionReader = async (key) => ({
      found:
        (await fixture.store.getConversation(
          key.projectPath,
          key.sessionName,
          key.conversationId,
        )) !== null,
      requiresQueueReview: false,
    });
    setConversationProfileAdmissionDeps({
      mutateConversation: fixture.store.mutateConversation,
    });
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
      submitTurn: managerFixture.manager.submitConversationTurn,
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
    conversationActors = createTestActorImplementations(
      makeFakeBackendActorDeps(fixture),
    );

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
    managerFixture.dispose();
    resetRuntimeState();

    _resetConversationPersistenceAdapterDepsForTesting();
    resetPersistenceForTesting();
    _resetConversationQueueDepsForTesting();
    _resetProjectConversationStatusNotificationDepsForTesting();

    _resetConversationProfileAdmissionDepsForTesting();
    fixture.close();
  });

  /** Drive one production `task_run` turn through the real actors + fake backend. */
  async function driveTaskRun(opts: {
    sessionName: string;
    worktreePath: string;
    conversationId: string;
    persistence: "durable" | "ephemeral";
  }): Promise<void> {
    const address = {
      projectPath: PROJECT_PATH,
      target: targetFromStoreSessionName(
        "proj",
        opts.sessionName,
        opts.conversationId,
      ),
    };
    await managerFixture.executeWorkflowTaskRun({
      binding:
        opts.persistence === "durable"
          ? { kind: "durable", address, worktreePath: opts.worktreePath }
          : {
              kind: "ephemeral",
              address,
              worktreePath: opts.worktreePath,
              backend: "claude",
              role: null,
              transcriptPath: null,
            },
      executionClass: "nongoverned-task" as const,
      kind: "task_run",
      prompt: "Do the task.",
      timeoutMs: 30_000,
    });
    // Let the finalize transition's fire-and-forget durable writes settle.
    await vi.waitFor(() => expect(warnSpy).toBeDefined());
    await Promise.resolve();
    await Promise.resolve();
  }

  it.each([
    ["session", "ephemeral"],
    ["project", "ephemeral"],
    ["session", "durable"],
    ["project", "durable"],
  ] as const)(
    "%s %s streaming compaction respects the memory reset gate",
    async (scope, persistence) => {
      const id = "stream-compaction";
      const sessionName =
        scope === "project"
          ? PROJECT_CONVERSATION_SESSION_SENTINEL
          : SESSION_NAME;
      fixture.seedProject(PROJECT_PATH);
      if (scope === "session") fixture.seedSession(PROJECT_PATH, SESSION_NAME);
      const row = conversationStateSchema.parse({
        id,
        scope,
        status: "new",
        transcriptPath: null,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        promptCount: 0,
        agentBackend: "claude",
      });
      if (persistence === "durable") {
        if (scope === "project")
          await fixture.seedProjectConversation(PROJECT_PATH, row);
        else await fixture.seedConversation(PROJECT_PATH, SESSION_NAME, row);
      }
      const telemetry = createMemoryTelemetryService({
        repo: createMemoryTelemetryRepo(fixture.db, createWriteQueue()),
        now: () => "2026-01-01T00:00:00Z",
      });
      await telemetry.recordDelivery({
        conversationId: id,
        channel: "index",
        kind: "full",
        composedAt: "2026-01-01T00:00:00Z",
        notes: [],
      });
      let dispatches = 0;
      const backendRuntime = createMockBackendRuntime({
        async sendTurn(input) {
          dispatches++;
          await input.onEvent({ type: "input_accepted" });
          return {
            backendRef: null,
            costUsd: 0.5,
            durationMs: 20,
            numTurns: 1,
            contextTokens: 100,
            contextWindowMax: 200000,
            contentBlocks: [],
            aborted: false,
            compacted: true,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      });
      conversationActors = createTestActorImplementations({
        ...makeFakeBackendActorDeps(fixture),
        getConversationBackendFactory: () => ({
          backend: "claude",
          createRuntime: async () => backendRuntime,
        }),
        executeAgentCall,
        resetMemoryIndexDelivery: telemetry.resetIndexDelivery,
      });
      const before = dumpAllTables(fixture.db);
      const actor = managerFixture.host.start(
        makeInput({
          target: targetFromStoreSessionName("test-project", sessionName, id),

          persistence,
          worktreePath:
            scope === "project"
              ? PROJECT_PATH
              : `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
        }),
      );
      const settled = waitForState(actor, "idle");
      actor.send({
        type: "SUBMIT_PROMPT",
        promptText: "Compact this turn",
        streamId: "compaction-stream",
      });
      await settled;
      expect(actor.getSnapshot().context.lastResult?.error).toBeNull();
      expect(dispatches).toBe(1);
      if (persistence === "ephemeral") {
        expect(dumpAllTables(fixture.db)).toEqual(before);
        expect((await telemetry.readIndexDelivery(id)).state).not.toBeNull();
      } else {
        expect((await telemetry.readIndexDelivery(id)).state).toBeNull();
      }
    },
  );

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
    expect(persistenceFailureCalls()).toHaveLength(0);
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
    expect(persistenceFailureCalls()).toHaveLength(0);
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
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      conversationStateSchema.parse({
        id: "proj-conv-1",
        scope: "project",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        agentBackend: "claude",
      }),
    );
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
