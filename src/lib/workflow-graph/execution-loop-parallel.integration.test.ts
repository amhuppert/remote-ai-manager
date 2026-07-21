import { describe, expect, it, vi } from "vitest";
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
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import { applyJoinProgress } from "@/lib/workflow-graph/context-transitions";
import {
  createJoinRunner,
  type JoinRunner,
} from "@/lib/workflow-graph/join-runner";
import { createPerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import type { MergeOutput } from "@/lib/workflows/merge/types";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import type { MutateActiveResult } from "./execution-repository";
import {
  createGraphWorkflowExecutionLoop,
  _resetActiveLoopsForTesting,
} from "./execution-loop";
import { createGraphWorkflowSignalHaltHandler } from "@/lib/workflow-graph/graph-workflow-signal-halt";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";
import { createGraphWorkflowManager } from "./workflow-manager";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

interface InMemoryExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: {
      definition: WorkflowDefinitionRecord["definition"];
      definitionId: string;
      definitionRevision: number;
      executionId: string;
      startedAt: string;
      inputs: Record<string, string>;
    },
  ): Promise<GraphWorkflowExecution>;
  archiveActive(projectPath: string, sessionName: string): Promise<void>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  markContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number>;
}

function createRepository(
  initial: GraphWorkflowExecution | null,
  // Optional publisher the fake repository delivers through post-commit, exactly
  // as the real `createGraphWorkflowExecutionRepository` does: the reducer returns
  // inert `{ events, pushes }` DATA (never a callable), and delivery happens only
  // after the (fake) commit. Scenarios that assert on the broadcast spy inject
  // the same publisher they hand the loop so the derived events reach the spy.
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >,
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution | null } {
  let active = initial;
  let chain: Promise<unknown> = Promise.resolve();

  // Serialized read-modify-write backing the sync `mutateActive` — the reducer
  // is synchronous and returns inert delivery data, applied exactly as the
  // production seam does.
  const mutateActiveImpl = async (
    _p: string,
    _s: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> => {
    const previous = chain;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    chain = next;
    try {
      await previous;
      if (!active) {
        throw new Error("No active execution");
      }
      const result = fn(structuredClone(active));
      if ("execution" in result && "events" in result) {
        active = result.execution;
        // Mirror the production repository: broadcast the derived events only
        // AFTER the (fake) commit, through the injected publisher — never from a
        // callable the reducer returned (`post-commit-delivery`).
        eventPublisher?.deliver({
          events: result.events,
          pushes: result.pushes ?? [],
        });
      } else {
        active = result;
      }
      return active;
    } finally {
      release();
    }
  };

  return {
    async getActive() {
      return active;
    },
    async create() {
      throw new Error("create not used in integration tests");
    },
    async archiveActive() {
      throw new Error("archiveActive not used in integration tests");
    },
    mutateActive: mutateActiveImpl,
    async markContextEventsPreReset() {
      return 0;
    },
    read() {
      return active;
    },
  };
}

function createSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
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
    ...overrides,
  } as unknown as SessionState;
}

interface ParallelWorktreesStub extends ParallelWorktrees {
  provisionCalls: ProvisionInput[];
  disposeCalls: DisposeInput[];
  cleanupLaneCalls: CleanupLaneInput[];
}

function createParallelWorktreesStub(): ParallelWorktreesStub {
  const provisionCalls: ProvisionInput[] = [];
  const disposeCalls: DisposeInput[] = [];
  const cleanupLaneCalls: CleanupLaneInput[] = [];

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    provisionCalls.push(input);
    return {
      worktreePath: `${input.projectPath}/.worktrees/${input.sessionDir}.${input.contextId}`,
      branchName: `csm/${input.sessionDir}-${input.contextId}`,
    };
  }

  async function provisionBatch(
    inputs: ProvisionInput[],
  ): Promise<ProvisionResult[]> {
    const results: ProvisionResult[] = [];
    for (const input of inputs) {
      results.push(await provision(input));
    }
    return results;
  }

  async function dispose(input: DisposeInput): Promise<DisposeResult> {
    disposeCalls.push(input);
    return { status: "removed" };
  }

  async function provisionLane(
    input: ProvisionLaneInput,
  ): Promise<ProvisionResult> {
    return provision({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      sessionDir: input.sessionDir,
      sessionBranch: input.sessionBranch,
      contextId: input.laneId,
    });
  }

  async function provisionLaneBatch(
    inputs: ProvisionLaneInput[],
  ): Promise<ProvisionResult[]> {
    const results: ProvisionResult[] = [];
    for (const input of inputs) {
      results.push(await provisionLane(input));
    }
    return results;
  }

  async function disposeLane(input: DisposeInput): Promise<DisposeResult> {
    return dispose(input);
  }

  async function cleanupLane(input: CleanupLaneInput): Promise<DisposeResult> {
    cleanupLaneCalls.push(input);
    return { status: "removed" };
  }

  return {
    provision,
    provisionBatch,
    dispose,
    provisionLane,
    provisionLaneBatch,
    disposeLane,
    cleanupLane,
    provisionCalls,
    disposeCalls,
    cleanupLaneCalls,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createParallelDefinition(
  contextIds: string[],
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: contextIds.map((id) => ({
      id,
      title: `Context ${id}`,
      description: `${id} description`,
      acceptanceCriteria: "TBD",
      implementer: {
        backend: "claude",
        model: "sonnet",
        reasoningEffort: "medium",
      },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
    })),
    tasks: contextIds.map((id) => ({
      id: `task-${id}`,
      contextId: id,
      order: 1,
      title: `Task ${id}`,
      instructions: `Do work for ${id}`,
      source: "user" as const,
    })),
    edges: [],
  };
}

