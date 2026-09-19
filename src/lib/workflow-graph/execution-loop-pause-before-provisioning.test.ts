import { createExecutionLoopFixture } from "@/lib/workflow-graph/testing/execution-loop-fixture";
import { createContextScheduler } from "./context-scheduler";
import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import type {
  ExecutionMutationDecision,
  ExecutionMutationOutcome,
} from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CleanupLaneInput,
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionLaneInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import { applyJoinProgress } from "@/lib/workflow-graph/context-transitions";
import type { JoinRunner } from "@/lib/workflow-graph/join-runner";
import { createPerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import { parseJsonl } from "@/lib/shared/read-jsonl";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import type { GraphWorkflowExecutionSeed } from "./execution-repository";
import {
  abortExecutionLoop,
  _resetActiveLoopsForTesting,
} from "./execution-loop";
import { createGraphWorkflowManager } from "./workflow-manager";
import type { GraphWorkflowIterationResult } from "@/lib/workflow-graph/context-outcome";
import { DEFAULT_LANE_MERGE_VALIDATION_CONFIG } from "./config-schemas";
import { assertLoopFence } from "./loop-fence";
import {
  createExecutionLogger,
  registerExecutionLogger,
  _resetRegistryForTesting,
} from "./execution-logger";

/**
 * Regression for the pause-before-provisioning halt (ticket #80, design 3.8):
 * an execution paused after start but before any lane was provisioned resumed
 * into the completion-invariant guard and halted with `recovery_error`
 * ("Refusing to complete …"), a halt no plan repair can fix.
 *
 * The scenario drives the REAL manager (pause, resume), scheduler and the REAL
 * loop over a fenced in-memory repository. The defect lives in what a
 * superseded loop generation leaves behind when the pause lands while the
 * scheduler is provisioning out of the lock, so a harness scheduler would hide
 * it; and the repository must refuse the superseded generation's writes the
 * way the production one does, or its compensation would clean up after
 * itself and the resumed run would never see the incident's state.
 *
 * Two orderings matter. The settled one: the retired generation has exited
 * before the operator resumes. The racing one, which is what the resume route
 * actually produces: a pause only signals the retired loop, so the replacement
 * loop is kicked while the retired scheduler is still inside `git worktree
 * add` for the very lane the replacement has to mint.
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "session-1";
const LANE_WORKTREE_PATH = `${PROJECT_PATH}/.worktrees/${SESSION_NAME}.ctx-1`;

interface InMemoryExecutionRepository {
  ensureArtifactsMaterialized(): Promise<GraphWorkflowExecution | null>;
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution>;
  archiveActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowArchiveOutcome>;
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
}

/**
 * Serialized read-modify-write with the production loop fence applied before
 * the reducer runs, exactly where `createGraphWorkflowExecutionRepository`
 * applies it: a write issued under a retired generation's fence is refused.
 */
function createFencedRepository(
  initial: GraphWorkflowExecution,
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution } {
  let active = initial;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    ensureArtifactsMaterialized: async () => null,

    async getActive() {
      return active;
    },
    async create() {
      throw new Error("create is not used in this scenario");
    },
    async archiveActive() {
      throw new Error("archiveActive is not used in this scenario");
    },
    async mutateActive(projectPath, sessionName, fn) {
      const previous = chain;
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      chain = next;
      try {
        await previous;
        assertLoopFence(projectPath, sessionName, active);
        return applyFixtureMutation(active, fn, (next) => {
          active = next;
        });
      } finally {
        release();
      }
    },

    read() {
      return active;
    },
  };
}

