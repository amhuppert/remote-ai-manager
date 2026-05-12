import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionTarget,
  ExecutionTargetResolver,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import type { PerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/workflow-graph/session-git-lock";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
  SessionState,
  WorkflowSemanticDefinition,
} from "@/types";
import {
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
  _resetActiveLoopsForTesting,
  type GraphWorkflowExecutionLoopDeps,
  type GraphWorkflowExecutionLoopWorkflowManager,
} from "./execution-loop";
import { IterationFailureWithProgressError } from "./iteration-failure-with-progress";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import type {
  RecordPendingHaltReasonResult,
  ScheduleEligibleContextsResult,
} from "./workflow-manager";

function createSingleContextDefinition(
  maxIterations: number,
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    executionContexts: [
      {
        id: "ctx-1",
        title: "Do work",
        description: "Single context",
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations, continuity: { enabled: true } },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Implement feature",
        instructions: "Do the thing.",
        source: "user" as const,
      },
    ],
    edges: [],
  };
}

function createRunningExecution(
  definition: WorkflowSemanticDefinition,
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  return {
    id: "exec-1",
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition:
      definition as unknown as ResolvedWorkflowSemanticDefinition,
    status: "running",
    activeContextIds: [],
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
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
      },
    },
    taskStates: {
      "task-1": {
        taskId: "task-1",
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
    laneStates: {},
    machineSnapshot: null,
    history: [],
    startedAt: "2026-03-27T12:00:00.000Z",
    completedAt: null,
    haltReason: null,
    pendingHaltReason: null,
    secondaryHaltReasons: [],
    pendingMergeRetry: [],
    ...overrides,
  };
}

function makeStubSession(): SessionState {
  return {
    name: "session-1",
    branchName: "csm/session-1",
    worktreePath: "/repo/.worktrees/session-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    targetBranch: "main",
    conversationIds: [],
    activeConversationId: null,
    lastUsedAt: null,
    devServer: null,
    devServerLog: null,
    initSummary: null,
    workflows: {},
    archivedAt: null,
    summary: null,
    tags: [],
  } as unknown as SessionState;
}

interface LoopHarness {
  deps: GraphWorkflowExecutionLoopDeps;
  getCurrent: () => GraphWorkflowExecution;
  setCurrent: (execution: GraphWorkflowExecution) => void;
  recordPendingHaltReasonSpy: ReturnType<typeof vi.fn>;
  drainAndHaltSpy: ReturnType<typeof vi.fn>;
  sendSpy: ReturnType<typeof vi.fn>;
  scheduleEligibleContextsSpy: ReturnType<typeof vi.fn>;
}

interface BuildHarnessInput {
  initialExecution: GraphWorkflowExecution;
  iterationOrchestrator: GraphWorkflowExecutionLoopDeps["iterationOrchestrator"];
  recoverRetryableIterationError?: GraphWorkflowExecutionLoopWorkflowManager["recoverRetryableIterationError"];
  runCircuitBreakerGate?: GraphWorkflowExecutionLoopDeps["runCircuitBreakerGate"];
  emitStreamFrame?: GraphWorkflowExecutionLoopDeps["emitStreamFrame"];
  scheduleEligibleContexts?: GraphWorkflowExecutionLoopWorkflowManager["scheduleEligibleContexts"];
  executionTargetResolver?: ExecutionTargetResolver;
  parallelWorktrees?: ParallelWorktrees;
  mergeMutex?: PerSessionMergeMutex;
  sessionGitLock?: SessionGitLock;
  mergeRunner?: GraphMergeRunner;
  soloContextCommitter?: GraphWorkflowExecutionLoopDeps["soloContextCommitter"];
  getSession?: GraphWorkflowExecutionLoopDeps["getSession"];
}

