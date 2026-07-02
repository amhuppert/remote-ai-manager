import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionTarget,
  ExecutionTargetResolver,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import { applyJoinProgress } from "@/lib/workflow-graph/lane-join";
import type { JoinRunner } from "@/lib/workflow-graph/join-runner";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import type { PerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/workflow-graph/session-git-lock";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowApprovalResolvedEvent,
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowHaltReason,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  createGraphWorkflowExecutionLoop,
  isExecutionLoopActive,
  _resetActiveLoopsForTesting,
  type GraphWorkflowExecutionLoopDeps,
  type GraphWorkflowExecutionLoopWorkflowManager,
} from "./execution-loop";
import {
  getTraceContext,
  runWithTrace,
  type TraceContext,
} from "@/lib/logging";
import { IterationFailureWithProgressError } from "./iteration-failure-with-progress";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import type {
  RecordPendingHaltReasonResult,
  ScheduleEligibleContextsResult,
} from "./workflow-manager";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

function createSingleContextDefinition(
  maxIterations: number,
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
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
    boundInputs: {},
    launchedTier: "project",
    workingDefinition:
      definition as unknown as ResolvedWorkflowSemanticDefinition,
    charter: makeTestCharter(),
    status: "running",
    activeContextIds: [],
    contextStates: {
      "ctx-1": {
        pendingApproval: null,
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
        laneId: null,
        joinId: null,
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
  appendedEvents: GraphWorkflowExecutionEvent[];
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
  scheduleEligibleContexts?: GraphWorkflowExecutionLoopWorkflowManager["scheduleEligibleContexts"];
  executionTargetResolver?: ExecutionTargetResolver;
  parallelWorktrees?: ParallelWorktrees;
  mergeMutex?: PerSessionMergeMutex;
  sessionGitLock?: SessionGitLock;
  mergeRunner?: GraphMergeRunner;
  joinRunner?: JoinRunner;
  soloContextCommitter?: GraphWorkflowExecutionLoopDeps["soloContextCommitter"];
  laneCommitter?: GraphWorkflowExecutionLoopDeps["laneCommitter"];
  getSession?: GraphWorkflowExecutionLoopDeps["getSession"];
  waitForCollaborationProgress?: GraphWorkflowExecutionLoopDeps["waitForCollaborationProgress"];
  waitForApprovalProgress?: GraphWorkflowExecutionLoopDeps["waitForApprovalProgress"];
  isConversationBusy?: GraphWorkflowExecutionLoopDeps["isConversationBusy"];
  acquireConversationLock?: GraphWorkflowExecutionLoopDeps["acquireConversationLock"];
  eventPublisher?: GraphWorkflowExecutionLoopDeps["eventPublisher"];
  getMaxConcurrentQueries?: GraphWorkflowExecutionLoopDeps["getMaxConcurrentQueries"];
}

function buildHarness(input: BuildHarnessInput): LoopHarness {
  let current = input.initialExecution;
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];
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
      applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
    }): Promise<RecordPendingHaltReasonResult> => {
      const e = getCurrent();
      if (e.pendingHaltReason !== null) {
        return { execution: e, accepted: false };
      }
      const next = structuredClone(e);
      next.pendingHaltReason = input.reason;
      if (input.applyAdditionalMutation) {
        input.applyAdditionalMutation(next);
      }
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
      const result = await fn(getCurrent());
      if ("execution" in result && "events" in result) {
        setCurrent(result.execution);
        appendedEvents.push(...result.events);
        return result.execution;
      }
      setCurrent(result);
      return result;
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
    laneId: null,
  };

  const executionTargetResolver: ExecutionTargetResolver =
    input.executionTargetResolver ?? {
      resolve: () => sessionTarget,
    };

  const parallelWorktrees: ParallelWorktrees = input.parallelWorktrees ?? {
    provision: vi.fn(),
    provisionBatch: vi.fn(),
    dispose: vi.fn(),
    provisionLane: vi.fn(),
    provisionLaneBatch: vi.fn(),
    disposeLane: vi.fn(),
    cleanupLane: vi.fn(async () => ({ status: "removed" as const })),
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

  const joinRunner: JoinRunner = input.joinRunner ?? {
    async run({ joinId, mutateActive }) {
      await mutateActive((e) =>
        applyJoinProgress(e, joinId, new Date().toISOString(), {
          status: "succeeded",
        }),
      );
      return { status: "succeeded" };
    },
  };

  const soloContextCommitter: GraphWorkflowExecutionLoopDeps["soloContextCommitter"] =
    input.soloContextCommitter ?? {
      commit: async () => ({ status: "skipped" }),
    };

  const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] =
    input.laneCommitter ?? {
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
    joinRunner,
    soloContextCommitter,
    laneCommitter,
    executionTargetResolver,
    getSession,
    runCircuitBreakerGate: input.runCircuitBreakerGate,
    waitForCollaborationProgress: input.waitForCollaborationProgress,
    waitForApprovalProgress: input.waitForApprovalProgress,
    isConversationBusy: input.isConversationBusy,
    acquireConversationLock: input.acquireConversationLock,
    eventPublisher: input.eventPublisher,
    getMaxConcurrentQueries: input.getMaxConcurrentQueries ?? (async () => 999),
  };

  return {
    deps,
    getCurrent,
    setCurrent,
    appendedEvents,
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

  it("bounds each scheduling pass to the query-concurrency limit", async () => {
    // Regression for the workflow stall: the loop must cap the parallel batch
    // at `maxConcurrency - inFlight.size` so it never schedules more concurrent
    // contexts than the global query semaphore can admit. On the first pass the
    // in-flight set is empty, so the full limit is available.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 3,
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
    await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(
      harness.scheduleEligibleContextsSpy.mock.calls[0]?.[0]?.capacityRemaining,
    ).toBe(3);
  });

  it("halts instead of completing when a context is still incomplete and nothing is schedulable", async () => {
    // Regression for the premature-completion bug: a context stranded as
    // un-schedulable (here a scheduler that returns `none` while the context is
    // non-terminal) must never be treated as done. The loop halts for human
    // intervention rather than silently completing and dropping unfinished work.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    initial.contextStates["ctx-1"]!.status = "ready";
    const harness = buildHarness({
      initialExecution: initial,
      scheduleEligibleContexts: async () => ({
        execution: harness.getCurrent(),
        scheduled: { kind: "none" },
      }),
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("a stranded context must not be scheduled");
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
    expect(result.haltReason?.type).toBe("recovery_error");
    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
    const recordedReason =
      harness.recordPendingHaltReasonSpy.mock.calls[0]?.[0]?.reason;
    expect(recordedReason?.type).toBe("recovery_error");
    expect(recordedReason?.message).toContain("ctx-1");
  });

  it("waits instead of completing while a collaboration is pending, then resumes the context when it clears", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          ...createRunningExecution(definition).contextStates["ctx-1"]!,
          status: "running",
        },
      },
      pendingCollaborations: {
        "ctx-1": {
          workflowId: "collab-1",
          contextId: "ctx-1",
          conversationId: "conv-1",
          parentImplementerTurnId: "turn-1",
          brief: "Choose the queue.",
          startedAt: "2026-03-27T12:01:00.000Z",
        },
      },
    });

    let iterationCallCount = 0;
    const waitForCollaborationProgress = vi.fn(async () => {
      expect(harness.sendSpy).not.toHaveBeenCalled();
      const next = structuredClone(harness.getCurrent());
      delete next.pendingCollaborations["ctx-1"];
      next.contextStates["ctx-1"]!.status = "ready";
      next.collaborationContinuations["ctx-1"] = [
        {
          workflowId: "collab-1",
          brief: "Choose the queue.",
          result: {
            status: "converged",
            finalAnswer: "Use the existing queue.",
            openConflicts: [],
          },
          roundsConsumed: 1,
          completedAt: "2026-03-27T12:02:00.000Z",
          deliveredAt: null,
        },
      ];
      harness.setCurrent(next);
    });

    const harness = buildHarness({
      initialExecution: initial,
      waitForCollaborationProgress,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          iterationCallCount += 1;
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.iterationCount = 2;
          next.contextStates["ctx-1"]!.status = "completed";
          next.contextStates["ctx-1"]!.completedTaskCount = 1;
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

    expect(waitForCollaborationProgress).toHaveBeenCalledTimes(1);
    expect(iterationCallCount).toBe(1);
    expect(result.status).toBe("completed");
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
            pendingApproval: null,
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
            laneId: null,
            joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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

  it("stops seeding iterations when a halt is pending during the drain window", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          next.contextStates["ctx-1"]!.iterationCount += 1;
          // A sibling context recorded a halt mid-flight: pendingHaltReason is
          // set while the execution is still "running" (the drain-then-halt
          // window). The per-context loop must stop seeding iterations.
          next.pendingHaltReason = {
            type: "collaboration_failure",
            status: "objective_disagreement",
            brief: "sibling blocked",
            executionContextId: "ctx-other",
            conversationId: "conv-other",
            summary: "sibling blocked",
          };
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

    expect(iterationCallCount).toBe(1);
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("collaboration_failure");
    expect(harness.drainAndHaltSpy).toHaveBeenCalled();
  });

  it("continues iterating when consecutiveFailureCount is below threshold", async () => {
    const definition = createSingleContextDefinition(10);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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
        preparedSha: null,
        expectedTargetSha: null,
        parkedRef: null,
        refreshWarning: null,
        phase: null,
      })),
    };

    const parallelWorktrees: ParallelWorktrees = {
      provision: vi.fn(),
      provisionBatch: vi.fn(),
      dispose: vi.fn(async () => ({ status: "removed" as const })),
      provisionLane: vi.fn(),
      provisionLaneBatch: vi.fn(),
      disposeLane: vi.fn(async () => ({ status: "removed" as const })),
      cleanupLane: vi.fn(async () => ({ status: "removed" as const })),
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
          pendingApproval: null,
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
          laneId: null,
          joinId: null,
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

    const harness = buildHarness({
      initialExecution: initial,
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
    expect(result.status).toBe("halted");
    expect(result.haltReason?.type).toBe("validator_infra_error");
  });

  it("routes worktree-isolation contexts with an assigned lane through laneCommitter (snapshot appended, includedContextIds updated, no fan-in merge)", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const laneTarget: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.lane-plan",
      branchName: "csm/session-1-lane-plan",
      isolation: "worktree",
      laneId: "lane-plan",
    };

    const executionTargetResolver: ExecutionTargetResolver = {
      resolve: () => laneTarget,
    };

    const mergeRunner: GraphMergeRunner = {
      run: vi.fn(),
    };

    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async (commitInput) => ({
        status: "committed" as const,
        snapshot: {
          contextId: commitInput.contextId,
          sha: "lane-sha-1",
          committedAt: "2026-03-27T12:04:00.000Z",
        },
      })),
    };

    const harness = buildHarness({
      initialExecution: initial,
      executionTargetResolver,
      mergeRunner,
      laneCommitter,
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

    expect(laneCommitter.commit).toHaveBeenCalledTimes(1);
    expect(laneCommitter.commit).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "ctx-1",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
    });
    expect(mergeRunner.run).not.toHaveBeenCalled();

    const lane = result.executionLanes["lane-plan"];
    expect(lane).toBeDefined();
    expect(lane!.commitSnapshots).toEqual([
      {
        contextId: "ctx-1",
        sha: "lane-sha-1",
        committedAt: "2026-03-27T12:04:00.000Z",
      },
    ]);
    expect(lane!.lastCommittingContextId).toBe("ctx-1");
    expect(lane!.includedContextIds).toContain("ctx-1");
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-success");
    expect(result.status).toBe("completed");
  });

  it("marks the lane includedContextIds and skips snapshot append when laneCommitter reports no changes (skipped)", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const laneTarget: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.lane-plan",
      branchName: "csm/session-1-lane-plan",
      isolation: "worktree",
      laneId: "lane-plan",
    };

    const executionTargetResolver: ExecutionTargetResolver = {
      resolve: () => laneTarget,
    };

    const mergeRunner: GraphMergeRunner = { run: vi.fn() };

    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
    };

    const harness = buildHarness({
      initialExecution: initial,
      executionTargetResolver,
      mergeRunner,
      laneCommitter,
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

    expect(laneCommitter.commit).toHaveBeenCalledTimes(1);
    expect(mergeRunner.run).not.toHaveBeenCalled();

    const lane = result.executionLanes["lane-plan"];
    expect(lane).toBeDefined();
    expect(lane!.commitSnapshots).toEqual([]);
    expect(lane!.includedContextIds).toContain("ctx-1");
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-success");
    expect(result.status).toBe("completed");
  });

  it("halts with merge_failure (and does not fall through to fan-in) when laneCommitter reports failed", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const laneTarget: ExecutionTarget = {
      worktreePath: "/repo/.worktrees/session-1.lane-plan",
      branchName: "csm/session-1-lane-plan",
      isolation: "worktree",
      laneId: "lane-plan",
    };

    const mergeRunner: GraphMergeRunner = { run: vi.fn() };

    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async () => ({
        status: "failed" as const,
        errorMessage: "git commit failed on lane",
      })),
    };

    const harness = buildHarness({
      initialExecution: initial,
      executionTargetResolver: { resolve: () => laneTarget },
      mergeRunner,
      laneCommitter,
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

    expect(laneCommitter.commit).toHaveBeenCalledTimes(1);
    expect(mergeRunner.run).not.toHaveBeenCalled();
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "merge_failure",
      contextId: "ctx-1",
      message: "git commit failed on lane",
    });
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-failed");
    expect(result.contextStates["ctx-1"]?.lastMergeError).toBe(
      "git commit failed on lane",
    );
  });

  it("runs a final publish join before completing when a non-session lane is unpublished", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "merged-success",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: ["ctx-1"],
          lastCommittingContextId: "ctx-1",
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        await runInput.mutateActive((e) =>
          applyJoinProgress(e, runInput.joinId, new Date().toISOString(), {
            status: "succeeded",
          }),
        );
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error(
            "iterationOrchestrator should not run when ctx-1 is already completed",
          );
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

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    const callArgs = joinRunSpy.mock.calls[0]![0];
    const joinFromState = result.joins[callArgs.joinId];
    expect(joinFromState).toBeDefined();
    expect(joinFromState!.kind).toBe("final_publish");
    expect(joinFromState!.targetLaneId).toBe("__session__");
    expect(joinFromState!.sourceLaneIds).toEqual(["lane-plan"]);
    expect(joinFromState!.status).toBe("succeeded");
    expect(result.status).toBe("completed");
  });

  it("publishes multiple terminal lanes via a single final publish join", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "merged-success",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: ["ctx-1"],
          lastCommittingContextId: "ctx-1",
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
        "lane-docs": {
          laneId: "lane-docs",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-docs",
          branchName: "csm/session-1-lane-docs",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        await runInput.mutateActive((e) =>
          applyJoinProgress(e, runInput.joinId, new Date().toISOString(), {
            status: "succeeded",
          }),
        );
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
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

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    const callArgs = joinRunSpy.mock.calls[0]![0];
    const joinFromState = result.joins[callArgs.joinId];
    expect(joinFromState!.kind).toBe("final_publish");
    expect(joinFromState!.sourceLaneIds).toEqual(["lane-docs", "lane-plan"]);
    expect(joinFromState!.targetLaneId).toBe("__session__");
    expect(result.status).toBe("completed");
  });

  it("halts with join_failure when the final publish join fails, preserving conflict files", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-plan",
          joinId: null,
          mergeStatus: "merged-success",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-plan",
          branchName: "csm/session-1-lane-plan",
          includedContextIds: ["ctx-1"],
          lastCommittingContextId: "ctx-1",
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
    });

    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        await runInput.mutateActive((e) =>
          applyJoinProgress(e, runInput.joinId, new Date().toISOString(), {
            status: "failed",
            errorMessage: "merge conflict in shared.ts",
            conflicts: {
              files: ["shared.ts"],
              message: "merge conflict in shared.ts",
              analysis: null,
            },
          }),
        );
        return {
          status: "failed",
          message: "merge conflict in shared.ts",
          conflictFiles: ["shared.ts"],
          failedSourceLaneId: "lane-plan",
        };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
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

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "join_failure",
      joinKind: "final_publish",
      sourceLaneIds: ["lane-plan"],
      targetLaneId: "__session__",
      message: "merge conflict in shared.ts",
      conflictFiles: ["shared.ts"],
    });
  });

  it("final publish publishes only the terminal target lane after a context_merge consumes a non-terminal source", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          worktreePath: "/repo/.worktrees/session-1.lane-a",
          branchName: "csm/session-1-lane-a",
          isolation: "worktree",
          batchId: null,
          laneId: "lane-a",
          joinId: null,
          mergeStatus: "merged-success",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      executionLanes: {
        "lane-a": {
          laneId: "lane-a",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-a",
          branchName: "csm/session-1-lane-a",
          includedContextIds: ["ctx-1"],
          lastCommittingContextId: "ctx-1",
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
        "lane-b": {
          laneId: "lane-b",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/session-1.lane-b",
          branchName: "csm/session-1-lane-b",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
        },
      },
      joins: {
        "join-b-into-a": {
          joinId: "join-b-into-a",
          kind: "context_merge",
          contextId: "downstream-merge",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-b"],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-03-27T11:56:00.000Z",
          updatedAt: "2026-03-27T11:57:00.000Z",
          completedAt: "2026-03-27T11:57:00.000Z",
        },
      },
    });

    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        await runInput.mutateActive((e) =>
          applyJoinProgress(e, runInput.joinId, new Date().toISOString(), {
            status: "succeeded",
          }),
        );
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
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

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    const finalPublishCall = joinRunSpy.mock.calls[0]![0];
    const finalPublish = result.joins[finalPublishCall.joinId];
    expect(finalPublish).toBeDefined();
    expect(finalPublish!.kind).toBe("final_publish");
    expect(finalPublish!.targetLaneId).toBe("__session__");
    expect(finalPublish!.sourceLaneIds).toEqual(["lane-a"]);
    expect(finalPublish!.sourceLaneIds).not.toContain("lane-b");
    expect(result.status).toBe("completed");
  });

  it("does not plan a final publish when no worktree lanes exist", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          contextId: "ctx-1",
          status: "completed",
          totalTaskCount: 1,
          completedTaskCount: 1,
          iterationCount: 1,
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
        },
      },
    });

    const joinRunSpy = vi.fn();

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
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

    expect(joinRunSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  describe("trace context propagation", () => {
    it("runs each execution inside a workflow:<id> trace so downstream timed() logs aggregate per execution", async () => {
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition, {
        id: "exec-trace-1",
      });
      let captured: TraceContext | null = null;
      const harness = buildHarness({
        initialExecution: initial,
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            captured = getTraceContext() ?? null;
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
      await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(captured).not.toBeNull();
      expect(captured!.action).toBe("workflow:exec-trace-1");
      expect(captured!.traceId).toBeTypeOf("string");
      expect(captured!.traceId.length).toBeGreaterThan(0);
    });

    it("inherits the caller's traceId when an HTTP handler kicks off the execution, so the request and workflow group into one Speedscope stack", async () => {
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition, {
        id: "exec-trace-2",
      });
      let captured: TraceContext | null = null;
      const harness = buildHarness({
        initialExecution: initial,
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            captured = getTraceContext() ?? null;
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
      const parent: TraceContext = {
        traceId: "parent-request-trace",
        action: "request:POST /api/workflows/run",
        projectName: "test",
        sessionName: "session-1",
      };

      await runWithTrace(parent, () =>
        loop.run({
          projectPath: "/repo",
          projectName: "test",
          sessionName: "session-1",
          execution: initial,
        }),
      );

      expect(captured).not.toBeNull();
      expect(captured!.traceId).toBe("parent-request-trace");
      expect(captured!.action).toBe("workflow:exec-trace-2");
    });
  });

  describe("approval gate wait", () => {
    const pendingApprovalRecord = {
      conversationId: "conv-1",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: null,
    };

    interface ParkingHarnessInput {
      waitForApprovalProgress: GraphWorkflowExecutionLoopDeps["waitForApprovalProgress"];
      soloCommit: GraphWorkflowExecutionLoopDeps["soloContextCommitter"]["commit"];
      initialExecution: GraphWorkflowExecution;
      onIteration?: () => void;
      isConversationBusy?: GraphWorkflowExecutionLoopDeps["isConversationBusy"];
      acquireConversationLock?: GraphWorkflowExecutionLoopDeps["acquireConversationLock"];
      eventPublisher?: GraphWorkflowExecutionLoopDeps["eventPublisher"];
    }

    function buildParkingHarness(input: ParkingHarnessInput): LoopHarness {
      const harness: LoopHarness = buildHarness({
        initialExecution: input.initialExecution,
        waitForApprovalProgress: input.waitForApprovalProgress,
        isConversationBusy: input.isConversationBusy,
        acquireConversationLock: input.acquireConversationLock,
        eventPublisher: input.eventPublisher,
        soloContextCommitter: {
          commit: input.soloCommit,
        },
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            input.onIteration?.();
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            cs.iterationCount = 1;
            cs.completedTaskCount = 1;
            cs.status = "awaiting_approval";
            cs.pendingApproval = structuredClone(pendingApprovalRecord);
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
      return harness;
    }

    it("holds the runner in-flight on park without committing, then exits unresolved on abort", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition);

      let signalPollStarted!: () => void;
      const pollStarted = new Promise<void>((resolve) => {
        signalPollStarted = resolve;
      });
      let releasePoll!: () => void;
      const pollRelease = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const waitForApprovalProgress = vi.fn(async () => {
        signalPollStarted();
        await pollRelease;
      });
      const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
      let iterationCallCount = 0;

      const harness = buildParkingHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        soloCommit,
        onIteration: () => {
          iterationCallCount += 1;
        },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const runPromise = loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      await pollStarted;

      const raceOutcome = await Promise.race([
        runPromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 25),
        ),
      ]);
      expect(raceOutcome).toBe("pending");
      expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);
      expect(harness.sendSpy).not.toHaveBeenCalled();
      expect(soloCommit).not.toHaveBeenCalled();

      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releasePoll();

      const result = await runPromise;
      expect(result.status).toBe("aborted");
      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("awaiting_approval");
      expect(cs.pendingApproval).toEqual(pendingApprovalRecord);
      expect(iterationCallCount).toBe(1);
      expect(soloCommit).not.toHaveBeenCalled();
      expect(harness.sendSpy).not.toHaveBeenCalled();
      expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    });

    it.each(["paused", "halted"] as const)(
      "exits the wait without resolving when the execution becomes %s, preserving a recorded decision",
      async (suspendedStatus) => {
        _resetActiveLoopsForTesting();
        const definition = createSingleContextDefinition(5);
        const initial = createRunningExecution(definition);

        const recordedDecision = {
          type: "rejected" as const,
          message: "needs more tests",
          decidedAt: "2026-03-27T12:02:00.000Z",
        };
        const waitForApprovalProgress = vi.fn(async () => {
          const next = structuredClone(harness.getCurrent());
          next.status = suspendedStatus;
          next.contextStates["ctx-1"]!.pendingApproval!.decision =
            structuredClone(recordedDecision);
          harness.setCurrent(next);
        });
        const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
        let iterationCallCount = 0;

        const harness = buildParkingHarness({
          initialExecution: initial,
          waitForApprovalProgress,
          soloCommit,
          onIteration: () => {
            iterationCallCount += 1;
          },
        });

        const loop = createGraphWorkflowExecutionLoop(harness.deps);
        const result = await loop.run({
          projectPath: "/repo",
          projectName: "test",
          sessionName: "session-1",
          execution: initial,
        });

        expect(result.status).toBe(suspendedStatus);
        const cs = result.contextStates["ctx-1"]!;
        expect(cs.status).toBe("awaiting_approval");
        expect(cs.pendingApproval).toEqual({
          ...pendingApprovalRecord,
          decision: recordedDecision,
        });
        expect(waitForApprovalProgress).toHaveBeenCalledTimes(1);
        expect(iterationCallCount).toBe(1);
        expect(soloCommit).not.toHaveBeenCalled();
        expect(harness.sendSpy).not.toHaveBeenCalled();
        expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
      },
    );

    function findApprovalResolvedEvents(
      events: GraphWorkflowExecutionEvent[],
    ): GraphWorkflowApprovalResolvedEvent[] {
      return events
        .map((entry) => entry.event)
        .filter(
          (event): event is GraphWorkflowApprovalResolvedEvent =>
            event.type === "graph-workflow-approval-resolved",
        );
    }

    it("applies an approved decision under the conversation lock, runs the commit phase while holding it, and records approval-resolved", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition);

      const recordedDecision = {
        type: "approved" as const,
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const decision = next.contextStates["ctx-1"]!.pendingApproval?.decision;
        if (decision === null) {
          next.contextStates["ctx-1"]!.pendingApproval!.decision =
            structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const ordered: string[] = [];
      const soloCommit = vi.fn(async () => {
        ordered.push("commit");
        return { status: "skipped" as const };
      });
      const isConversationBusy = vi.fn(() => false);
      const acquireConversationLock = vi.fn(() => {
        ordered.push("lock-acquired");
        return () => {
          ordered.push("lock-released");
        };
      });
      const broadcast = vi.fn();
      let iterationCallCount = 0;

      const harness = buildParkingHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        soloCommit,
        isConversationBusy,
        acquireConversationLock,
        eventPublisher: createGraphWorkflowExecutionEventPublisher({
          broadcast,
          now: () => "2026-03-27T12:03:00.000Z",
        }),
        onIteration: () => {
          iterationCallCount += 1;
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
      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("completed");
      expect(cs.pendingApproval).toBeNull();
      expect(iterationCallCount).toBe(1);
      expect(acquireConversationLock).toHaveBeenCalledWith(
        "/repo",
        "session-1",
        "conv-1",
      );
      // The commit phase must run inside the held lock window.
      expect(ordered).toEqual(["lock-acquired", "commit", "lock-released"]);

      const resolvedEvents = findApprovalResolvedEvents(harness.appendedEvents);
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({
        contextId: "ctx-1",
        conversationId: "conv-1",
        decision: "approved",
        message: null,
        decidedAt: "2026-03-27T12:02:00.000Z",
      });
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "graph-workflow-approval-resolved",
          decision: "approved",
        }),
      );
    });

    it("applies a rejected decision under the conversation lock, re-enters the iteration loop with the remediation task, and records approval-resolved with the message", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition);

      const recordedDecision = {
        type: "rejected" as const,
        message: "needs more tests",
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const decision = next.contextStates["ctx-1"]!.pendingApproval?.decision;
        if (decision === null) {
          next.contextStates["ctx-1"]!.pendingApproval!.decision =
            structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const ordered: string[] = [];
      const soloCommit = vi.fn(async () => {
        ordered.push("commit");
        return { status: "skipped" as const };
      });
      const acquireConversationLock = vi.fn(() => {
        ordered.push("lock-acquired");
        return () => {
          ordered.push("lock-released");
        };
      });
      const broadcast = vi.fn();
      let iterationCallCount = 0;
      let secondIterationTasks: Array<{ id: string; instructions: string }> =
        [];
      let secondIterationCount = 0;

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        isConversationBusy: () => false,
        acquireConversationLock,
        eventPublisher: createGraphWorkflowExecutionEventPublisher({
          broadcast,
          now: () => "2026-03-27T12:03:00.000Z",
        }),
        soloContextCommitter: { commit: soloCommit },
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            iterationCallCount += 1;
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            if (iterationCallCount === 1) {
              cs.iterationCount = 1;
              cs.completedTaskCount = 1;
              cs.status = "awaiting_approval";
              cs.pendingApproval = structuredClone(pendingApprovalRecord);
              next.taskStates["task-1"]!.status = "completed";
              next.activeContextIds = [];
            } else {
              secondIterationTasks = next.workingDefinition.tasks.map(
                (task) => ({ id: task.id, instructions: task.instructions }),
              );
              secondIterationCount = cs.iterationCount + 1;
              cs.iterationCount = secondIterationCount;
              for (const taskState of Object.values(next.taskStates)) {
                taskState.status = "completed";
              }
              cs.completedTaskCount = next.workingDefinition.tasks.length;
              cs.status = "completed";
              next.activeContextIds = [];
            }
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
      expect(iterationCallCount).toBe(2);

      // Remediation seeding happens under the lock, before re-entering the
      // iteration loop; the commit phase runs only after the context
      // completes its remediation iteration.
      expect(ordered).toEqual(["lock-acquired", "lock-released", "commit"]);

      // The next iteration sees the appended remediation task carrying the
      // operator's message.
      const remediationTask = secondIterationTasks.find(
        (task) => task.id === "task-ctx-1-rejection-1",
      );
      expect(remediationTask).toBeDefined();
      expect(remediationTask?.instructions).toContain("needs more tests");

      const cs = result.contextStates["ctx-1"]!;
      expect(cs.pendingApproval).toBeNull();
      expect(cs.totalTaskCount).toBe(2);
      expect(cs.iterationCount).toBe(2);
      expect(cs.consecutiveFailureCount).toBe(0);

      const resolvedEvents = findApprovalResolvedEvents(harness.appendedEvents);
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({
        contextId: "ctx-1",
        conversationId: "conv-1",
        decision: "rejected",
        message: "needs more tests",
        decidedAt: "2026-03-27T12:02:00.000Z",
      });
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "graph-workflow-approval-resolved",
          decision: "rejected",
          message: "needs more tests",
        }),
      );
    });

    it("defers decision application until the conversation lock frees when the conversation is busy", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition);

      const recordedDecision = {
        type: "approved" as const,
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const decision = next.contextStates["ctx-1"]!.pendingApproval?.decision;
        if (decision === null) {
          next.contextStates["ctx-1"]!.pendingApproval!.decision =
            structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const ordered: string[] = [];
      let busyProbeCount = 0;
      const isConversationBusy = vi.fn(() => {
        busyProbeCount += 1;
        const busy = busyProbeCount <= 2;
        ordered.push(`probe:${busy}`);
        return busy;
      });
      const acquireConversationLock = vi.fn(() => {
        ordered.push("lock-acquired");
        return () => {
          ordered.push("lock-released");
        };
      });
      const soloCommit = vi.fn(async () => {
        ordered.push("commit");
        return { status: "skipped" as const };
      });

      const harness = buildParkingHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        soloCommit,
        isConversationBusy,
        acquireConversationLock,
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(result.status).toBe("completed");
      expect(result.contextStates["ctx-1"]?.status).toBe("completed");
      // One poll observing the decision, plus one per busy probe.
      expect(waitForApprovalProgress).toHaveBeenCalledTimes(3);
      expect(ordered).toEqual([
        "probe:true",
        "probe:true",
        "probe:false",
        "lock-acquired",
        "commit",
        "lock-released",
      ]);
    });

    it.each(["aborted", "paused", "halted"] as const)(
      "exits the busy deferral without applying when the execution becomes %s, preserving the recorded decision",
      async (exitStatus) => {
        _resetActiveLoopsForTesting();
        const definition = createSingleContextDefinition(5);
        const initial = createRunningExecution(definition);

        const recordedDecision = {
          type: "approved" as const,
          decidedAt: "2026-03-27T12:02:00.000Z",
        };
        // First wait (gate poll) records the decision; the next wait (busy
        // deferral) flips the execution out of running, simulating an abort
        // landing while a chat turn holds the conversation busy.
        const waitForApprovalProgress = vi.fn(async () => {
          const next = structuredClone(harness.getCurrent());
          const pending = next.contextStates["ctx-1"]!.pendingApproval!;
          if (pending.decision === null) {
            pending.decision = structuredClone(recordedDecision);
          } else {
            next.status = exitStatus;
          }
          harness.setCurrent(next);
        });
        const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
        let busyProbeCount = 0;
        const isConversationBusy = vi.fn(() => {
          busyProbeCount += 1;
          return busyProbeCount <= 1;
        });
        const acquireConversationLock = vi.fn(() => () => {});
        const broadcast = vi.fn();

        const harness = buildParkingHarness({
          initialExecution: initial,
          waitForApprovalProgress,
          soloCommit,
          isConversationBusy,
          acquireConversationLock,
          eventPublisher: createGraphWorkflowExecutionEventPublisher({
            broadcast,
            now: () => "2026-03-27T12:03:00.000Z",
          }),
        });

        const loop = createGraphWorkflowExecutionLoop(harness.deps);
        const result = await loop.run({
          projectPath: "/repo",
          projectName: "test",
          sessionName: "session-1",
          execution: initial,
        });

        expect(result.status).toBe(exitStatus);
        const cs = result.contextStates["ctx-1"]!;
        expect(cs.status).toBe("awaiting_approval");
        expect(cs.pendingApproval).toEqual({
          ...pendingApprovalRecord,
          decision: recordedDecision,
        });
        expect(acquireConversationLock).not.toHaveBeenCalled();
        expect(soloCommit).not.toHaveBeenCalled();
        expect(findApprovalResolvedEvents(harness.appendedEvents)).toHaveLength(
          0,
        );
        expect(broadcast).not.toHaveBeenCalled();
        expect(harness.sendSpy).not.toHaveBeenCalled();
      },
    );

    it("leaves the execution untouched when it aborts between lock acquisition and decision application", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createRunningExecution(definition);

      const recordedDecision = {
        type: "rejected" as const,
        message: "needs more tests",
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const pending = next.contextStates["ctx-1"]!.pendingApproval;
        if (pending && pending.decision === null) {
          pending.decision = structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
      const release = vi.fn();
      // The abort lands in the window between lock acquisition and the apply
      // mutation; the mutation-level guard must observe it atomically.
      const acquireConversationLock = vi.fn(() => {
        const next = structuredClone(harness.getCurrent());
        next.status = "aborted";
        harness.setCurrent(next);
        return release;
      });
      const broadcast = vi.fn();
      let iterationCallCount = 0;

      const harness = buildParkingHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        soloCommit,
        isConversationBusy: () => false,
        acquireConversationLock,
        eventPublisher: createGraphWorkflowExecutionEventPublisher({
          broadcast,
          now: () => "2026-03-27T12:03:00.000Z",
        }),
        onIteration: () => {
          iterationCallCount += 1;
        },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(result.status).toBe("aborted");
      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("awaiting_approval");
      expect(cs.pendingApproval).toEqual({
        ...pendingApprovalRecord,
        decision: recordedDecision,
      });
      expect(cs.totalTaskCount).toBe(1);
      // The rejected path must not launch a fresh iteration post-abort.
      expect(iterationCallCount).toBe(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(soloCommit).not.toHaveBeenCalled();
      expect(findApprovalResolvedEvents(harness.appendedEvents)).toHaveLength(
        0,
      );
      expect(broadcast).not.toHaveBeenCalled();
      expect(harness.sendSpy).not.toHaveBeenCalled();
    });

    it("halts with max_iterations when a rejection consumes the final allowed iteration", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(2);
      const initial = createRunningExecution(definition);

      const recordedDecision = {
        type: "rejected" as const,
        message: "still wrong",
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const decision = next.contextStates["ctx-1"]!.pendingApproval?.decision;
        if (decision === null) {
          next.contextStates["ctx-1"]!.pendingApproval!.decision =
            structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
      let iterationCallCount = 0;

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        isConversationBusy: () => false,
        acquireConversationLock: () => () => {},
        soloContextCommitter: { commit: soloCommit },
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            iterationCallCount += 1;
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            cs.iterationCount = iterationCallCount;
            cs.completedTaskCount = next.workingDefinition.tasks.length;
            cs.status = "awaiting_approval";
            cs.pendingApproval = {
              conversationId: "conv-1",
              requestedAt: `2026-03-27T12:0${iterationCallCount}:00.000Z`,
              decision: null,
            };
            for (const taskState of Object.values(next.taskStates)) {
              taskState.status = "completed";
            }
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

      expect(iterationCallCount).toBe(2);
      expect(result.status).toBe("halted");
      expect(result.haltReason).toEqual({
        type: "max_iterations",
        contextId: "ctx-1",
        iterationCount: 2,
      });
      // The second park is never resolved: the iteration limit halts the
      // context before the gate wait re-enters.
      expect(waitForApprovalProgress).toHaveBeenCalledTimes(1);
      expect(soloCommit).not.toHaveBeenCalled();
    });
  });

  describe("approval gate resume re-entry", () => {
    const pendingApprovalRecord = {
      conversationId: "conv-1",
      requestedAt: "2026-03-27T12:01:00.000Z",
      decision: null,
    };

    function createParkedExecution(
      definition: WorkflowSemanticDefinition,
    ): GraphWorkflowExecution {
      const execution = createRunningExecution(definition);
      const cs = execution.contextStates["ctx-1"]!;
      cs.status = "awaiting_approval";
      cs.iterationCount = 1;
      cs.completedTaskCount = 1;
      cs.pendingApproval = structuredClone(pendingApprovalRecord);
      execution.taskStates["task-1"]!.status = "completed";
      return execution;
    }

    function findApprovalResolvedEvents(
      events: GraphWorkflowExecutionEvent[],
    ): GraphWorkflowApprovalResolvedEvent[] {
      return events
        .map((entry) => entry.event)
        .filter(
          (event): event is GraphWorkflowApprovalResolvedEvent =>
            event.type === "graph-workflow-approval-resolved",
        );
    }

    it("re-enters a persisted parked context directly into the gate wait and applies the decision without seeding an iteration", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedExecution(definition);

      const recordedDecision = {
        type: "approved" as const,
        decidedAt: "2026-03-27T12:02:00.000Z",
      };
      const waitForApprovalProgress = vi.fn(async () => {
        const next = structuredClone(harness.getCurrent());
        const pending = next.contextStates["ctx-1"]!.pendingApproval;
        if (pending && pending.decision === null) {
          pending.decision = structuredClone(recordedDecision);
          harness.setCurrent(next);
        }
      });
      const ordered: string[] = [];
      const soloCommit = vi.fn(async () => {
        ordered.push("commit");
        return { status: "skipped" as const };
      });
      const acquireConversationLock = vi.fn(() => {
        ordered.push("lock-acquired");
        return () => {
          ordered.push("lock-released");
        };
      });
      const runIteration = vi.fn(
        async (): Promise<GraphWorkflowIterationResult> => {
          throw new Error(
            "no iteration may be seeded for a parked context on resume",
          );
        },
      );
      const broadcast = vi.fn();

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        isConversationBusy: () => false,
        acquireConversationLock,
        eventPublisher: createGraphWorkflowExecutionEventPublisher({
          broadcast,
          now: () => "2026-03-27T12:03:00.000Z",
        }),
        soloContextCommitter: { commit: soloCommit },
        iterationOrchestrator: { runIteration },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(runIteration).not.toHaveBeenCalled();
      expect(result.status).toBe("completed");
      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("completed");
      expect(cs.pendingApproval).toBeNull();
      // The commit phase runs inside the held conversation lock window.
      expect(ordered).toEqual(["lock-acquired", "commit", "lock-released"]);

      const resolvedEvents = findApprovalResolvedEvents(harness.appendedEvents);
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({
        contextId: "ctx-1",
        conversationId: "conv-1",
        decision: "approved",
        decidedAt: "2026-03-27T12:02:00.000Z",
      });
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "graph-workflow-approval-resolved",
          decision: "approved",
        }),
      );
    });

    it("applies a rejection recorded while the execution was suspended on the first wait refresh after resume", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedExecution(definition);
      initial.contextStates["ctx-1"]!.pendingApproval = {
        ...structuredClone(pendingApprovalRecord),
        decision: {
          type: "rejected",
          message: "needs more tests",
          decidedAt: "2026-03-27T12:02:00.000Z",
        },
      };

      const waitForApprovalProgress = vi.fn(async () => {});
      const ordered: string[] = [];
      const soloCommit = vi.fn(async () => {
        ordered.push("commit");
        return { status: "skipped" as const };
      });
      const acquireConversationLock = vi.fn(() => {
        ordered.push("lock-acquired");
        return () => {
          ordered.push("lock-released");
        };
      });
      const broadcast = vi.fn();
      let remediationIterationTasks: Array<{
        id: string;
        instructions: string;
      }> = [];
      const runIteration = vi.fn(
        async (): Promise<GraphWorkflowIterationResult> => {
          const next = structuredClone(harness.getCurrent());
          const cs = next.contextStates["ctx-1"]!;
          remediationIterationTasks = next.workingDefinition.tasks.map(
            (task) => ({ id: task.id, instructions: task.instructions }),
          );
          cs.iterationCount += 1;
          for (const taskState of Object.values(next.taskStates)) {
            taskState.status = "completed";
          }
          cs.completedTaskCount = next.workingDefinition.tasks.length;
          cs.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-1",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      );

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        isConversationBusy: () => false,
        acquireConversationLock,
        eventPublisher: createGraphWorkflowExecutionEventPublisher({
          broadcast,
          now: () => "2026-03-27T12:03:00.000Z",
        }),
        soloContextCommitter: { commit: soloCommit },
        iterationOrchestrator: { runIteration },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      expect(result.status).toBe("completed");
      // The wait observes the suspended-recorded decision on its first
      // refresh; the only iteration is the remediation one.
      expect(runIteration).toHaveBeenCalledTimes(1);
      expect(ordered).toEqual(["lock-acquired", "lock-released", "commit"]);

      const remediationTask = remediationIterationTasks.find(
        (task) => task.id === "task-ctx-1-rejection-1",
      );
      expect(remediationTask).toBeDefined();
      expect(remediationTask?.instructions).toContain("needs more tests");

      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("completed");
      expect(cs.pendingApproval).toBeNull();
      expect(cs.totalTaskCount).toBe(2);
      expect(cs.iterationCount).toBe(2);

      const resolvedEvents = findApprovalResolvedEvents(harness.appendedEvents);
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]).toMatchObject({
        contextId: "ctx-1",
        conversationId: "conv-1",
        decision: "rejected",
        message: "needs more tests",
      });
    });

    it("stays in-flight without completing or exiting when the only remaining context is parked", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedExecution(definition);

      let signalPollStarted!: () => void;
      const pollStarted = new Promise<void>((resolve) => {
        signalPollStarted = resolve;
      });
      let releasePoll!: () => void;
      const pollRelease = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const waitForApprovalProgress = vi.fn(async () => {
        signalPollStarted();
        await pollRelease;
      });
      const soloCommit = vi.fn(async () => ({ status: "skipped" as const }));
      const runIteration = vi.fn(
        async (): Promise<GraphWorkflowIterationResult> => {
          throw new Error(
            "no iteration may be seeded for a parked context on resume",
          );
        },
      );

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForApprovalProgress,
        soloContextCommitter: { commit: soloCommit },
        iterationOrchestrator: { runIteration },
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const runPromise = loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      await pollStarted;

      const raceOutcome = await Promise.race([
        runPromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 25),
        ),
      ]);
      expect(raceOutcome).toBe("pending");
      expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);
      expect(harness.sendSpy).not.toHaveBeenCalled();
      expect(runIteration).not.toHaveBeenCalled();
      expect(soloCommit).not.toHaveBeenCalled();

      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releasePoll();

      const result = await runPromise;
      expect(result.status).toBe("aborted");
      const cs = result.contextStates["ctx-1"]!;
      expect(cs.status).toBe("awaiting_approval");
      expect(cs.pendingApproval).toEqual(pendingApprovalRecord);
      expect(harness.sendSpy).not.toHaveBeenCalled();
      expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    });
  });
});