function createInitialExecution(
  definition: WorkflowSemanticDefinition,
): GraphWorkflowExecution {
  const contextIds = definition.executionContexts.map((c) => c.id);
  const contextStates: GraphWorkflowExecution["contextStates"] = {};
  const taskStates: GraphWorkflowExecution["taskStates"] = {};
  for (const id of contextIds) {
    contextStates[id] = {
      pendingApproval: null,
      pendingUserInput: null,
      contextId: id,
      status: "pending",
      totalTaskCount: 1,
      completedTaskCount: 0,
      iterationCount: 0,
      consecutiveFailureCount: 0,
      worktreePath: null,
      branchName: null,
      isolation: "session",
      batchId: null,
      laneId: null,
      joinId: null,
      mergeStatus: "not-applicable",
      cleanupStatus: "not-applicable",
      lastMergeError: null,
    };
    taskStates[`task-${id}`] = {
      taskId: `task-${id}`,
      contextId: id,
      order: 1,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      failureMessage: null,
      failureHistory: [],
    };
  }

  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    liveRevision: 1,
    loopEpoch: 0,
    boundInputs: {},
    launchedTier: "project",
    definitionApproval: null,
    workingDefinition:
      definition as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: [],
    contextStates,
    taskStates,
    sharedDocuments: [],
    laneStates: {},
    executionLanes: {},
    joins: {},
    lanePlan: { continuationMap: {}, longestDownstreamPath: {} },
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

function buildSuccessMergeOutput(): MergeOutput {
  return {
    status: "completed",
    mergeHash: "merge-hash",
    commitHash: "commit-hash",
    error: null,
    conflictFiles: [],
    conflictAnalysis: null,
    preparedSha: null,
    expectedTargetSha: null,
    parkedRef: null,
    refreshWarning: null,
    candidateValidation: null,
    haltReason: null,
    phase: null,
  };
}

function buildFailedMergeOutput(message: string): MergeOutput {
  return {
    status: "failed",
    mergeHash: null,
    commitHash: null,
    error: message,
    conflictFiles: [],
    conflictAnalysis: null,
    preparedSha: null,
    expectedTargetSha: null,
    parkedRef: null,
    refreshWarning: null,
    candidateValidation: null,
    haltReason: null,
    phase: null,
  };
}

function createNoopJoinRunner(): JoinRunner {
  return {
    async run({ joinId, mutateActive }) {
      await mutateActive((e) =>
        applyJoinProgress(e, joinId, new Date().toISOString(), {
          status: "succeeded",
        }),
      );
      return { status: "succeeded" };
    },
  };
}

describe("execution loop — parallel integration", () => {
  it("scenario 1: two siblings finish A→B, both merges succeed", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
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
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    // Sibling lanes publish through the quiescence final_publish join (never
    // per-completion fan-in), so the observable merges are the lane branches
    // landing on the session in deterministic sorted order.
    const mergeOrder: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        mergeOrder.push(input.branchName);
        return buildSuccessMergeOutput();
      },
    };
    const mergeMutex = createPerSessionMergeMutex();
    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => () => {},
    });

    const soloCommitCalls: string[] = [];
    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: createJoinRunner({ mergeRunner, sessionGitLock, mergeMutex }),
      soloContextCommitter: {
        commit: async (input) => {
          soloCommitCalls.push(input.contextId);
          return { status: "skipped" };
        },
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("ctx-a")!.resolve();
    setTimeout(() => completionGates.get("ctx-b")!.resolve(), 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(mergeOrder).toEqual(["csm/session-1-ctx-a", "csm/session-1-ctx-b"]);
    expect(soloCommitCalls).toEqual([]);
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["ctx-a", "ctx-b"]);
    // Published lanes are cleaned through the lane-cleanup path on completion.
    expect(
      parallelWorktrees.cleanupLaneCalls.map((c) => c.branchName).sort(),
    ).toEqual(["csm/session-1-ctx-a", "csm/session-1-ctx-b"]);
    const finalJoin = Object.values(result.joins).find(
      (join) => join.kind === "final_publish",
    );
    expect(finalJoin?.status).toBe("succeeded");
    expect([...(finalJoin?.mergedSourceLaneIds ?? [])].sort()).toEqual([
      "ctx-a",
      "ctx-b",
    ]);
    for (const ctxId of ["ctx-a", "ctx-b"]) {
      const cs = result.contextStates[ctxId];
      expect(cs?.mergeStatus).toBe("merged-success");
      expect(cs?.lastMergeError).toBeNull();
    }
  });

  it("scenario 1b: never runs more than maxConcurrentQueries contexts at once across a wide parallel batch", async () => {
    // Regression for the workflow stall: four sibling contexts are all eligible
    // at once, but with a query-concurrency limit of 2 the loop must run them as
    // a sliding window of at most 2 — never dispatching all four (which would
    // over-subscribe the global query semaphore and leave the surplus queued
    // until they time out). All four must still complete.
    _resetActiveLoopsForTesting();

    const contextIds = ["ctx-a", "ctx-b", "ctx-c", "ctx-d"];
    const definition = createParallelDefinition(contextIds);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    // All gates open immediately: the only thing bounding how many contexts run
    // concurrently is the loop's capacity bound, not the gates.
    const completionGates = new Map<string, Deferred<void>>(
      contextIds.map(
        (id) => [id, deferred<void>()] as [string, Deferred<void>],
      ),
    );
    for (const gate of completionGates.values()) gate.resolve();

    let current = 0;
    let maxConcurrent = 0;
    const ranContexts = new Set<string>();
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        ranContexts.add(input.contextId);
        try {
          await completionGates.get(input.contextId)!.promise;
          const next = await manager.mutateActive("/repo", "session-1", (e) => {
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
            return updated;
          });
          return {
            conversationId: `conv-${input.contextId}`,
            execution: next,
            shouldContinueInContext: false,
          };
        } finally {
          current -= 1;
        }
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      getMaxConcurrentQueries: async () => 2,
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect([...ranContexts].sort()).toEqual(contextIds);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("scenario 2: two siblings finish B→A, both merges succeed", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
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
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    // Lanes publish only at quiescence, so completion order (B before A)
    // cannot influence the publish order: the final_publish join merges the
    // lane branches in deterministic sorted order either way.
    const mergeOrder: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        mergeOrder.push(input.branchName);
        return buildSuccessMergeOutput();
      },
    };
    const mergeMutex = createPerSessionMergeMutex();
    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => () => {},
    });

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: createJoinRunner({ mergeRunner, sessionGitLock, mergeMutex }),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("ctx-b")!.resolve();
    setTimeout(() => completionGates.get("ctx-a")!.resolve(), 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(mergeOrder).toEqual(["csm/session-1-ctx-a", "csm/session-1-ctx-b"]);
    for (const ctxId of ["ctx-a", "ctx-b"]) {
      expect(result.contextStates[ctxId]?.mergeStatus).toBe("merged-success");
    }
    expect(
      parallelWorktrees.cleanupLaneCalls.map((c) => c.branchName).sort(),
    ).toEqual(["csm/session-1-ctx-a", "csm/session-1-ctx-b"]);
  });

  it("scenario 3: B's merge auto-resolves trivial conflicts; both succeed", async () => {
    _resetActiveLoopsForTesting();

    // From the loop's perspective the merge runner abstracts conflict
    // resolution: "completed" means the underlying merge machine (or its
    // resolveConflictsActor) succeeded. So this test is structurally identical
    // to scenario 1 — its purpose is to pin that the loop accepts a "completed"
    // status from the runner regardless of whether the underlying machine had
    // to resolve conflicts.
    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    for (const ctxId of ["ctx-a", "ctx-b"]) {
      expect(result.contextStates[ctxId]?.mergeStatus).toBe("merged-success");
    }
  });

  it("scenario 4: B's merge fails (auto-resolve exhausts), A merged, drains, halted with merge_failure, B's worktree retained", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    // B's lane branch fails to publish; A's lane publishes first (sorted
    // order), so the final_publish join fails partway with A already merged.
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        if (input.branchName === "csm/session-1-ctx-b") {
          return buildFailedMergeOutput("auto-resolution exhausted");
        }
        return buildSuccessMergeOutput();
      },
    };
    const mergeMutex = createPerSessionMergeMutex();
    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => () => {},
    });

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: createJoinRunner({ mergeRunner, sessionGitLock, mergeMutex }),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("ctx-a")!.resolve();
    setTimeout(() => completionGates.get("ctx-b")!.resolve(), 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("join_failure");
    if (result.haltReason?.type === "join_failure") {
      expect(result.haltReason.joinKind).toBe("final_publish");
      expect(result.haltReason.message).toBe("auto-resolution exhausted");
    }
    const finalJoin = Object.values(result.joins).find(
      (join) => join.kind === "final_publish",
    );
    expect(finalJoin?.status).toBe("failed");
    expect(finalJoin?.mergedSourceLaneIds).toEqual(["ctx-a"]);
    expect(finalJoin?.errorMessage).toBe("auto-resolution exhausted");

    // Both lanes are retained for forensics/resume: cleanup only runs on
    // completion, never on a halt.
    const disposeBranches = parallelWorktrees.disposeCalls.map(
      (c) => c.branchName,
    );
    expect(disposeBranches).not.toContain("csm/session-1-ctx-a");
    expect(disposeBranches).not.toContain("csm/session-1-ctx-b");
    expect(parallelWorktrees.cleanupLaneCalls).toEqual([]);
  });

  it("scenario 5: three siblings — A halts via circuit breaker; B and C merge; halted with circuit_breaker (not merge_failure)", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b", "ctx-c"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
      ["ctx-c", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        if (input.contextId === "ctx-a") {
          // A's iteration trips the circuit breaker (consecutiveFailureCount >= threshold)
          const next = await manager.mutateActive("/repo", "session-1", (e) => {
            const updated = structuredClone(e);
            const cs = updated.contextStates["ctx-a"];
            if (cs) {
              cs.iterationCount = 1;
              cs.consecutiveFailureCount = 3;
            }
            return updated;
          });
          return {
            conversationId: "conv-a",
            execution: next,
            shouldContinueInContext: true,
          };
        }
        // B and C complete normally
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    // A halts first; then B and C complete normally
    completionGates.get("ctx-a")!.resolve();
    setTimeout(() => {
      completionGates.get("ctx-b")!.resolve();
      completionGates.get("ctx-c")!.resolve();
    }, 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    // First-failure-wins: circuit_breaker recorded by A is not overwritten by
    // any later merge_failure or recovery_error.
    expect(result.haltReason?.type).toBe("circuit_breaker");
    if (result.haltReason?.type === "circuit_breaker") {
      expect(result.haltReason.contextId).toBe("ctx-a");
    }
    // B and C completed and merged before the drain.
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-c"]?.mergeStatus).toBe("merged-success");
  });

  it("scenario 5c: one sibling's pending halt stops the other sibling from looping to maxIterations", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const runIterationCalls: string[] = [];
    // ctx-b only proceeds once ctx-a has recorded the halt, so ctx-b's first
    // iteration deterministically observes pendingHaltReason.
    const haltRecorded = deferred<void>();

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        if (input.contextId === "ctx-a") {
          const result = await manager.recordPendingHaltReason({
            projectPath: "/repo",
            sessionName: "session-1",
            reason: {
              type: "collaboration_failure",
              status: "objective_disagreement",
              brief: "ctx-a is blocked",
              executionContextId: "ctx-a",
              conversationId: "conv-a",
              summary: "ctx-a is blocked",
            },
          });
          haltRecorded.resolve();
          return {
            conversationId: "conv-a",
            execution: result.execution,
            shouldContinueInContext: false,
          };
        }
        // ctx-b always has remaining work and would loop forever without the
        // pending-halt guard. It clones the latest execution (now carrying
        // pendingHaltReason), so the loop must stop after a single iteration.
        await haltRecorded.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates["ctx-b"];
          if (cs) cs.iterationCount += 1;
          return updated;
        });
        return {
          conversationId: "conv-b",
          execution: next,
          shouldContinueInContext: true,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("collaboration_failure");
    // The guard stops ctx-b after its first iteration instead of spinning to
    // maxIterations (5). Without the fix this is 5.
    expect(runIterationCalls.filter((c) => c === "ctx-b")).toHaveLength(1);
    // ctx-b never completed, so it must not have committed/merged.
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("not-applicable");
  });

  it("scenario 5b: orchestrator signalHalt records pending halt, skips failed sibling merge, and drains successful siblings", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });
    const signalHalt = createGraphWorkflowSignalHaltHandler(manager);

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        if (input.contextId === "ctx-a") {
          const execution = await signalHalt({
            projectPath: "/repo",
            sessionName: "session-1",
            reason: {
              type: "circuit_breaker",
              contextId: "ctx-a",
              condition: "retry_exhaustion",
              failureCount: 3,
              summary: null,
            },
          });
          return {
            conversationId: "conv-a",
            execution,
            shouldContinueInContext: false,
          };
        }

        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) {
            ts.status = "completed";
          }
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeOrder: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        mergeOrder.push(input.contextId);
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("ctx-a")!.resolve();
    setTimeout(() => completionGates.get("ctx-b")!.resolve(), 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "circuit_breaker",
      contextId: "ctx-a",
    });
    // The pending halt drains before the quiescence publish runs, so no lane
    // is published while halted; B's completed work stays committed on its
    // lane, retained for resume.
    expect(mergeOrder).toEqual([]);
    expect(result.contextStates["ctx-a"]?.status).toBe("halted");
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("not-applicable");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
    expect(parallelWorktrees.disposeCalls).toEqual([]);
    expect(parallelWorktrees.cleanupLaneCalls).toEqual([]);
  });

  it("scenario 6: process crash mid-drain — restart resumes to halted with original reason via normalizeAfterRestart", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    // Record a halt reason but never call drainAndHalt — simulating a crash
    // between recordPendingHaltReason and drainAndHalt.
    const haltReason: GraphWorkflowHaltReason = {
      type: "recovery_error",
      message: "simulated crash before drain",
    };
    const result = await manager.recordPendingHaltReason({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: haltReason,
    });

    expect(result.accepted).toBe(true);
    expect(result.execution.pendingHaltReason).toEqual(haltReason);
    expect(result.execution.status).toBe("running");

    // The persisted record carries pendingHaltReason and status=running
    // (the in-flight loop never reached drainAndHalt before the crash).
    const persisted = repository.read();
    expect(persisted?.pendingHaltReason).toEqual(haltReason);
    expect(persisted?.status).toBe("running");

    // Process restart: the route handler invokes normalizeAfterRestart on the
    // first request to the session. With pendingHaltReason set, normalization
    // must transition cleanly to halted using the persisted reason — not
    // pause it (which would lose the cause).
    const normalized = await manager.normalizeAfterRestart(
      "/repo",
      "session-1",
    );

    expect(normalized?.status).toBe("halted");
    expect(normalized?.haltReason).toEqual(haltReason);
    expect(normalized?.pendingHaltReason).toBeNull();

    // The persisted record now reflects the halted state — a second
    // normalize call is a no-op.
    const afterRestart = repository.read();
    expect(afterRestart?.status).toBe("halted");
    expect(afterRestart?.haltReason).toEqual(haltReason);
    expect(afterRestart?.pendingHaltReason).toBeNull();

    const idempotent = await manager.normalizeAfterRestart(
      "/repo",
      "session-1",
    );
    expect(idempotent?.status).toBe("halted");
    expect(idempotent?.haltReason).toEqual(haltReason);
  });

  it("scenario 7: solo-eligible context — no worktree provisioned, no merge invoked", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-solo"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      run: vi.fn(),
    };

    const soloCommitCalls: string[] = [];
    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async (input) => {
          soloCommitCalls.push(input.contextId);
          return { status: "committed", hash: "abc" };
        },
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
      sessionLaneEnabled: true,
    });

    expect(result.status).toBe("completed");
    expect(parallelWorktrees.provisionCalls).toEqual([]);
    expect(parallelWorktrees.disposeCalls).toEqual([]);
    expect(mergeRunner.run).not.toHaveBeenCalled();
    expect(soloCommitCalls).toEqual(["ctx-solo"]);
    const cs = result.contextStates["ctx-solo"];
    expect(cs?.isolation).toBe("session");
    expect(cs?.worktreePath).toBeNull();
    expect(cs?.branchName).toBeNull();
    expect(cs?.mergeStatus).toBe("not-applicable");
  });

  it("scenario 8: user merge job overlaps the final publish — the publish join waits on the session git lock", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    let userJobReleasedAt = 0;
    let lockHeld = true;
    setTimeout(() => {
      lockHeld = false;
      userJobReleasedAt = Date.now();
    }, 30);

    const publishTimes: Array<{ branchName: string; ts: number }> = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        publishTimes.push({ branchName: input.branchName, ts: Date.now() });
        return buildSuccessMergeOutput();
      },
    };

    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => {
        if (lockHeld) {
          throw new Error("session locked");
        }
        return () => {};
      },
      retryMs: 5,
      maxWaitMs: 5000,
    });
    const mergeMutex = createPerSessionMergeMutex();

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: createJoinRunner({ mergeRunner, sessionGitLock, mergeMutex }),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(lockHeld).toBe(false);
    expect(publishTimes).toHaveLength(2);
    // Both lane publishes ran AFTER the user job released the lock.
    for (const entry of publishTimes) {
      expect(entry.ts).toBeGreaterThanOrEqual(userJobReleasedAt);
    }
    // Both publishes succeeded.
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
  });

  it("scenario 9: A's lane publishes; B's publish returns ready-to-land (dirty target), the publish join halts, and both worktrees are retained for later Land/Discard", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["ctx-a", deferred()],
      ["ctx-b", deferred()],
    ]);

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        if (input.branchName === "csm/session-1-ctx-b") {
          return {
            status: "ready-to-land",
            mergeHash: null,
            commitHash: null,
            error: null,
            conflictFiles: [],
            conflictAnalysis: null,
            preparedSha: "abc123prepared",
            expectedTargetSha: "expected-target-sha",
            parkedRef: `refs/cc-merges/${input.jobId}`,
            refreshWarning: null,
            candidateValidation: null,
            haltReason: null,
            phase: "awaiting-land",
          };
        }
        return buildSuccessMergeOutput();
      },
    };
    const mergeMutex = createPerSessionMergeMutex();
    const sessionGitLock = createSessionGitLock({
      acquireSessionLock: () => () => {},
    });

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex,
      sessionGitLock,
      mergeRunner,
      joinRunner: createJoinRunner({ mergeRunner, sessionGitLock, mergeMutex }),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("ctx-a")!.resolve();
    setTimeout(() => completionGates.get("ctx-b")!.resolve(), 5);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    // A parked ready-to-land candidate needs a human Land/Discard, so the
    // publish join halts rather than completing around it.
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("join_failure");
    const finalJoin = Object.values(result.joins).find(
      (join) => join.kind === "final_publish",
    );
    expect(finalJoin?.status).toBe("failed");
    expect(finalJoin?.mergedSourceLaneIds).toEqual(["ctx-a"]);

    // Both worktrees are retained: ctx-b's parked ref needs Land/Discard and
    // halts never clean lanes.
    const disposeBranches = parallelWorktrees.disposeCalls.map(
      (c) => c.branchName,
    );
    expect(disposeBranches).not.toContain("csm/session-1-ctx-a");
    expect(disposeBranches).not.toContain("csm/session-1-ctx-b");
    expect(parallelWorktrees.cleanupLaneCalls).toEqual([]);
  });

  it("scenario 10: P1 Foundation, P2, and P3 start; once P1 Foundation lands, P1 Data Layer is scheduled in worktree isolation while P2 and P3 are still in flight (guarded event-driven scheduling)", async () => {
    _resetActiveLoopsForTesting();

    const contextIds = ["p1-foundation", "p1-data-layer", "p2", "p3"] as const;
    const definition: WorkflowSemanticDefinition = {
      schemaVersion: 1,
      workflowConfig: {},
      charter: makeTestCharter(),
      parameters: [],
      prerequisites: [],
      executionContexts: contextIds.map((id) => ({
        id,
        title: `Context ${id}`,
        description: `${id} description`,
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      })),
      tasks: contextIds.map((id) => ({
        id: `task-${id}`,
        contextId: id,
        order: 1,
        title: `Task ${id}`,
        instructions: `Do work for ${id}`,
        source: "user" as const,
      })),
      edges: [
        {
          id: "p1-foundation->p1-data-layer",
          sourceContextId: "p1-foundation",
          targetContextId: "p1-data-layer",
        },
      ],
    };

    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>(
      contextIds.map((id) => [id, deferred()]),
    );

    const p1DataLayerSnapshots: GraphWorkflowExecution[] = [];

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        if (input.contextId === "p1-data-layer") {
          const snap = repository.read();
          if (!snap) throw new Error("repository empty during data-layer run");
          p1DataLayerSnapshots.push(structuredClone(snap));
          completionGates.get("p2")!.resolve();
          completionGates.get("p3")!.resolve();
        }
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("p1-foundation")!.resolve();
    completionGates.get("p1-data-layer")!.resolve();

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(p1DataLayerSnapshots).toHaveLength(1);
    const snapshot = p1DataLayerSnapshots[0]!;

    const dataLayerStateAtSchedule = snapshot.contextStates["p1-data-layer"];
    expect(dataLayerStateAtSchedule?.isolation).toBe("worktree");
    // Sequential lane reuse: the downstream inherits its upstream's lane
    // rather than provisioning a fresh worktree.
    expect(dataLayerStateAtSchedule?.laneId).toBe("p1-foundation");
    expect(dataLayerStateAtSchedule?.worktreePath).toBe(
      "/repo/.worktrees/session-1.p1-foundation",
    );
    expect(dataLayerStateAtSchedule?.branchName).toBe(
      "csm/session-1-p1-foundation",
    );
    expect(dataLayerStateAtSchedule?.status).toBe("running");
    expect(snapshot.contextStates["p2"]?.status).toBe("running");
    expect(snapshot.contextStates["p3"]?.status).toBe("running");
    expect(snapshot.activeContextIds).toEqual(
      expect.arrayContaining(["p1-data-layer", "p2", "p3"]),
    );

    expect(result.status).toBe("completed");
    const provisionedContextIds = parallelWorktrees.provisionCalls.map(
      (c) => c.contextId,
    );
    expect(provisionedContextIds).not.toContain("p1-data-layer");

    for (const ctxId of contextIds) {
      const cs = result.contextStates[ctxId];
      expect(cs?.isolation).toBe("worktree");
      expect(cs?.mergeStatus).toBe("merged-success");
    }
    // All three lanes published through the final join and were cleaned up.
    expect(
      parallelWorktrees.cleanupLaneCalls.map((c) => c.branchName).sort(),
    ).toEqual([
      "csm/session-1-p1-foundation",
      "csm/session-1-p2",
      "csm/session-1-p3",
    ]);
  });

  it("scenario 11: pendingHaltReason from one sibling's merge failure prevents scheduling any newly eligible downstream context, and the remaining in-flight siblings drain before the loop halts", async () => {
    _resetActiveLoopsForTesting();

    const contextIds = ["p1", "p1-child", "p2", "p3"] as const;
    const definition: WorkflowSemanticDefinition = {
      schemaVersion: 1,
      workflowConfig: {},
      charter: makeTestCharter(),
      parameters: [],
      prerequisites: [],
      executionContexts: contextIds.map((id) => ({
        id,
        title: `Context ${id}`,
        description: `${id} description`,
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      })),
      tasks: contextIds.map((id) => ({
        id: `task-${id}`,
        contextId: id,
        order: 1,
        title: `Task ${id}`,
        instructions: `Do work for ${id}`,
        source: "user" as const,
      })),
      edges: [
        {
          id: "p1->p1-child",
          sourceContextId: "p1",
          targetContextId: "p1-child",
        },
      ],
    };

    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const completionGates = new Map<string, Deferred<void>>([
      ["p1", deferred()],
      ["p1-child", deferred()],
      ["p2", deferred()],
      ["p3", deferred()],
    ]);

    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        await completionGates.get(input.contextId)!.promise;
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.status = "completed";
            cs.completedTaskCount = 1;
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    // The mid-run failure is a lane-commit failure: under the lane model no
    // session merges run mid-wave, so a failing lane commit is what records
    // the pending merge_failure halt while siblings are still in flight.
    const mergeRunner: GraphMergeRunner = {
      async run() {
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async (input) =>
          input.contextId === "p2"
            ? {
                status: "failed",
                errorMessage: "simulated p2 lane-commit failure",
              }
            : { status: "skipped" },
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    completionGates.get("p2")!.resolve();
    setTimeout(() => {
      completionGates.get("p1")!.resolve();
    }, 15);
    setTimeout(() => {
      completionGates.get("p3")!.resolve();
    }, 30);

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("merge_failure");
    if (result.haltReason?.type === "merge_failure") {
      expect(result.haltReason.contextId).toBe("p2");
    }

    expect(runIterationCalls).not.toContain("p1-child");
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId),
    ).not.toContain("p1-child");

    expect(result.contextStates["p1-child"]?.status).toBe("pending");
    expect(result.contextStates["p1-child"]?.isolation).toBe("session");
    expect(result.contextStates["p1-child"]?.worktreePath).toBeNull();
    expect(result.contextStates["p1-child"]?.mergeStatus).toBe(
      "not-applicable",
    );

    expect(result.contextStates["p1"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["p3"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["p2"]?.mergeStatus).toBe("merged-failed");
    expect(result.contextStates["p2"]?.lastMergeError).toBe(
      "simulated p2 lane-commit failure",
    );
  });

  it("scenario 12: a gated context parks in the wait while an independent sibling completes and merges, its dependent never starts, the loop stays in-flight, and abort exits the wait unresolved", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b", "ctx-c"]);
    definition.executionContexts.find(
      (ctx) => ctx.id === "ctx-a",
    )!.humanApprovalGate = { enabled: true };
    definition.edges = [
      {
        id: "ctx-a->ctx-c",
        sourceContextId: "ctx-a",
        targetContextId: "ctx-c",
      },
    ];

    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const pendingApprovalRecord = {
      conversationId: "conv-ctx-a",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: null,
    };

    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.completedTaskCount = 1;
            if (input.contextId === "ctx-a") {
              cs.status = "awaiting_approval";
              cs.pendingApproval = structuredClone(pendingApprovalRecord);
            } else {
              cs.status = "completed";
            }
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeOrder: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        mergeOrder.push(input.contextId);
        return buildSuccessMergeOutput();
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForApprovalProgress: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });

    const runPromise = loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await vi.waitFor(() => {
      const current = repository.read();
      expect(current?.contextStates["ctx-b"]?.mergeStatus).toBe(
        "merged-success",
      );
      expect(current?.contextStates["ctx-a"]?.status).toBe("awaiting_approval");
    });

    expect(runIterationCalls.filter((id) => id === "ctx-a")).toHaveLength(1);
    expect(runIterationCalls).toContain("ctx-b");
    expect(runIterationCalls).not.toContain("ctx-c");
    // ctx-b's work is lane-committed; its publish waits for quiescence, which
    // the parked gate prevents — so no session merge runs.
    expect(mergeOrder).toEqual([]);

    const raceOutcome = await Promise.race([
      runPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 30),
      ),
    ]);
    expect(raceOutcome).toBe("pending");

    await manager.send("/repo", "session-1", { type: "abort" });

    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.contextStates["ctx-a"]?.status).toBe("awaiting_approval");
    expect(result.contextStates["ctx-a"]?.pendingApproval).toEqual(
      pendingApprovalRecord,
    );
    expect(result.contextStates["ctx-c"]?.status).toBe("pending");
    expect(runIterationCalls).not.toContain("ctx-c");
    expect(mergeOrder).toEqual([]);
    // The abort retains ctx-b's unpublished lane for forensics/resume.
    expect(parallelWorktrees.disposeCalls).toEqual([]);
  });

  it("scenario 13: approving a parked gated context applies the decision under the conversation lock, merges while holding it, records approval-resolved, and unblocks the dependent", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b", "ctx-c"]);
    definition.executionContexts.find(
      (ctx) => ctx.id === "ctx-a",
    )!.humanApprovalGate = { enabled: true };
    definition.edges = [
      {
        id: "ctx-a->ctx-c",
        sourceContextId: "ctx-a",
        targetContextId: "ctx-c",
      },
    ];

    const initial = createInitialExecution(definition);
    // One publisher shared by the fake repository (which delivers post-commit)
    // and the loop (which derives the events): the broadcast spy sees exactly
    // what the production seam would broadcast after the transaction commits.
    const broadcast = vi.fn();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-27T12:03:00.000Z",
    });
    const repository = createRepository(initial, eventPublisher);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.completedTaskCount = 1;
            if (input.contextId === "ctx-a" && cs.pendingApproval === null) {
              cs.status = "awaiting_approval";
              cs.pendingApproval = {
                conversationId: "conv-ctx-a",
                requestedAt: "2026-03-27T12:01:00.000Z",
                decision: null,
              };
            } else {
              cs.status = "completed";
            }
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const ordered: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        ordered.push(`merge:${input.contextId}`);
        return buildSuccessMergeOutput();
      },
    };
    const orderedLaneCommitter = {
      commit: async (input: { contextId: string }) => {
        ordered.push(`lane-commit:${input.contextId}`);
        return { status: "skipped" as const };
      },
      resolveHead: async () => null,
    };

    const waitForApprovalProgress = vi.fn(async () => {
      await manager.mutateActive("/repo", "session-1", (e) => {
        const next = structuredClone(e);
        const record = next.contextStates["ctx-a"]?.pendingApproval;
        if (record && record.decision === null) {
          record.decision = {
            type: "approved",
            decidedAt: "2026-03-27T12:02:00.000Z",
          };
        }
        return next;
      });
    });

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: orderedLaneCommitter,
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForApprovalProgress,
      isConversationBusy: () => false,
      acquireConversationLock: (_projectPath, _sessionName, conversationId) => {
        ordered.push(`lock-acquired:${conversationId}`);
        return () => {
          ordered.push("lock-released");
        };
      },
      eventPublisher,
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(result.contextStates["ctx-a"]?.status).toBe("completed");
    expect(result.contextStates["ctx-a"]?.pendingApproval).toBeNull();
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-c"]?.status).toBe("completed");
    expect(runIterationCalls).toContain("ctx-c");
    expect(runIterationCalls.filter((id) => id === "ctx-a")).toHaveLength(1);

    // ctx-a's commit phase (its lane commit) runs inside the held
    // conversation lock window; the session publish itself waits for
    // quiescence.
    const lockAcquiredAt = ordered.indexOf("lock-acquired:conv-ctx-a");
    const laneCommitAt = ordered.indexOf("lane-commit:ctx-a");
    const lockReleasedAt = ordered.indexOf("lock-released");
    expect(lockAcquiredAt).toBeGreaterThanOrEqual(0);
    expect(laneCommitAt).toBeGreaterThan(lockAcquiredAt);
    expect(lockReleasedAt).toBeGreaterThan(laneCommitAt);

    const resolvedEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-approval-resolved");
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      contextId: "ctx-a",
      conversationId: "conv-ctx-a",
      decision: "approved",
      message: null,
      decidedAt: "2026-03-27T12:02:00.000Z",
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-approval-resolved",
        contextId: "ctx-a",
        decision: "approved",
      }),
    );
  });

  it("scenario 14: resuming a persisted parked context re-enters the gate wait directly, applies the decision recorded while suspended, merges under the lock, and unblocks the dependent", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-c"]);
    definition.executionContexts.find(
      (ctx) => ctx.id === "ctx-a",
    )!.humanApprovalGate = { enabled: true };
    definition.edges = [
      {
        id: "ctx-a->ctx-c",
        sourceContextId: "ctx-a",
        targetContextId: "ctx-c",
      },
    ];

    // The execution was parked at the gate, paused (e.g. restart), had an
    // approval recorded while suspended, and has just been resumed: the
    // parked context's gate record and worktree assignment are persisted,
    // and the status is back to running.
    const initial = createInitialExecution(definition);
    const parked = initial.contextStates["ctx-a"]!;
    parked.status = "awaiting_approval";
    parked.iterationCount = 1;
    parked.completedTaskCount = 1;
    parked.worktreePath = "/repo/.worktrees/session-1.ctx-a";
    parked.branchName = "csm/session-1-ctx-a";
    parked.isolation = "worktree";
    parked.pendingApproval = {
      conversationId: "conv-ctx-a",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: {
        type: "approved",
        decidedAt: "2026-03-27T12:02:00.000Z",
      },
    };
    initial.taskStates["task-ctx-a"]!.status = "completed";

    // One publisher shared by the fake repository (post-commit delivery) and the
    // loop (event derivation) so the broadcast spy sees exactly what the seam
    // would broadcast after the transaction commits.
    const broadcast = vi.fn();
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-27T12:03:00.000Z",
    });
    const repository = createRepository(initial, eventPublisher);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.completedTaskCount = 1;
            cs.status = "completed";
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const ordered: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        ordered.push(`merge:${input.contextId}`);
        return buildSuccessMergeOutput();
      },
    };

    const waitForApprovalProgress = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForApprovalProgress,
      isConversationBusy: () => false,
      acquireConversationLock: (_projectPath, _sessionName, conversationId) => {
        ordered.push(`lock-acquired:${conversationId}`);
        return () => {
          ordered.push("lock-released");
        };
      },
      eventPublisher,
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    // The parked context never re-runs an iteration: it re-enters the gate
    // wait directly and the suspended-recorded decision applies immediately.
    expect(runIterationCalls).not.toContain("ctx-a");
    expect(runIterationCalls).toContain("ctx-c");

    expect(result.contextStates["ctx-a"]?.status).toBe("completed");
    expect(result.contextStates["ctx-a"]?.pendingApproval).toBeNull();
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-c"]?.status).toBe("completed");

    // The persisted parked context predates lanes (worktree with no laneId),
    // so resume takes the legacy fan-in path — retained for exactly this
    // migration case — and its merge runs inside the held lock window.
    const lockAcquiredAt = ordered.indexOf("lock-acquired:conv-ctx-a");
    const mergeAt = ordered.indexOf("merge:ctx-a");
    const lockReleasedAt = ordered.indexOf("lock-released");
    expect(lockAcquiredAt).toBeGreaterThanOrEqual(0);
    expect(mergeAt).toBeGreaterThan(lockAcquiredAt);
    expect(lockReleasedAt).toBeGreaterThan(mergeAt);

    const resolvedEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-approval-resolved");
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      contextId: "ctx-a",
      conversationId: "conv-ctx-a",
      decision: "approved",
      decidedAt: "2026-03-27T12:02:00.000Z",
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-approval-resolved",
        contextId: "ctx-a",
        decision: "approved",
      }),
    );
  });

  it("scenario 15: resuming when the only incomplete context is parked keeps the execution in-flight without completing, and abort exits the wait unresolved", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a"]);
    definition.executionContexts.find(
      (ctx) => ctx.id === "ctx-a",
    )!.humanApprovalGate = { enabled: true };

    const pendingApprovalRecord = {
      conversationId: "conv-ctx-a",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: null,
    };

    const initial = createInitialExecution(definition);
    const parked = initial.contextStates["ctx-a"]!;
    parked.status = "awaiting_approval";
    parked.iterationCount = 1;
    parked.completedTaskCount = 1;
    parked.pendingApproval = structuredClone(pendingApprovalRecord);
    initial.taskStates["task-ctx-a"]!.status = "completed";

    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        throw new Error(
          "no iteration may be seeded for a parked context on resume",
        );
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner: { run: vi.fn() },
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForApprovalProgress: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });

    const runPromise = loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    const raceOutcome = await Promise.race([
      runPromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 30),
      ),
    ]);
    expect(raceOutcome).toBe("pending");

    const midFlight = repository.read();
    expect(midFlight?.status).toBe("running");
    expect(midFlight?.contextStates["ctx-a"]?.status).toBe("awaiting_approval");
    expect(runIterationCalls).toHaveLength(0);

    await manager.send("/repo", "session-1", { type: "abort" });

    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.contextStates["ctx-a"]?.status).toBe("awaiting_approval");
    expect(result.contextStates["ctx-a"]?.pendingApproval).toEqual(
      pendingApprovalRecord,
    );
    expect(runIterationCalls).toHaveLength(0);
  });

  it("scenario 16: lane worktree is cleaned up at completion — sequential contexts sharing a lane trigger exactly one cleanupLane call for the shared lane", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    definition.edges = [
      { id: "e1", sourceContextId: "ctx-a", targetContextId: "ctx-b" },
    ];
    const initial = createInitialExecution(definition);
    // ctx-b is planned to continue ctx-a's lane, so scheduling mints a
    // worktree lane for ctx-a and ctx-b reuses it (sequential lane reuse).
    initial.lanePlan = {
      continuationMap: { "ctx-a": "ctx-b" },
      longestDownstreamPath: {},
    };
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
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
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const mergeRunner: GraphMergeRunner = {
      async run() {
        throw new Error("fan-in merge must not run for lane-isolated contexts");
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner,
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-a"]?.laneId).toBe("ctx-a");
    expect(result.contextStates["ctx-b"]?.laneId).toBe("ctx-a");
    expect(parallelWorktrees.cleanupLaneCalls).toEqual([
      {
        projectPath: "/repo",
        sessionName: "session-1",
        sessionDir: "session-1",
        contextId: "ctx-a",
        branchName: "csm/session-1-ctx-a",
      },
    ]);
  });

  it("scenario 17: a halt recorded while a sibling is parked at the approval gate drains the loop — the parked wait exits, the execution halts, and the gate record persists for resume", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const pendingApprovalRecord = {
      conversationId: "conv-ctx-a",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: null,
    };

    const ctxBFailure = deferred<void>();
    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        if (input.contextId === "ctx-b") {
          await ctxBFailure.promise;
          throw new AgentTurnFailedError(
            "Socket is not connected (os error 57)",
            {
              contextId: "ctx-b",
              engine: "codex",
              cause: "sdk_error",
              originalMessage: "Socket is not connected (os error 57)",
            },
          );
        }
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.completedTaskCount = 1;
            cs.status = "awaiting_approval";
            cs.pendingApproval = structuredClone(pendingApprovalRecord);
          }
          const ts = updated.taskStates[`task-${input.contextId}`];
          if (ts) ts.status = "completed";
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner: {
        async run() {
          return buildSuccessMergeOutput();
        },
      },
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForApprovalProgress: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });

    const runPromise = loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await vi.waitFor(() => {
      expect(repository.read()?.contextStates["ctx-a"]?.status).toBe(
        "awaiting_approval",
      );
    });
    ctxBFailure.resolve();

    const result = await runPromise;
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "agent_turn_failed",
      contextId: "ctx-b",
    });
    expect(result.pendingHaltReason).toBeNull();
    expect(result.contextStates["ctx-a"]?.status).toBe("awaiting_approval");
    expect(result.contextStates["ctx-a"]?.pendingApproval).toEqual(
      pendingApprovalRecord,
    );
    expect(runIterationCalls.filter((id) => id === "ctx-a")).toHaveLength(1);
  });

  it("scenario 18: a halt recorded while a sibling is parked at the user-input gate drains the loop — the parked wait exits, the execution halts, and the question record persists for resume", async () => {
    _resetActiveLoopsForTesting();

    const definition = createParallelDefinition(["ctx-a", "ctx-b"]);
    const initial = createInitialExecution(definition);
    const repository = createRepository(initial);
    const parallelWorktrees = createParallelWorktreesStub();

    const manager = createGraphWorkflowManager({
      executionRepository: repository,
      async loadDefinition() {
        return null;
      },
      parallelWorktrees,
      async getSession() {
        return createSession();
      },
    });

    const pendingUserInputRecord = {
      conversationId: "conv-ctx-a",
      lane: "implementer" as const,
      questionBatchId: "batch-1",
      questions: [],
      requestedAt: "2026-03-27T12:01:00.000Z",
      answers: null,
    };

    const ctxBFailure = deferred<void>();
    const runIterationCalls: string[] = [];
    const iterationOrchestrator = {
      async runIteration(input: {
        contextId: string;
      }): Promise<GraphWorkflowIterationResult> {
        runIterationCalls.push(input.contextId);
        if (input.contextId === "ctx-b") {
          await ctxBFailure.promise;
          throw new AgentTurnFailedError(
            "Socket is not connected (os error 57)",
            {
              contextId: "ctx-b",
              engine: "codex",
              cause: "sdk_error",
              originalMessage: "Socket is not connected (os error 57)",
            },
          );
        }
        const next = await manager.mutateActive("/repo", "session-1", (e) => {
          const updated = structuredClone(e);
          const cs = updated.contextStates[input.contextId];
          if (cs) {
            cs.iterationCount = 1;
            cs.status = "awaiting_user_input";
            cs.pendingUserInput = structuredClone(pendingUserInputRecord);
          }
          updated.activeContextIds = updated.activeContextIds.filter(
            (id) => id !== input.contextId,
          );
          return updated;
        });
        return {
          conversationId: `conv-${input.contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    };

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeRunner: {
        async run() {
          return buildSuccessMergeOutput();
        },
      },
      joinRunner: createNoopJoinRunner(),
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      laneCommitter: {
        commit: async () => ({ status: "skipped" }),
        resolveHead: async () => null,
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      waitForUserInputProgress: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    });

    const runPromise = loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await vi.waitFor(() => {
      expect(repository.read()?.contextStates["ctx-a"]?.status).toBe(
        "awaiting_user_input",
      );
    });
    ctxBFailure.resolve();

    const result = await runPromise;
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "agent_turn_failed",
      contextId: "ctx-b",
    });
    expect(result.pendingHaltReason).toBeNull();
    expect(result.contextStates["ctx-a"]?.status).toBe("awaiting_user_input");
    expect(result.contextStates["ctx-a"]?.pendingUserInput).toEqual(
      pendingUserInputRecord,
    );
    expect(runIterationCalls.filter((id) => id === "ctx-a")).toHaveLength(1);
  });
});