function buildHarness(input: BuildHarnessInput): LoopHarness {
  let current = input.initialExecution;
  const getCurrent = () => current;
  const setCurrent = (e: GraphWorkflowExecution) => {
    current = e;
  };

  const defaultScheduleEligibleContexts =
    async (): Promise<ScheduleEligibleContextsResult> => {
      const e = getCurrent();
      if (e.status !== "running") {
        return { execution: e, scheduled: { kind: "none" } };
      }
      const ctx = e.contextStates["ctx-1"];
      if (!ctx) {
        return { execution: e, scheduled: { kind: "none" } };
      }
      if (
        ctx.status === "completed" ||
        ctx.completedTaskCount >= ctx.totalTaskCount
      ) {
        return { execution: e, scheduled: { kind: "none" } };
      }
      const next = structuredClone(e);
      next.activeContextIds = ["ctx-1"];
      next.contextStates["ctx-1"]!.status = "running";
      setCurrent(next);
      return {
        execution: next,
        scheduled: { kind: "solo", contextId: "ctx-1" },
      };
    };

  const scheduleEligibleContextsSpy = vi.fn(
    input.scheduleEligibleContexts ?? defaultScheduleEligibleContexts,
  );

  const sendSpy = vi.fn(
    async (
      _projectPath: string,
      _sessionName: string,
      event: { type: "complete" },
    ): Promise<GraphWorkflowExecution> => {
      if (event.type === "complete") {
        const next = {
          ...structuredClone(getCurrent()),
          status: "completed" as const,
          completedAt: "2026-03-27T12:05:00.000Z",
        };
        setCurrent(next);
      }
      return getCurrent();
    },
  );

  const recordPendingHaltReasonSpy = vi.fn(
    async (input: {
      projectPath: string;
      sessionName: string;
      reason: GraphWorkflowHaltReason;
    }): Promise<RecordPendingHaltReasonResult> => {
      const e = getCurrent();
      if (e.pendingHaltReason !== null) {
        return { execution: e, accepted: false };
      }
      const next = structuredClone(e);
      next.pendingHaltReason = input.reason;
      setCurrent(next);
      return { execution: next, accepted: true };
    },
  );

  const drainAndHaltSpy = vi.fn(async (): Promise<GraphWorkflowExecution> => {
    const e = getCurrent();
    const haltReason = e.pendingHaltReason;
    if (!haltReason) {
      throw new Error("drainAndHalt requires pendingHaltReason");
    }
    const next: GraphWorkflowExecution = {
      ...structuredClone(e),
      status: "halted",
      haltReason,
      pendingHaltReason: null,
      completedAt: "2026-03-27T12:10:00.000Z",
    };
    setCurrent(next);
    return next;
  });

  const mutateActive: GraphWorkflowExecutionLoopWorkflowManager["mutateActive"] =
    async (_p, _s, fn) => {
      const next = await fn(getCurrent());
      setCurrent(next);
      return next;
    };

  const getActive: GraphWorkflowExecutionLoopWorkflowManager["getActive"] =
    async () => getCurrent();

  const workflowManager: GraphWorkflowExecutionLoopWorkflowManager = {
    scheduleEligibleContexts: scheduleEligibleContextsSpy,
    send: sendSpy,
    recordPendingHaltReason: recordPendingHaltReasonSpy,
    drainAndHalt: drainAndHaltSpy,
    mutateActive,
    getActive,
    recoverRetryableIterationError: input.recoverRetryableIterationError,
  };

  const sessionTarget: ExecutionTarget = {
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    isolation: "session",
  };

  const executionTargetResolver: ExecutionTargetResolver =
    input.executionTargetResolver ?? {
      resolve: () => sessionTarget,
    };

  const parallelWorktrees: ParallelWorktrees = input.parallelWorktrees ?? {
    provision: vi.fn(),
    provisionBatch: vi.fn(),
    dispose: vi.fn(),
  };

  const mergeMutex: PerSessionMergeMutex = input.mergeMutex ?? {
    withMergeMutex: async (_k, fn) => fn(),
  };

  const sessionGitLock: SessionGitLock = input.sessionGitLock ?? {
    withSessionGitLock: async (_k, fn) => fn(),
  };

  const mergeRunner: GraphMergeRunner = input.mergeRunner ?? {
    run: vi.fn(),
  };

  const soloContextCommitter: GraphWorkflowExecutionLoopDeps["soloContextCommitter"] =
    input.soloContextCommitter ?? {
      commit: async () => ({ status: "skipped" }),
    };

  const getSession = input.getSession ?? (async () => makeStubSession());

  const deps: GraphWorkflowExecutionLoopDeps = {
    workflowManager,
    iterationOrchestrator: input.iterationOrchestrator,
    parallelWorktrees,
    mergeMutex,
    sessionGitLock,
    mergeRunner,
    soloContextCommitter,
    executionTargetResolver,
    getSession,
    emitStreamFrame: input.emitStreamFrame ?? vi.fn(),
    runCircuitBreakerGate: input.runCircuitBreakerGate,
  };

  return {
    deps,
    getCurrent,
    setCurrent,
    recordPendingHaltReasonSpy,
    drainAndHaltSpy,
    sendSpy,
    scheduleEligibleContextsSpy,
  };
}

