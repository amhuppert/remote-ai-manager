import { describe, expect, it, vi } from "vitest";
import type {
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import { createExecutionTargetResolver } from "@/lib/workflow-graph/execution-target-resolver";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import { createPerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import { createSessionGitLock } from "@/lib/workflow-graph/session-git-lock";
import type { MergeOutput } from "@/lib/workflows/merge/types";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
  SessionState,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";
import {
  createGraphWorkflowExecutionLoop,
  _resetActiveLoopsForTesting,
} from "./execution-loop";
import { createGraphWorkflowSignalHaltHandler } from "@/lib/workflow-graph/graph-workflow-signal-halt";
import { createGraphWorkflowManager } from "./workflow-manager";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";

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
    },
  ): Promise<GraphWorkflowExecution>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

function createRepository(
  initial: GraphWorkflowExecution | null,
): InMemoryExecutionRepository & { read(): GraphWorkflowExecution | null } {
  let active = initial;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async getActive() {
      return active;
    },
    async create() {
      throw new Error("create not used in integration tests");
    },
    async mutateActive(_p, _s, fn) {
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
        const updated = await fn(structuredClone(active));
        active = updated;
        return updated;
      } finally {
        release();
      }
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
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  } as unknown as SessionState;
}

interface ParallelWorktreesStub extends ParallelWorktrees {
  provisionCalls: ProvisionInput[];
  disposeCalls: DisposeInput[];
}

function createParallelWorktreesStub(): ParallelWorktreesStub {
  const provisionCalls: ProvisionInput[] = [];
  const disposeCalls: DisposeInput[] = [];

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

  return { provision, provisionBatch, dispose, provisionCalls, disposeCalls };
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
    workingDefinition:
      definition as unknown as ResolvedWorkflowSemanticDefinition,
    status: "running",
    activeContextIds: [],
    contextStates,
    taskStates,
    sharedDocuments: [],
    laneStates: {},
    machineSnapshot: null,
    history: [],
    startedAt: "2026-03-27T12:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
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

    const mergeOrder: string[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        mergeOrder.push(input.contextId);
        return buildSuccessMergeOutput();
      },
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
      soloContextCommitter: {
        commit: async (input) => {
          soloCommitCalls.push(input.contextId);
          return { status: "skipped" };
        },
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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
    expect(mergeOrder).toEqual(["ctx-a", "ctx-b"]);
    expect(soloCommitCalls).toEqual([]);
    expect(
      parallelWorktrees.provisionCalls.map((c) => c.contextId).sort(),
    ).toEqual(["ctx-a", "ctx-b"]);
    expect(
      parallelWorktrees.disposeCalls.map((c) => c.branchName).sort(),
    ).toEqual(["csm/session-1-ctx-a", "csm/session-1-ctx-b"]);
    for (const ctxId of ["ctx-a", "ctx-b"]) {
      const cs = result.contextStates[ctxId];
      expect(cs?.mergeStatus).toBe("merged-success");
      expect(cs?.cleanupStatus).toBe("removed");
      expect(cs?.lastMergeError).toBeNull();
    }
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
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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
    expect(mergeOrder).toEqual(["ctx-b", "ctx-a"]);
    for (const ctxId of ["ctx-a", "ctx-b"]) {
      expect(result.contextStates[ctxId]?.mergeStatus).toBe("merged-success");
      expect(result.contextStates[ctxId]?.cleanupStatus).toBe("removed");
    }
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
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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

    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        if (input.contextId === "ctx-b") {
          return buildFailedMergeOutput("auto-resolution exhausted");
        }
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
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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
    expect(result.haltReason?.type).toBe("merge_failure");
    if (result.haltReason?.type === "merge_failure") {
      expect(result.haltReason.contextId).toBe("ctx-b");
      expect(result.haltReason.message).toBe("auto-resolution exhausted");
    }
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-a"]?.cleanupStatus).toBe("removed");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-failed");
    expect(result.contextStates["ctx-b"]?.lastMergeError).toBe(
      "auto-resolution exhausted",
    );

    const disposeBranches = parallelWorktrees.disposeCalls.map(
      (c) => c.branchName,
    );
    expect(disposeBranches).toContain("csm/session-1-ctx-a");
    expect(disposeBranches).not.toContain("csm/session-1-ctx-b");
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
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
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
    expect(mergeOrder).toEqual(["ctx-b"]);
    expect(result.contextStates["ctx-a"]?.status).toBe("halted");
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("not-applicable");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
    expect(
      parallelWorktrees.disposeCalls.map((call) => call.branchName),
    ).toEqual(["csm/session-1-ctx-b"]);
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
      soloContextCommitter: {
        commit: async (input) => {
          soloCommitCalls.push(input.contextId);
          return { status: "committed", hash: "abc" };
        },
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
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

  it("scenario 8: user merge job overlaps fan-in — graph fan-in waits on session git lock", async () => {
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

    const fanInTimes: Array<{ contextId: string; ts: number }> = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        fanInTimes.push({ contextId: input.contextId, ts: Date.now() });
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

    const loop = createGraphWorkflowExecutionLoop({
      workflowManager: manager,
      iterationOrchestrator,
      parallelWorktrees,
      mergeMutex: createPerSessionMergeMutex(),
      sessionGitLock,
      mergeRunner,
      soloContextCommitter: {
        commit: async () => ({ status: "skipped" }),
      },
      executionTargetResolver: createExecutionTargetResolver(),
      async getSession() {
        return createSession();
      },
      emitStreamFrame: vi.fn(),
    });

    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(lockHeld).toBe(false);
    expect(fanInTimes).toHaveLength(2);
    // Both fan-in merges ran AFTER the user job released the lock.
    for (const entry of fanInTimes) {
      expect(entry.ts).toBeGreaterThanOrEqual(userJobReleasedAt);
    }
    // Both fan-ins succeeded.
    expect(result.contextStates["ctx-a"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-b"]?.mergeStatus).toBe("merged-success");
  });
});