function createSession(): SessionState {
  return {
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    branchName: `csm/${SESSION_NAME}`,
    createdAt: "2026-03-27T15:00:00.000Z",
    lastActivityAt: "2026-03-27T15:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  } as unknown as SessionState;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface GatedParallelWorktrees extends ParallelWorktrees {
  /** Resolves when the first lane provisioning has been requested. */
  firstProvisionRequested: Promise<void>;
  /** Lets the first lane provisioning return. */
  releaseFirstProvision: () => void;
  provisionLaneCalls: ProvisionLaneInput[];
  disposeLaneCalls: DisposeInput[];
  /** Worktree paths that currently exist on the fake disk. */
  worktreesOnDisk: Set<string>;
}

/**
 * A worktree provisioner with a fake disk that behaves the way the real one
 * does at a path: a worktree that already exists is adopted (the production
 * `provision_idempotent` path), one that is still being created cannot be
 * created a second time, and disposal removes it. The first `provisionLane`
 * call parks mid-creation until released, standing in for the out-of-lock
 * `git worktree add` a pause can land in the middle of; later calls return
 * immediately.
 */
function createGatedParallelWorktrees(): GatedParallelWorktrees {
  const requested = deferred<void>();
  const release = deferred<void>();
  let firstCall = true;
  const provisionLaneCalls: ProvisionLaneInput[] = [];
  const disposeLaneCalls: DisposeInput[] = [];
  const worktreesOnDisk = new Set<string>();
  const creating = new Set<string>();

  function targetsFor(
    projectPath: string,
    sessionDir: string,
    laneId: string,
  ): ProvisionResult {
    return {
      worktreePath: `${projectPath}/.worktrees/${sessionDir}.${laneId}`,
      branchName: `csm/${sessionDir}-${laneId}`,
    };
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    return targetsFor(input.projectPath, input.sessionDir, input.contextId);
  }

  async function provisionLane(
    input: ProvisionLaneInput,
  ): Promise<ProvisionResult> {
    provisionLaneCalls.push(input);
    const targets = targetsFor(
      input.projectPath,
      input.sessionDir,
      input.laneId,
    );
    if (creating.has(targets.worktreePath)) {
      throw new Error(
        `Worktree at ${targets.worktreePath} is already being created`,
      );
    }
    if (worktreesOnDisk.has(targets.worktreePath)) {
      return targets;
    }
    creating.add(targets.worktreePath);
    if (firstCall) {
      firstCall = false;
      requested.resolve();
      await release.promise;
    }
    creating.delete(targets.worktreePath);
    worktreesOnDisk.add(targets.worktreePath);
    return targets;
  }

  async function dispose(input: DisposeInput): Promise<DisposeResult> {
    disposeLaneCalls.push(input);
    worktreesOnDisk.delete(input.worktreePath);
    return { status: "removed" };
  }

  async function cleanupLane(_input: CleanupLaneInput): Promise<DisposeResult> {
    return { status: "removed" };
  }

  return {
    provision,
    async provisionBatch(inputs) {
      return Promise.all(inputs.map(provision));
    },
    dispose,
    provisionLane,
    async provisionLaneBatch(inputs) {
      const results: ProvisionResult[] = [];
      for (const input of inputs) results.push(await provisionLane(input));
      return results;
    },
    disposeLane: dispose,
    cleanupLane,
    firstProvisionRequested: requested.promise,
    releaseFirstProvision: () => release.resolve(),
    provisionLaneCalls,
    disposeLaneCalls,
    worktreesOnDisk,
  };
}

/** One context on its own worktree lane: the first batch has to mint a lane. */
function createSingleLaneDefinition(): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Context ctx-1",
        description: "The only context",
        acceptanceCriteria: "TBD",
        placement: { lane: "ctx-1", mode: "full" },
        implementer: {
          id: "implementer",
          profile: { tier: "builtin", id: "general-implementer" },
          agent: {
            backend: "claude",
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
          },
        },
        mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5 },
      },
    ],
    tasks: [
      {
        id: "task-ctx-1",
        contextId: "ctx-1",
        order: 1,
        title: "Task ctx-1",
        instructions: "Do work for ctx-1",
        source: "user",
      },
    ],
    edges: [],
  };
}