describe("execution loop", () => {
  it("halts when a context exceeds its maxIterations limit", async () => {
    const definition = createSingleContextDefinition(2);
    const initial = createRunningExecution(definition);
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount += 1;
          next.taskStates["task-1"]!.status = "interrupted";
          harness.setCurrent(next);
          return {
            conversationId: `conv-${next.contextStates["ctx-1"]!.iterationCount}`,
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(result.haltReason).toEqual({
      type: "max_iterations",
      contextId: "ctx-1",
      iterationCount: 2,
    });
    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: {
        type: "max_iterations",
        contextId: "ctx-1",
        iterationCount: 2,
      },
    });
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
  });

  it("completes normally when tasks finish before maxIterations", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = 1;
          next.contextStates["ctx-1"]!.status = "completed";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.taskStates["task-1"]!.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("completed");
    expect(result.haltReason).toBeNull();
    expect(harness.sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
  });

  it("registers as active while running and deregisters on completion", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
    });
    let wasActiveDuringIteration = false;

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          wasActiveDuringIteration = isExecutionLoopActive(
            "/repo",
            "session-1",
          );
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.status = "completed";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    _resetActiveLoopsForTesting();
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(false);

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(wasActiveDuringIteration).toBe(true);
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(false);
  });

  it("retries once when the iteration fails with a stream-closed error", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      laneStates: {
        "ctx-1": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "ctx-1",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-1",
            },
            lastContextTokens: null,
            lastContextWindowMax: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T12:00:00.000Z",
          },
        },
      },
    });

    let iterationCallCount = 0;

    const recoverRetryableIterationError = vi.fn(
      async (_projectPath: string, _sessionName: string, errInput) => {
        expect(errInput).toEqual({
          contextId: "ctx-1",
          errorMessage: "SDK error: MCP error -32000: Stream closed",
        });
        const next = structuredClone(harness.getCurrent());
        next.contextStates["ctx-1"]!.status = "ready";
        const lane = next.laneStates["ctx-1"]?.["implementer"];
        if (lane?.engine === "claude") {
          lane.rotateBeforeNextTurn = true;
        }
        harness.setCurrent(next);
        return next;
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      recoverRetryableIterationError,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount === 1) {
            throw new Error("SDK error: MCP error -32000: Stream closed");
          }

          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = 2;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextIds = [];
          harness.setCurrent(next);

          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(iterationCallCount).toBe(2);
    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(harness.sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
    expect(result.status).toBe("completed");
  });

  it("retries once when the iteration fails before prompt delivery", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      laneStates: {
        "ctx-1": {
          implementer: {
            engine: "claude",
            lane: "implementer",
            contextId: "ctx-1",
            sessionRef: {
              engine: "claude",
              lane: "implementer",
              conversationId: "conv-1",
            },
            lastContextTokens: null,
            lastContextWindowMax: null,
            rotateBeforeNextTurn: false,
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-27T12:00:00.000Z",
          },
        },
      },
    });
    let iterationCallCount = 0;

    const recoverRetryableIterationError = vi.fn(
      async (_projectPath: string, _sessionName: string, errInput) => {
        expect(errInput).toEqual({
          contextId: "ctx-1",
          errorMessage: "SDK error: QuerySession died before prompt delivery",
        });
        const next = structuredClone(harness.getCurrent());
        next.contextStates["ctx-1"]!.status = "ready";
        const lane = next.laneStates["ctx-1"]?.["implementer"];
        if (lane?.engine === "claude") {
          lane.rotateBeforeNextTurn = true;
        }
        harness.setCurrent(next);
        return next;
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      recoverRetryableIterationError,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount === 1) {
            throw new Error(
              "SDK error: QuerySession died before prompt delivery",
            );
          }

          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = 2;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextIds = [];
          harness.setCurrent(next);

          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(iterationCallCount).toBe(2);
    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(harness.sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
    expect(result.status).toBe("completed");
  });

  it.each([
    "QuerySession is dead — cannot send prompt",
    "QuerySession ended before the turn completed",
  ])(
    "retries once when the iteration fails with %j",
    async (sdkErrorMessage) => {
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition, {
        activeContextIds: ["ctx-1"],
        contextStates: {
          "ctx-1": {
            contextId: "ctx-1",
            status: "running",
            totalTaskCount: 1,
            completedTaskCount: 0,
            iterationCount: 1,
            consecutiveFailureCount: 0,
            worktreePath: null,
            branchName: null,
            isolation: "session",
            batchId: null,
            mergeStatus: "not-applicable",
            cleanupStatus: "not-applicable",
            lastMergeError: null,
          },
        },
        laneStates: {
          "ctx-1": {
            implementer: {
              engine: "claude",
              lane: "implementer",
              contextId: "ctx-1",
              sessionRef: {
                engine: "claude",
                lane: "implementer",
                conversationId: "conv-1",
              },
              lastContextTokens: null,
              lastContextWindowMax: null,
              rotateBeforeNextTurn: false,
              limitEvaluation: "disabled",
              lastUsedAt: "2026-03-27T12:00:00.000Z",
            },
          },
        },
      });
      let iterationCallCount = 0;

      const recoverRetryableIterationError = vi.fn(
        async (_projectPath: string, _sessionName: string, errInput) => {
          expect(errInput).toEqual({
            contextId: "ctx-1",
            errorMessage: `SDK error: ${sdkErrorMessage}`,
          });
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.status = "ready";
          const lane = next.laneStates["ctx-1"]?.["implementer"];
          if (lane?.engine === "claude") {
            lane.rotateBeforeNextTurn = true;
          }
          harness.setCurrent(next);
          return next;
        },
      );

      const harness = buildHarness({
        initialExecution: initial,
        recoverRetryableIterationError,
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            iterationCallCount += 1;
            if (iterationCallCount === 1) {
              throw new Error(`SDK error: ${sdkErrorMessage}`);
            }

            const next = structuredClone(harness.getCurrent());
            next.contextStates["ctx-1"]!.iterationCount = 2;
            next.contextStates["ctx-1"]!.status = "completed";
            next.taskStates["task-1"]!.status = "completed";
            next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
            next.contextStates["ctx-1"]!.completedTaskCount = 1;
            next.activeContextIds = [];
            harness.setCurrent(next);

            return {
              conversationId: "conv-2",
              execution: next,
              shouldContinueInContext: false,
            };
          },
        },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(iterationCallCount).toBe(2);
      expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
      expect(harness.sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
        type: "complete",
      });
      expect(result.status).toBe("completed");
    },
  );

  it("halts after a second consecutive stream-closed error", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    const recoverRetryableIterationError = vi.fn(async () => {
      const next = structuredClone(harness.getCurrent());
      next.contextStates["ctx-1"]!.status = "ready";
      harness.setCurrent(next);
      return next;
    });

    const harness = buildHarness({
      initialExecution: initial,
      recoverRetryableIterationError,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("SDK error: MCP error -32000: Stream closed");
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(recoverRetryableIterationError).toHaveBeenCalledOnce();
    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: {
        type: "execution_loop_failed",
        contextId: "ctx-1",
        message: "SDK error: MCP error -32000: Stream closed",
        cause: "sdk_error",
      },
    });
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
    expect(result.status).toBe("halted");
  });

  it("resets the recovery counter when an iteration fails after partial turn progress", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    let iterationCallCount = 0;

    const recoverRetryableIterationError = vi.fn(async () => {
      const next = structuredClone(harness.getCurrent());
      next.contextStates["ctx-1"]!.status = "ready";
      harness.setCurrent(next);
      return next;
    });

    const harness = buildHarness({
      initialExecution: initial,
      recoverRetryableIterationError,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          if (iterationCallCount === 1) {
            throw new Error("SDK error: MCP error -32000: Stream closed");
          }
          if (iterationCallCount === 2) {
            throw new IterationFailureWithProgressError(
              new Error("SDK error: QuerySession is dead"),
              2,
            );
          }
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = 3;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.taskStates["task-1"]!.completedAt = "2026-03-27T12:03:00.000Z";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-3",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(iterationCallCount).toBe(3);
    expect(recoverRetryableIterationError).toHaveBeenCalledTimes(2);
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("halts with circuit_breaker when consecutiveFailureCount reaches threshold", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 2,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount += 1;
          next.contextStates["ctx-1"]!.consecutiveFailureCount = 3;
          harness.setCurrent(next);
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(result.status).toBe("halted");
    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: {
        type: "circuit_breaker",
        contextId: "ctx-1",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    });
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
  });

  it("continues iterating when consecutiveFailureCount is below threshold", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
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
        },
      },
    });
    let iterationCallCount = 0;

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = iterationCallCount;

          if (iterationCallCount === 1) {
            next.contextStates["ctx-1"]!.consecutiveFailureCount = 1;
            harness.setCurrent(next);
            return {
              conversationId: "conv-1",
              execution: next,
              shouldContinueInContext: true,
            };
          }

          next.contextStates["ctx-1"]!.consecutiveFailureCount = 0;
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-2",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(iterationCallCount).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("routes the circuit-breaker decision through the runCircuitBreakerGate dep", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 2,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });

    const runCircuitBreakerGate = vi.fn(
      (input: { failureCount: number; threshold: number }) => {
        if (input.failureCount >= input.threshold) {
          return {
            status: "fail" as const,
            kind: "circuit_breaker" as const,
            reason: "tripped",
            details: {
              failureCount: input.failureCount,
              threshold: input.threshold,
              tripped: true,
            },
          };
        }
        return {
          status: "pass" as const,
          kind: "circuit_breaker" as const,
          details: {
            failureCount: input.failureCount,
            threshold: input.threshold,
            tripped: false,
          },
        };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      runCircuitBreakerGate,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount += 1;
          next.contextStates["ctx-1"]!.consecutiveFailureCount = 3;
          harness.setCurrent(next);
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: true,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(runCircuitBreakerGate).toHaveBeenCalledWith({
      failureCount: 3,
      threshold: 3,
    });
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("circuit_breaker");
  });

  it("does not halt when the runCircuitBreakerGate dep returns pass", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 5,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });
    let iterationCallCount = 0;

    const runCircuitBreakerGate = vi.fn(() => ({
      status: "pass" as const,
      kind: "circuit_breaker" as const,
      details: { failureCount: 0, threshold: 99, tripped: false },
    }));

    const harness = buildHarness({
      initialExecution: initial,
      runCircuitBreakerGate,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = iterationCallCount;
          next.contextStates["ctx-1"]!.consecutiveFailureCount = 5;
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
          next.contextStates["ctx-1"]!.status = "completed";
          next.taskStates["task-1"]!.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: `conv-${iterationCallCount}`,
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(runCircuitBreakerGate).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.haltReason).toBeNull();
  });

  it("halts with merge_precondition_failed via preflight when session worktree is dirty", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "worktree",
          batchId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
          lastMergeError: null,
        },
      },
    });

    const runIterationSpy = vi.fn();

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: { runIteration: runIterationSpy },
    });

    harness.deps.getSessionWorktreeDirtyPaths = vi.fn(async () => [
      { path: "src/app.ts", statusCode: " M", tracked: true },
    ]);

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(runIterationSpy).not.toHaveBeenCalled();
    expect(harness.scheduleEligibleContextsSpy).not.toHaveBeenCalled();
    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledTimes(1);
    const recordedReason =
      harness.recordPendingHaltReasonSpy.mock.calls[0]?.[0].reason;
    expect(recordedReason).toMatchObject({
      type: "merge_precondition_failed",
      contextId: "ctx-1",
      targetBranch: "csm/session-1",
      totalDirtyCount: 1,
    });
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("merge_precondition_failed");
  });

  it("processes pendingMergeRetry, clears the entry on success, and completes", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.ctx-1",
          branchName: "csm/session-1-ctx-1",
          isolation: "worktree",
          batchId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
          lastMergeError: null,
        },
      },
      taskStates: {
        "task-1": {
          taskId: "task-1",
          contextId: "ctx-1",
          order: 1,
          status: "completed",
          summary: null,
          startedAt: null,
          completedAt: "2026-03-27T12:03:00.000Z",
          lastConversationId: "conv-1",
          failureMessage: null,
          failureHistory: [],
        },
      },
      pendingMergeRetry: ["ctx-1"],
    });

    const mergeRunner: GraphMergeRunner = {
      run: vi.fn(async () => ({
        status: "completed" as const,
        mergeHash: "merge-hash",
        commitHash: "commit-hash",
        error: null,
        conflictFiles: [],
        conflictAnalysis: null,
      })),
    };

    const parallelWorktrees: ParallelWorktrees = {
      provision: vi.fn(),
      provisionBatch: vi.fn(),
      dispose: vi.fn(async () => ({ status: "removed" as const })),
    };

    const runIterationSpy = vi.fn();

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: { runIteration: runIterationSpy },
      mergeRunner,
      parallelWorktrees,
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(mergeRunner.run).toHaveBeenCalledTimes(1);
    expect(runIterationSpy).not.toHaveBeenCalled();
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.sendSpy).toHaveBeenCalledWith("/repo", "session-1", {
      type: "complete",
    });
    expect(result.status).toBe("completed");
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-success");
    expect(result.pendingMergeRetry).toEqual([]);
  });

  it("emits done with the haltReason when iteration returns a pre-halted execution", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          contextId: "ctx-1",
          status: "running",
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
        },
      },
    });

    const haltedExecution: GraphWorkflowExecution = {
      ...structuredClone(initial),
      status: "halted",
      haltReason: {
        type: "validator_infra_error",
        contextId: "ctx-1",
        engine: "codex",
        infraReason: "exception",
        message: "Codex API rate limit exceeded",
        summary: null,
      },
      completedAt: "2026-03-27T12:10:00.000Z",
    };

    const emitStreamFrame = vi.fn();

    const harness = buildHarness({
      initialExecution: initial,
      emitStreamFrame,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          harness.setCurrent(haltedExecution);
          return {
            conversationId: "conv-1",
            execution: haltedExecution,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(emitStreamFrame).toHaveBeenCalledWith("/repo", "session-1", {
      type: "done",
      reason: "validator_infra_error",
    });
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("validator_infra_error");
  });
});