/** A just-started execution: running, nothing scheduled, no lane. */
function createStartedExecution(
  definition: WorkflowSemanticDefinition,
  executionId: string,
): GraphWorkflowExecution {
  return {
    id: executionId,
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    origin: {
      kind: "template",
      definitionId: "def-1",
      definitionRevision: 1,
      tier: "project",
    },
    launchDocument: null,
    liveSessionReadOnlyPinned: false,
    abandonment: null,
    liveRevision: 1,
    executionStateRevision: 0,
    structuralRevision: 0,
    charterAmendments: [],
    planRepairRounds: [],
    loopControlAmendments: [],
    contextOutputs: {},
    routeControlRevisions: {},
    routeSettlements: {},
    expansionReceipts: { accepted: [], refusals: [] },
    loopStates: {},
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    ownerConversationId: null,
    definitionApproval: null,
    definitionApprovalClaim: null,
    workingDefinition: {
      ...definition,
      laneMergeValidation: DEFAULT_LANE_MERGE_VALIDATION_CONFIG,
    } as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: [],
    contextStates: {
      "ctx-1": {
        skipReason: null,
        landingIntent: null,
        pendingApproval: null,
        pendingUserInputs: {},
        contextId: "ctx-1",
        status: "pending",
        totalTaskCount: 1,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        isolation: "session",
        batchId: null,
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
      },
    },
    taskStates: {
      "task-ctx-1": {
        taskId: "task-ctx-1",
        contextId: "ctx-1",
        order: 1,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    },
    sharedDocuments: [],
    advisoryIndex: [],
    laneStates: {},
    executionLanes: {},
    laneReservations: {},
    joins: {},
    machineSnapshot: null,
    startedAt: "2026-03-27T12:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingCollaborations: {},
    collaborationContinuations: {},
    pendingMergeRetry: [],
  };
}

function createNoopJoinRunner(): JoinRunner {
  return {
    async run({ joinId, mutateActive }) {
      await mutateActive((e) =>
        changed(
          applyJoinProgress(e, joinId, new Date().toISOString(), {
            status: "succeeded",
          }),
        ),
      ).then((mutation) => mutation.execution);
      return { status: "succeeded" };
    },
  };
}

/**
 * Every logger created for one execution id resolves the same directory, so the
 * lines the manager's own resume-time logger appends land in this file too.
 */
function readLifecycleEvents(logDir: string): string[] {
  const raw = readFileSync(path.join(logDir, "lifecycle.jsonl"), "utf-8");
  return parseJsonl(raw).map((entry) => {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "event" in entry &&
      typeof entry.event === "string"
    ) {
      return entry.event;
    }
    throw new Error(`lifecycle entry without an event name: ${String(entry)}`);
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The workflow modules one route's module graph evaluates. Next.js evaluates
 * route handlers in separate module graphs (the reason the active-loop
 * registry in execution-loop.ts lives on globalThis), so the loop the start
 * route launched and the replacement the resume route launches can come from
 * different module instances: module-local state is per instance, only
 * globalThis-hosted state is shared between them.
 */
interface RouteModules {
  createContextScheduler: typeof createContextScheduler;
  createGraphWorkflowManager: typeof createGraphWorkflowManager;
  createExecutionLoopFixture: typeof createExecutionLoopFixture;
  abortExecutionLoop: typeof abortExecutionLoop;
}

const startRouteModules: RouteModules = {
  createContextScheduler,
  createGraphWorkflowManager,
  createExecutionLoopFixture,
  abortExecutionLoop,
};

/** Evaluate the workflow modules again, as a second route module graph does. */
async function loadSeparateRouteModules(): Promise<RouteModules> {
  vi.resetModules();
  // These entry points share cyclic dependencies. Evaluate one graph before
  // requesting its other entry points so Vitest's loader cannot wait on its
  // own in-flight imports. Each call still creates a separate route graph.
  const manager = await import("./workflow-manager");
  const loop = await import("./execution-loop");
  const scheduler = await import("./context-scheduler");
  const fixture = await import("./testing/execution-loop-fixture");
  return {
    createGraphWorkflowManager: manager.createGraphWorkflowManager,
    createContextScheduler: scheduler.createContextScheduler,
    createExecutionLoopFixture: fixture.createExecutionLoopFixture,
    abortExecutionLoop: loop.abortExecutionLoop,
  };
}

/** The durable state every loop generation shares: the run, its disk, its log. */
interface Fixture {
  initial: GraphWorkflowExecution;
  repository: ReturnType<typeof createFencedRepository>;
  parallelWorktrees: GatedParallelWorktrees;
  session: SessionState;
  executionLogger: ReturnType<typeof createExecutionLogger>;
  /** Context ids handed to `runIteration`, across every generation. */
  dispatchedContextIds: string[];
}

/** One loop generation: a manager and a loop built from one module graph. */
interface Generation {
  manager: ReturnType<typeof createGraphWorkflowManager>;
  runLoop(execution: GraphWorkflowExecution): Promise<GraphWorkflowExecution>;
}

function createFixture(): Fixture {
  _resetActiveLoopsForTesting();
  _resetRegistryForTesting();

  // The execution id names the log directory, and every case in this file
  // runs in one worker against one config dir: a shared id would merge their
  // lifecycle.jsonl files and let one case's pause pair with another's resume.
  const initial = createStartedExecution(
    createSingleLaneDefinition(),
    `exec-pause-before-provisioning-${randomUUID()}`,
  );
  const repository = createFencedRepository(initial);
  const parallelWorktrees = createGatedParallelWorktrees();
  const session = createSession();
  // What a launch registers, so the pause has a lifecycle log to write to.
  const executionLogger = createExecutionLogger(initial.id);
  registerExecutionLogger(executionLogger);

  return {
    initial,
    repository,
    parallelWorktrees,
    session,
    executionLogger,
    dispatchedContextIds: [],
  };
}

/** The manager one route's module graph composes over the shared state. */
function createRouteManager(
  fixture: Fixture,
  modules: RouteModules,
): Generation["manager"] {
  return modules.createGraphWorkflowManager({
    abortConversation: () => {},
    stopExecutionLaneDevServers: async () => {},

    executionContract: createTestGraphExecutionContract(),

    executionRepository: fixture.repository,
    async loadDefinition() {
      return null;
    },

    async getSession() {
      return fixture.session;
    },
    abortExecutionLoop: modules.abortExecutionLoop,
  });
}

function createGeneration(fixture: Fixture, modules: RouteModules): Generation {
  const { parallelWorktrees, session } = fixture;
  const manager = createRouteManager(fixture, modules);

  const runIteration = async (input: {
    contextId: string;
  }): Promise<GraphWorkflowIterationResult> => {
    fixture.dispatchedContextIds.push(input.contextId);
    const next = await fixture.repository
      .mutateActive(PROJECT_PATH, SESSION_NAME, (e) => {
        const updated = structuredClone(e);
        const cs = updated.contextStates[input.contextId];
        if (cs) {
          cs.iterationCount = 1;
          cs.status = "completed";
          cs.completedTaskCount = 1;
        }
        const ts = updated.taskStates[`task-${input.contextId}`];
        if (ts) {
          ts.status = "completed";
          ts.completedAt = "2026-03-27T12:01:00.000Z";
        }
        return changed(updated);
      })
      .then((mutation) => mutation.execution);
    return {
      conversationId: `conv-${input.contextId}`,
      execution: next,
      decision: { kind: "ready_to_land" },
    };
  };

  const mergeMutex = createPerSessionMergeMutex();
  const sessionGitLock = createSessionGitLock({
    acquireSessionLock: () => () => {},
  });
  const loop = modules.createExecutionLoopFixture({
    executionContract: createTestGraphExecutionContract(),
    getSessionWorktreeDirtyPaths: async () => [],
    workflowManager: manager,
    executionRepository: fixture.repository,
    contextScheduler: modules.createContextScheduler({
      executionRepository: fixture.repository,
      parallelWorktrees,
      getSession: async () => session,
    }),
    iterationOrchestrator: { runIteration },
    parallelWorktrees,
    mergeMutex,
    sessionGitLock,
    joinRunner: createNoopJoinRunner(),
    soloContextCommitter: { commit: async () => ({ status: "skipped" }) },
    laneCommitter: {
      commit: async () => ({ status: "skipped" }),
      resolveHead: async () => null,
    },
    executionTargetResolver: createExecutionTargetResolver(),
    async getSession() {
      return session;
    },
    laneDriftAuditor: { audit: async () => ({ unattributedPaths: [] }) },
    resyncSharedIndex: async () => {},
    landingEvidenceProber: { probe: async () => new Map() },
    getMaxConcurrentQueries: async () => 4,
  });

  return {
    manager,
    runLoop: (execution) =>
      loop.run({
        projectPath: PROJECT_PATH,
        projectName: "test",
        sessionName: SESSION_NAME,
        execution,
      }),
  };
}

function expectPausedBeforeAnyLane(paused: GraphWorkflowExecution): void {
  expect(paused.status).toBe("paused");
  expect(Object.keys(paused.executionLanes)).toEqual([]);
  expect(paused.activeContextIds).toEqual([]);
  expect(
    Object.values(paused.contextStates).map((cs) => ({
      status: cs.status,
      iterationCount: cs.iterationCount,
    })),
  ).toEqual([{ status: "ready", iterationCount: 0 }]);
}

/** The resumed generation started the context and finished the run. */
function expectInitialBatchDispatched(
  fixture: Fixture,
  result: GraphWorkflowExecution,
): void {
  expect(fixture.dispatchedContextIds).toEqual(["ctx-1"]);
  expect(result.haltReason).toBeNull();
  expect(fixture.repository.read().haltReason).toBeNull();
  expect(result.status).toBe("completed");
  // The lane the context ran on is the one still on disk: no generation
  // disposed a worktree another one had adopted.
  expect(
    fixture.parallelWorktrees.worktreesOnDisk.has(LANE_WORKTREE_PATH),
  ).toBe(true);
}

/** lifecycle.jsonl keeps the pause and the resume as a pair with no halt between. */
function expectLifecyclePairHolds(fixture: Fixture): void {
  const lifecycle = readLifecycleEvents(fixture.executionLogger.logDir);
  expect(lifecycle.filter((event) => event === "execution.paused")).toEqual([
    "execution.paused",
  ]);
  expect(lifecycle.filter((event) => event === "execution.resumed")).toEqual([
    "execution.resumed",
  ]);
  const pausedAt = lifecycle.indexOf("execution.paused");
  const resumedAt = lifecycle.indexOf("execution.resumed");
  expect(resumedAt).toBeGreaterThan(pausedAt);
  const afterPause = lifecycle.slice(pausedAt);
  expect(afterPause).not.toContain("execution.halted");
  expect(afterPause).not.toContain("loop.recovery_error");
  expect(afterPause).not.toContain("loop.completion_blocked_incomplete");
}

/**
 * Block until the replacement generation has reached the lane: it has either
 * claimed it and is waiting its turn, or it has already tried to provision it
 * (or halted) — every branch is observable.
 */
async function waitForReplacementToReachLane(fixture: Fixture): Promise<void> {
  await waitFor(
    () =>
      fixture.repository.read().laneReservations["ctx-1"] !== undefined ||
      fixture.parallelWorktrees.provisionLaneCalls.length >= 2 ||
      fixture.repository.read().status !== "running",
    "the replacement generation to reach the lane",
  );
}

describe("execution loop — resume after a pause taken before any lane exists", () => {
  it("dispatches the initial batch on resume once the retired generation has exited", async () => {
    const fixture = createFixture();
    const generation = createGeneration(fixture, startRouteModules);
    const { manager } = generation;
    const { parallelWorktrees, repository, initial } = fixture;

    // Generation 0 starts and blocks inside the first lane provisioning.
    const retiredGeneration = generation.runLoop(initial);
    await parallelWorktrees.firstProvisionRequested;

    // The operator pauses before any lane exists or any context has started.
    const paused = await manager.send(PROJECT_PATH, SESSION_NAME, {
      type: "pause",
    });
    expectPausedBeforeAnyLane(paused);

    // The retired generation's provisioning returns into a fenced finalize and
    // its loop exits without touching the paused run.
    parallelWorktrees.releaseFirstProvision();
    await retiredGeneration;
    expect(fixture.dispatchedContextIds).toEqual([]);
    expect(repository.read().status).toBe("paused");
    expect(repository.read().haltReason).toBeNull();

    const resumed = await manager.resume(PROJECT_PATH, SESSION_NAME);
    expect(resumed.status).toBe("running");

    const result = await generation.runLoop(resumed);

    expectInitialBatchDispatched(fixture, result);
    expectLifecyclePairHolds(fixture);
    _resetRegistryForTesting();
    _resetActiveLoopsForTesting();
  });

  it("dispatches the initial batch when the replacement loop is kicked while the retired generation is still provisioning", async () => {
    // The resume route's ordering: pause only signals the retired loop, so the
    // operator can resume — and the route can kick the replacement loop —
    // while the retired scheduler is still inside `git worktree add` for the
    // lane the replacement has to mint.
    const fixture = createFixture();
    const generation = createGeneration(fixture, startRouteModules);
    const { manager } = generation;
    const { parallelWorktrees, initial } = fixture;

    const retiredGeneration = generation.runLoop(initial);
    await parallelWorktrees.firstProvisionRequested;

    const paused = await manager.send(PROJECT_PATH, SESSION_NAME, {
      type: "pause",
    });
    expectPausedBeforeAnyLane(paused);

    const resumed = await manager.resume(PROJECT_PATH, SESSION_NAME);
    expect(resumed.status).toBe("running");
    const replacementGeneration = generation.runLoop(resumed);

    await waitForReplacementToReachLane(fixture);
    parallelWorktrees.releaseFirstProvision();
    await retiredGeneration;

    const result = await replacementGeneration;

    expectInitialBatchDispatched(fixture, result);
    expectLifecyclePairHolds(fixture);
    _resetRegistryForTesting();
    _resetActiveLoopsForTesting();
  });

  it("records the pause and the resume as a pair and dispatches the initial batch when start, pause and resume each run in their own module graph, as the routes do", async () => {
    // Every graph-workflow route composes its own repository, manager, loop
    // and logger registry at module scope, and Next.js evaluates the routes
    // in separate module graphs: the start route, the pause route and the
    // resume route share only globalThis-hosted state. The lane serialization
    // has to be among it, or the replacement provisions the very lane the
    // retired scheduler is still creating; and so does the logger registry, or
    // the pause route never finds the logger the start route registered and
    // lifecycle.jsonl records the resume without its pause.
    const fixture = createFixture();
    const startRoute = createGeneration(fixture, startRouteModules);
    const { parallelWorktrees, initial } = fixture;

    const retiredGeneration = startRoute.runLoop(initial);
    await parallelWorktrees.firstProvisionRequested;

    const pauseRoute = createRouteManager(
      fixture,
      await loadSeparateRouteModules(),
    );
    const paused = await pauseRoute.send(PROJECT_PATH, SESSION_NAME, {
      type: "pause",
    });
    expectPausedBeforeAnyLane(paused);

    const resumeRoute = createGeneration(
      fixture,
      await loadSeparateRouteModules(),
    );
    const resumed = await resumeRoute.manager.resume(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(resumed.status).toBe("running");
    const replacementGeneration = resumeRoute.runLoop(resumed);

    await waitForReplacementToReachLane(fixture);
    parallelWorktrees.releaseFirstProvision();
    await retiredGeneration;

    const result = await replacementGeneration;

    expectInitialBatchDispatched(fixture, result);
    expectLifecyclePairHolds(fixture);
    _resetRegistryForTesting();
    _resetActiveLoopsForTesting();
  });
});
