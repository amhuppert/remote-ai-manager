import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionTarget,
  ExecutionTargetResolver,
} from "@/lib/workflow-graph/execution-target-resolver";
import type { GraphMergeRunner } from "@/lib/workflow-graph/graph-merge-runner";
import { planContextJoin } from "@/lib/workflow-graph/lane-join";
import { applyJoinProgress } from "@/lib/workflow-graph/context-transitions";
import { classifyContextSchedulability } from "@/lib/workflow-graph/lane-readiness";
import type { JoinRunner } from "@/lib/workflow-graph/join-runner";
import type { ParallelWorktrees } from "@/lib/workflow-graph/parallel-worktrees";
import type { PerSessionMergeMutex } from "@/lib/workflow-graph/per-session-merge-mutex";
import type { SessionGitLock } from "@/lib/shared/lock-retry";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowApprovalResolvedEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowUserInputResolvedEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  createUserInputGateService,
  type ResumeUserInputContext,
} from "./user-input-gate";
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
import { AgentTurnFailedError } from "./errors";
import { StaleLoopFenceError } from "./loop-fence";
import type { GraphWorkflowIterationResult } from "./iteration-orchestrator";
import type {
  RecordPendingHaltReasonResult,
  ScheduleEligibleContextsResult,
} from "./workflow-manager";
import {
  registerExecutionLogger,
  unregisterExecutionLogger,
  type ExecutionLogger,
} from "./execution-logger";
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
    contextStates: {
      "ctx-1": {
        pendingApproval: null,
        pendingUserInput: null,
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

function baseContextState(
  contextId: string,
): GraphWorkflowExecution["contextStates"][string] {
  return {
    pendingApproval: null,
    pendingUserInput: null,
    contextId,
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
}

function baseTaskState(
  taskId: string,
  contextId: string,
): GraphWorkflowExecution["taskStates"][string] {
  return {
    taskId,
    contextId,
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

function createTestDefinition(
  contextIds: string[],
  edges: Array<[sourceContextId: string, targetContextId: string]>,
): WorkflowSemanticDefinition {
  const base = createSingleContextDefinition(5);
  const contextTemplate = base.executionContexts[0]!;
  const taskTemplate = base.tasks[0]!;
  return {
    ...base,
    executionContexts: contextIds.map((contextId) => ({
      ...contextTemplate,
      id: contextId,
      title: contextId,
      description: contextId,
    })),
    tasks: contextIds.map((contextId) => ({
      ...taskTemplate,
      id: `task-${contextId}`,
      contextId,
      title: `Task ${contextId}`,
    })),
    edges: edges.map(([sourceContextId, targetContextId], index) => ({
      id: `edge-${index + 1}`,
      sourceContextId,
      targetContextId,
    })),
  };
}

function completedWorktreeContext(
  contextId: string,
  laneId: string,
): GraphWorkflowExecution["contextStates"][string] {
  return {
    ...baseContextState(contextId),
    status: "completed",
    completedTaskCount: 1,
    iterationCount: 1,
    worktreePath: `/repo/.worktrees/session-1.${laneId}`,
    branchName: `csm/session-1-${laneId}`,
    isolation: "worktree",
    laneId,
    mergeStatus: "merged-success",
  };
}

function worktreeLane(
  laneId: string,
  includedContextIds: string[],
): GraphWorkflowExecution["executionLanes"][string] {
  return {
    laneId,
    kind: "worktree",
    status: "active",
    worktreePath: `/repo/.worktrees/session-1.${laneId}`,
    branchName: `csm/session-1-${laneId}`,
    includedContextIds,
    lastCommittingContextId: includedContextIds.at(-1) ?? null,
    commitSnapshots: [],
    createdAt: "2026-03-27T11:40:00.000Z",
    updatedAt: "2026-03-27T11:50:00.000Z",
  };
}

function createEagerJoinFixture(options: { sourceBCompleted?: boolean } = {}): {
  definition: WorkflowSemanticDefinition;
  initialExecution: GraphWorkflowExecution;
} {
  const definition = createTestDefinition(
    ["source-a", "source-b", "unrelated", "downstream", "integration"],
    [
      ["source-a", "downstream"],
      ["source-b", "downstream"],
      ["downstream", "integration"],
    ],
  );
  const sourceBCompleted = options.sourceBCompleted ?? false;
  const initialExecution = createRunningExecution(definition, {
    contextStates: {
      "source-a": completedWorktreeContext("source-a", "lane-a"),
      "source-b": sourceBCompleted
        ? completedWorktreeContext("source-b", "lane-b")
        : baseContextState("source-b"),
      unrelated: baseContextState("unrelated"),
      downstream: baseContextState("downstream"),
      integration: baseContextState("integration"),
    },
    taskStates: {
      "task-source-a": {
        ...baseTaskState("task-source-a", "source-a"),
        status: "completed",
        completedAt: "2026-03-27T11:45:00.000Z",
      },
      "task-source-b": sourceBCompleted
        ? {
            ...baseTaskState("task-source-b", "source-b"),
            status: "completed",
            completedAt: "2026-03-27T11:50:00.000Z",
          }
        : baseTaskState("task-source-b", "source-b"),
      "task-unrelated": baseTaskState("task-unrelated", "unrelated"),
      "task-downstream": baseTaskState("task-downstream", "downstream"),
      "task-integration": baseTaskState("task-integration", "integration"),
    },
    executionLanes: {
      "lane-a": worktreeLane("lane-a", ["source-a"]),
      "lane-b": worktreeLane("lane-b", sourceBCompleted ? ["source-b"] : []),
      "lane-unrelated": worktreeLane("lane-unrelated", []),
    },
  });
  return { definition, initialExecution };
}

function scheduleDisjointUpstreams(
  execution: GraphWorkflowExecution,
): ScheduleEligibleContextsResult {
  const next = structuredClone(execution);
  next.activeContextIds = ["source-b", "unrelated"];
  Object.assign(next.contextStates["source-b"]!, {
    status: "running",
    worktreePath: "/repo/.worktrees/session-1.lane-b",
    branchName: "csm/session-1-lane-b",
    isolation: "worktree",
    laneId: "lane-b",
    batchId: "batch-upstreams",
  });
  Object.assign(next.contextStates.unrelated!, {
    status: "running",
    worktreePath: "/repo/.worktrees/session-1.lane-unrelated",
    branchName: "csm/session-1-lane-unrelated",
    isolation: "worktree",
    laneId: "lane-unrelated",
    batchId: "batch-upstreams",
  });
  return {
    execution: next,
    scheduled: {
      kind: "parallel",
      batchId: "batch-upstreams",
      contextIds: ["source-b", "unrelated"],
    },
  };
}

function completeTestContext(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecution {
  const next = structuredClone(execution);
  next.contextStates[contextId]!.status = "completed";
  next.contextStates[contextId]!.completedTaskCount = 1;
  next.contextStates[contextId]!.iterationCount = 1;
  next.taskStates[`task-${contextId}`]!.status = "completed";
  next.activeContextIds = next.activeContextIds.filter(
    (activeContextId) => activeContextId !== contextId,
  );
  return next;
}

function createTwoParkedContextDefinition(): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: makeTestCharter(),
    parameters: [],
    prerequisites: [],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Context one",
        description: "First",
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      },
      {
        id: "ctx-2",
        title: "Context two",
        description: "Second",
        acceptanceCriteria: "TBD",
        implementer: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
        mutability: { allowAgentTaskAdd: false },
        circuitBreaker: {},
        iterationPolicy: { maxIterations: 5, continuity: { enabled: true } },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Task one",
        instructions: "Do the thing.",
        source: "user" as const,
      },
      {
        id: "task-2",
        contextId: "ctx-2",
        order: 1,
        title: "Task two",
        instructions: "Do the other thing.",
        source: "user" as const,
      },
    ],
    edges: [],
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
  waitForUserInputProgress?: GraphWorkflowExecutionLoopDeps["waitForUserInputProgress"];
  userInputGateService?: GraphWorkflowExecutionLoopDeps["userInputGateService"];
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
      // Mirrors the manager: a pending halt reason only targets a running
      // loop's drain path; transitions own non-running state.
      if (e.status !== "running") {
        return { execution: e, accepted: false };
      }
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
      resolveHead: async () => null,
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
    waitForUserInputProgress: input.waitForUserInputProgress,
    userInputGateService: input.userInputGateService,
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

  it("shares active loop state with a separately loaded module instance", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
    });
    let releaseIteration!: () => void;
    const iterationGate = new Promise<void>((resolve) => {
      releaseIteration = resolve;
    });

    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          await iterationGate;
          const next = structuredClone(harness.getCurrent());
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

    _resetActiveLoopsForTesting();
    const runPromise = createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });
    await vi.waitFor(() => {
      expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);
    });

    try {
      vi.resetModules();
      const freshInstance = await import("./execution-loop");

      expect(freshInstance.isExecutionLoopActive("/repo", "session-1")).toBe(
        true,
      );
    } finally {
      releaseIteration();
      await runPromise;
    }
  });

  it("retries once when the iteration fails with a stream-closed error", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
            backend: "claude",
            refKind: "conversation",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-1",
            sessionRef: { backend: "claude", ref: "conv-1" },
            metrics: { rotateBeforeNextTurn: false },
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
        if (lane?.backend === "claude") {
          lane.metrics.rotateBeforeNextTurn = true;
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

  it("recovers once, on a fresh rotated conversation, when the implementer turn stalls", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
            backend: "codex",
            refKind: "conversation",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-1",
            sessionRef: { backend: "codex", ref: "thread-1" },
            metrics: { rotateBeforeNextTurn: false },
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
          errorMessage:
            "Prompt execution stalled: no agent activity for 1200000ms",
        });
        const next = structuredClone(harness.getCurrent());
        next.contextStates["ctx-1"]!.status = "ready";
        const lane = next.laneStates["ctx-1"]?.["implementer"];
        if (lane?.backend === "codex") {
          lane.metrics.rotateBeforeNextTurn = true;
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
            throw new AgentTurnFailedError(
              "Prompt execution stalled: no agent activity for 1200000ms",
              {
                contextId: "ctx-1",
                engine: "codex",
                cause: "stall",
                originalMessage:
                  "Prompt execution stalled: no agent activity for 1200000ms",
              },
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
    expect(result.status).toBe("completed");
  });

  it("halts with the stall cause when a second stall follows the recovery attempt", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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

    const stallError = () =>
      new AgentTurnFailedError(
        "Prompt execution stalled: no agent activity for 1200000ms",
        {
          contextId: "ctx-1",
          engine: "codex",
          cause: "stall",
          originalMessage:
            "Prompt execution stalled: no agent activity for 1200000ms",
        },
      );

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
          throw stallError();
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
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "agent_turn_failed",
      cause: "stall",
    });
  });

  it("retries once when the iteration fails before prompt delivery", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      activeContextIds: ["ctx-1"],
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
            backend: "claude",
            refKind: "conversation",
            lane: "implementer",
            contextId: "ctx-1",
            workflowConversationId: "conv-1",
            sessionRef: { backend: "claude", ref: "conv-1" },
            metrics: { rotateBeforeNextTurn: false },
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
        if (lane?.backend === "claude") {
          lane.metrics.rotateBeforeNextTurn = true;
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
            pendingUserInput: null,
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
              backend: "claude",
              refKind: "conversation",
              lane: "implementer",
              contextId: "ctx-1",
              workflowConversationId: "conv-1",
              sessionRef: { backend: "claude", ref: "conv-1" },
              metrics: { rotateBeforeNextTurn: false },
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
          if (lane?.backend === "claude") {
            lane.metrics.rotateBeforeNextTurn = true;
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
        candidateValidation: null,
        haltReason: null,
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
          pendingUserInput: null,
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
          pendingUserInput: null,
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
      resolveHead: async () => null,
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
      preTurnHeadSha: null,
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

  it("captures the lane HEAD before the turn and records an adopted snapshot when the implementer self-committed (worktree clean, HEAD moved)", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
      resolveHead: vi.fn(async () => "head-before-turn"),
      commit: vi.fn(async (commitInput) =>
        commitInput.preTurnHeadSha === "head-before-turn"
          ? {
              status: "adopted" as const,
              snapshot: {
                contextId: commitInput.contextId,
                sha: "head-after-selfcommit",
                committedAt: "2026-03-27T12:04:00.000Z",
              },
            }
          : { status: "skipped" as const },
      ),
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

    // The pre-turn HEAD is captured against the lane worktree and delivered
    // into the commit phase; the committer's adopted snapshot lands exactly
    // like a committed one.
    expect(laneCommitter.resolveHead).toHaveBeenCalledTimes(1);
    expect(laneCommitter.resolveHead).toHaveBeenCalledWith(
      "/repo/.worktrees/session-1.lane-plan",
    );
    expect(laneCommitter.commit).toHaveBeenCalledTimes(1);
    expect(laneCommitter.commit).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "ctx-1",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-before-turn",
    });
    expect(mergeRunner.run).not.toHaveBeenCalled();

    const lane = result.executionLanes["lane-plan"];
    expect(lane).toBeDefined();
    expect(lane!.commitSnapshots).toEqual([
      {
        contextId: "ctx-1",
        sha: "head-after-selfcommit",
        committedAt: "2026-03-27T12:04:00.000Z",
      },
    ]);
    expect(lane!.lastCommittingContextId).toBe("ctx-1");
    expect(lane!.includedContextIds).toContain("ctx-1");
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-success");
    expect(result.contextStates["ctx-1"]?.lastMergeError).toBeNull();
    expect(result.status).toBe("completed");
  });

  it("records the solo commit as a session-lane snapshot so single-context session runs carry commit evidence", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);

    const soloContextCommitter = {
      commit: vi.fn(async () => ({
        status: "committed" as const,
        hash: "solo-commit-sha",
      })),
    };
    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
      resolveHead: vi.fn(async () => "session-head-0"),
    };

    const harness = buildHarness({
      initialExecution: initial,
      soloContextCommitter,
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

    expect(result.status).toBe("completed");
    const sessionLane = result.executionLanes["__session__"];
    expect(sessionLane?.kind).toBe("session");
    expect(sessionLane?.commitSnapshots).toEqual([
      expect.objectContaining({ contextId: "ctx-1", sha: "solo-commit-sha" }),
    ]);
    expect(sessionLane?.includedContextIds).toContain("ctx-1");
  });

  it("adopts the moved session HEAD when the solo implementer self-committed", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);

    const soloContextCommitter = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
    };
    const resolveHead = vi
      .fn<(worktreePath: string) => Promise<string | null>>()
      .mockResolvedValueOnce("session-head-0")
      .mockResolvedValue("session-head-after-selfcommit");
    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
      resolveHead,
    };

    const harness = buildHarness({
      initialExecution: initial,
      soloContextCommitter,
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

    expect(result.status).toBe("completed");
    // Baseline captured against the session worktree before the turn.
    expect(resolveHead).toHaveBeenCalledWith("/repo/.worktrees/session-1");
    const sessionLane = result.executionLanes["__session__"];
    expect(sessionLane?.commitSnapshots).toEqual([
      expect.objectContaining({
        contextId: "ctx-1",
        sha: "session-head-after-selfcommit",
      }),
    ]);
  });

  it("records no session-lane snapshot when the solo commit skips with an unmoved HEAD", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);

    const soloContextCommitter = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
    };
    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      commit: vi.fn(async () => ({ status: "skipped" as const })),
      resolveHead: vi.fn(async () => "session-head-0"),
    };

    const harness = buildHarness({
      initialExecution: initial,
      soloContextCommitter,
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

    expect(result.status).toBe("completed");
    const sessionLane = result.executionLanes["__session__"];
    expect(sessionLane?.commitSnapshots ?? []).toEqual([]);
  });

  it("tolerates a failing pre-turn HEAD capture: the commit phase runs with a null baseline and the context still completes", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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

    const laneCommitter: GraphWorkflowExecutionLoopDeps["laneCommitter"] = {
      resolveHead: vi.fn(async () => {
        throw new Error("rev-parse failed");
      }),
      commit: vi.fn(async () => ({ status: "skipped" as const })),
    };

    const harness = buildHarness({
      initialExecution: initial,
      executionTargetResolver: { resolve: () => laneTarget },
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

    expect(laneCommitter.commit).toHaveBeenCalledWith(
      expect.objectContaining({ preTurnHeadSha: null }),
    );
    expect(result.contextStates["ctx-1"]?.mergeStatus).toBe("merged-success");
    expect(result.status).toBe("completed");
  });

  it("marks the lane includedContextIds and skips snapshot append when laneCommitter reports no changes (skipped)", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
      resolveHead: async () => null,
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
          pendingUserInput: null,
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
      resolveHead: async () => null,
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

  it("runs a required context join before dispatching a directly schedulable sibling", async () => {
    const definition = createTestDefinition(
      ["foundation", "references", "list-board", "detail", "integration"],
      [
        ["foundation", "list-board"],
        ["foundation", "detail"],
        ["references", "detail"],
        ["list-board", "integration"],
        ["detail", "integration"],
      ],
    );
    const initial = createRunningExecution(definition, {
      contextStates: {
        foundation: completedWorktreeContext("foundation", "lane-foundation"),
        references: completedWorktreeContext("references", "lane-references"),
        "list-board": baseContextState("list-board"),
        detail: baseContextState("detail"),
        integration: baseContextState("integration"),
      },
      taskStates: {
        "task-foundation": {
          ...baseTaskState("task-foundation", "foundation"),
          status: "completed",
          completedAt: "2026-03-27T11:45:00.000Z",
        },
        "task-references": {
          ...baseTaskState("task-references", "references"),
          status: "completed",
          completedAt: "2026-03-27T11:50:00.000Z",
        },
        "task-list-board": baseTaskState("task-list-board", "list-board"),
        "task-detail": baseTaskState("task-detail", "detail"),
        "task-integration": baseTaskState("task-integration", "integration"),
      },
      executionLanes: {
        "lane-foundation": worktreeLane("lane-foundation", ["foundation"]),
        "lane-references": worktreeLane("lane-references", ["references"]),
      },
    });

    const callOrder: string[] = [];
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        callOrder.push("join-runner");
        expect(harness.getCurrent().executionLanes.__session__).toBeUndefined();
        await runInput.mutateActive((execution) =>
          applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T11:55:00.000Z",
            { status: "succeeded" },
          ),
        );
        return { status: "succeeded" };
      },
    );

    let releaseIterations!: () => void;
    const bothIterationsStarted = new Promise<void>((resolve) => {
      releaseIterations = resolve;
    });
    const startedContextIds = new Set<string>();
    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 2,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        callOrder.push("scheduler");
        const current = harness.getCurrent();
        const succeededJoin = Object.values(current.joins).find(
          (join) =>
            join.kind === "context_merge" &&
            join.contextId === "detail" &&
            join.status === "succeeded",
        );
        expect(succeededJoin).toBeDefined();

        const next = structuredClone(current);
        next.activeContextIds = ["list-board", "detail"];
        Object.assign(next.contextStates["list-board"]!, {
          status: "running",
          batchId: "batch-ticket-ui",
          worktreePath: "/repo/.worktrees/session-1.lane-foundation",
          branchName: "csm/session-1-lane-foundation",
          isolation: "worktree",
          laneId: "lane-foundation",
        });
        Object.assign(next.contextStates.detail!, {
          status: "running",
          batchId: "batch-ticket-ui",
          worktreePath: "/repo/.worktrees/session-1.lane-references",
          branchName: "csm/session-1-lane-references",
          isolation: "worktree",
          laneId: "lane-references",
        });
        harness.setCurrent(next);
        return {
          execution: next,
          scheduled: {
            kind: "parallel",
            batchId: "batch-ticket-ui",
            contextIds: ["list-board", "detail"],
          },
        };
      },
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const contextState = execution.contextStates[contextId]!;
          return {
            worktreePath: contextState.worktreePath!,
            branchName: contextState.branchName!,
            isolation: "worktree",
            laneId: contextState.laneId,
          };
        },
      },
      iterationOrchestrator: {
        async runIteration({
          contextId,
        }): Promise<GraphWorkflowIterationResult> {
          callOrder.push(`iteration:${contextId}`);
          expect(
            harness.getCurrent().contextStates[
              contextId === "list-board" ? "detail" : "list-board"
            ]?.status,
          ).toBe("running");
          startedContextIds.add(contextId);
          if (startedContextIds.size === 2) releaseIterations();
          await bothIterationsStarted;

          const next = structuredClone(harness.getCurrent());
          next.contextStates[contextId]!.status = "completed";
          next.contextStates[contextId]!.completedTaskCount = 1;
          next.contextStates[contextId]!.iterationCount = 1;
          next.taskStates[`task-${contextId}`]!.status = "completed";
          next.activeContextIds = next.activeContextIds.filter(
            (activeContextId) => activeContextId !== contextId,
          );
          next.status = "aborted";
          harness.setCurrent(next);
          return {
            conversationId: `conv-${contextId}`,
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

    expect(callOrder).toEqual([
      "join-runner",
      "scheduler",
      "iteration:list-board",
      "iteration:detail",
    ]);
    expect(startedContextIds).toEqual(new Set(["list-board", "detail"]));
    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    const join = result.joins[joinRunSpy.mock.calls[0]![0].joinId];
    expect(join).toMatchObject({
      kind: "context_merge",
      contextId: "detail",
      sourceLaneIds: ["lane-foundation", "lane-references"],
      status: "succeeded",
    });
    expect(join?.sourceLaneIds).toContain(join?.targetLaneId);
    expect(result.contextStates["list-board"]?.status).toBe("completed");
    expect(result.contextStates.detail?.status).toBe("completed");
  });

  it("does not claim an eager join when draining begins between selection and persistence", async () => {
    const { initialExecution: initial } = createEagerJoinFixture({
      sourceBCompleted: true,
    });
    const pendingReason: GraphWorkflowHaltReason = {
      type: "recovery_error",
      message: "lifecycle transition won the join claim race",
    };
    const joinRunSpy = vi.fn(
      async (): ReturnType<JoinRunner["run"]> => ({ status: "succeeded" }),
    );
    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => ({
        execution: harness.getCurrent(),
        scheduled: { kind: "none" },
      }),
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
        },
      },
    });

    const mutateActive = harness.deps.workflowManager.mutateActive;
    let lifecycleChanged = false;
    harness.deps.workflowManager.mutateActive = async (
      projectPath,
      sessionName,
      mutator,
    ) => {
      if (!lifecycleChanged) {
        lifecycleChanged = true;
        const draining = structuredClone(harness.getCurrent());
        draining.pendingHaltReason = pendingReason;
        harness.setCurrent(draining);
      }
      return mutateActive(projectPath, sessionName, mutator);
    };

    const result = await createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(lifecycleChanged).toBe(true);
    expect(joinRunSpy).not.toHaveBeenCalled();
    expect(harness.scheduleEligibleContextsSpy).not.toHaveBeenCalled();
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).toHaveBeenCalledTimes(1);
    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(Object.keys(result.joins)).toEqual([]);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toEqual(pendingReason);
  });

  it("deduplicates a busy-source lifecycle event when the atomic claim rechecks stale readiness", async () => {
    const { initialExecution: initial } = createEagerJoinFixture({
      sourceBCompleted: true,
    });
    Object.assign(initial.contextStates.unrelated!, {
      status: "ready",
      worktreePath: "/repo/.worktrees/session-1.lane-a",
      branchName: "csm/session-1-lane-a",
      isolation: "worktree",
      laneId: "lane-a",
    });

    const lifecycleEvents: Array<{
      event: string;
      data: Record<string, unknown> | undefined;
    }> = [];
    const executionLogger: ExecutionLogger = {
      executionId: initial.id,
      logDir: "/tmp/eager-join-dedup",
      writeManifest() {},
      lifecycle(event, data) {
        lifecycleEvents.push({ event, data });
      },
      iteration() {},
      task() {},
      validation() {},
      writePrompt() {},
      writeValidatorResponse() {},
      writeValidatorTranscript() {},
      decision() {},
    };
    registerExecutionLogger(executionLogger);

    let schedulerClearedLane = false;
    let claimReintroducedBusyLane = false;
    let scheduleCallCount = 0;
    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: {
        async run(): ReturnType<JoinRunner["run"]> {
          throw new Error("busy join must not run");
        },
      },
      scheduleEligibleContexts: async () => {
        scheduleCallCount += 1;
        if (scheduleCallCount === 1) {
          const cleared = structuredClone(harness.getCurrent());
          cleared.contextStates.unrelated!.status = "completed";
          cleared.contextStates.unrelated!.completedTaskCount = 1;
          harness.setCurrent(cleared);
          schedulerClearedLane = true;
          return {
            execution: cleared,
            scheduled: { kind: "none" },
          };
        }
        if (scheduleCallCount === 2) {
          const changed = structuredClone(harness.getCurrent());
          changed.contextStates.unrelated!.laneId = "lane-b";
          changed.contextStates.unrelated!.worktreePath =
            "/repo/.worktrees/session-1.lane-b";
          changed.contextStates.unrelated!.branchName = "csm/session-1-lane-b";
          harness.setCurrent(changed);
          return {
            execution: changed,
            scheduled: { kind: "none" },
          };
        }
        throw new StaleLoopFenceError(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId: initial.id,
            loopEpoch: initial.loopEpoch,
          },
          null,
        );
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iterationOrchestrator should not run");
        },
      },
    });

    const mutateActive = harness.deps.workflowManager.mutateActive;
    harness.deps.workflowManager.mutateActive = async (
      projectPath,
      sessionName,
      mutator,
    ) => {
      if (schedulerClearedLane && !claimReintroducedBusyLane) {
        claimReintroducedBusyLane = true;
        const busy = structuredClone(harness.getCurrent());
        busy.contextStates.unrelated!.status = "ready";
        busy.contextStates.unrelated!.completedTaskCount = 0;
        harness.setCurrent(busy);
      }
      return mutateActive(projectPath, sessionName, mutator);
    };

    try {
      await createGraphWorkflowExecutionLoop(harness.deps).run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });
    } finally {
      unregisterExecutionLogger(initial.id);
    }

    expect(claimReintroducedBusyLane).toBe(true);
    expect(
      lifecycleEvents
        .filter(({ event }) => event === "join.deferred_busy_source_lanes")
        .map(({ data }) => data?.busyLaneIds),
    ).toEqual([["lane-a"], ["lane-b"]]);
  });

  it("defers a persisted context join whose source lane became busy", async () => {
    const definition = createTestDefinition(
      ["source-a", "source-b", "busy-owner", "downstream", "integration"],
      [
        ["source-a", "downstream"],
        ["source-b", "downstream"],
        ["downstream", "integration"],
      ],
    );
    const busyOwnerState = {
      ...baseContextState("busy-owner"),
      status: "ready" as const,
      worktreePath: "/repo/.worktrees/session-1.lane-a",
      branchName: "csm/session-1-lane-a",
      isolation: "worktree" as const,
      laneId: "lane-a",
    };
    const downstreamState = {
      ...baseContextState("downstream"),
      joinId: "join-original",
    };
    const initial = createRunningExecution(definition, {
      contextStates: {
        "source-a": completedWorktreeContext("source-a", "lane-a"),
        "source-b": completedWorktreeContext("source-b", "lane-b"),
        "busy-owner": busyOwnerState,
        downstream: downstreamState,
        integration: baseContextState("integration"),
      },
      taskStates: {
        "task-source-a": {
          ...baseTaskState("task-source-a", "source-a"),
          status: "completed",
          completedAt: "2026-03-27T11:45:00.000Z",
        },
        "task-source-b": {
          ...baseTaskState("task-source-b", "source-b"),
          status: "completed",
          completedAt: "2026-03-27T11:50:00.000Z",
        },
        "task-busy-owner": baseTaskState("task-busy-owner", "busy-owner"),
        "task-downstream": baseTaskState("task-downstream", "downstream"),
        "task-integration": baseTaskState("task-integration", "integration"),
      },
      executionLanes: {
        "lane-a": worktreeLane("lane-a", ["source-a"]),
        "lane-b": worktreeLane("lane-b", ["source-b"]),
      },
      joins: {
        "join-original": {
          joinId: "join-original",
          kind: "context_merge",
          contextId: "downstream",
          targetLaneId: "lane-a",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: [],
          status: "pending",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-03-27T11:55:00.000Z",
          updatedAt: "2026-03-27T11:55:00.000Z",
          completedAt: null,
        },
      },
    });

    const callOrder: string[] = [];
    let signalBusyOwnerStarted!: () => void;
    const busyOwnerStarted = new Promise<void>((resolve) => {
      signalBusyOwnerStarted = resolve;
    });
    let releaseBusyOwner!: () => void;
    const busyOwnerRelease = new Promise<void>((resolve) => {
      releaseBusyOwner = resolve;
    });
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        callOrder.push("join");
        expect(runInput.joinId).toBe("join-original");
        await runInput.mutateActive((execution) => {
          const next = applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            { status: "succeeded" },
          );
          next.status = "aborted";
          return next;
        });
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 2,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        const current = harness.getCurrent();
        const next = structuredClone(current);
        next.activeContextIds = ["busy-owner"];
        next.contextStates["busy-owner"]!.status = "running";
        harness.setCurrent(next);
        return {
          execution: next,
          scheduled: { kind: "solo", contextId: "busy-owner" },
        };
      },
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const state = execution.contextStates[contextId]!;
          return {
            worktreePath: state.worktreePath!,
            branchName: state.branchName!,
            isolation: "worktree",
            laneId: state.laneId,
          };
        },
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          callOrder.push("busy-owner-started");
          signalBusyOwnerStarted();
          await busyOwnerRelease;
          const next = structuredClone(harness.getCurrent());
          next.contextStates["busy-owner"]!.status = "completed";
          next.contextStates["busy-owner"]!.completedTaskCount = 1;
          next.contextStates["busy-owner"]!.iterationCount = 1;
          next.taskStates["task-busy-owner"]!.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          callOrder.push("busy-owner-completed");
          return {
            conversationId: "conv-busy-owner",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const runPromise = createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await busyOwnerStarted;
    expect(joinRunSpy).not.toHaveBeenCalled();
    expect(Object.keys(harness.getCurrent().joins)).toEqual(["join-original"]);

    releaseBusyOwner();
    const result = await runPromise;

    expect(callOrder).toEqual([
      "busy-owner-started",
      "busy-owner-completed",
      "join",
    ]);
    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.joins)).toEqual(["join-original"]);
    expect(result.joins["join-original"]?.status).toBe("succeeded");
  });

  it("runs a context join while an in-flight context occupies only a disjoint lane", async () => {
    const { initialExecution: initial } = createEagerJoinFixture();

    const startedContextIds = new Set<string>();
    let signalBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    let unrelatedReleased = false;
    let releaseUnrelated!: () => void;
    const unrelatedRelease = new Promise<void>((resolve) => {
      releaseUnrelated = () => {
        unrelatedReleased = true;
        resolve();
      };
    });
    let signalJoinStarted!: () => void;
    const joinStarted = new Promise<void>((resolve) => {
      signalJoinStarted = resolve;
    });
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        expect(unrelatedReleased).toBe(false);
        expect(harness.getCurrent().contextStates.unrelated?.status).toBe(
          "running",
        );
        signalJoinStarted();
        await runInput.mutateActive((execution) => {
          const next = applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            { status: "succeeded" },
          );
          next.status = "aborted";
          return next;
        });
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 3,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        const result = scheduleDisjointUpstreams(harness.getCurrent());
        harness.setCurrent(result.execution);
        return result;
      },
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const state = execution.contextStates[contextId]!;
          return {
            worktreePath: state.worktreePath!,
            branchName: state.branchName!,
            isolation: "worktree",
            laneId: state.laneId,
          };
        },
      },
      iterationOrchestrator: {
        async runIteration({
          contextId,
        }): Promise<GraphWorkflowIterationResult> {
          startedContextIds.add(contextId);
          if (startedContextIds.size === 2) signalBothStarted();
          await bothStarted;
          if (contextId === "unrelated") await unrelatedRelease;

          const next = completeTestContext(harness.getCurrent(), contextId);
          harness.setCurrent(next);
          return {
            conversationId: `conv-${contextId}`,
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const runPromise = createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await joinStarted;
    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(unrelatedReleased).toBe(false);
    const joinId = joinRunSpy.mock.calls[0]![0].joinId;
    expect(harness.getCurrent().joins[joinId]).toMatchObject({
      kind: "context_merge",
      contextId: "downstream",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    releaseUnrelated();
    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.contextStates.unrelated?.status).toBe("completed");
  });

  it("drains after an eager context join fails while unrelated work is in flight", async () => {
    const { initialExecution: initial } = createEagerJoinFixture();
    const startedContextIds = new Set<string>();
    let signalBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    let releaseUnrelated!: () => void;
    const unrelatedRelease = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        expect(harness.getCurrent().contextStates.unrelated?.status).toBe(
          "running",
        );
        await runInput.mutateActive((execution) =>
          applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            {
              status: "failed",
              errorMessage: "merge conflict in ticket-detail.ts",
              conflicts: {
                files: ["ticket-detail.ts"],
                message: "merge conflict in ticket-detail.ts",
                analysis: null,
              },
            },
          ),
        );
        return {
          status: "failed",
          message: "merge conflict in ticket-detail.ts",
          conflictFiles: ["ticket-detail.ts"],
          failedSourceLaneId: "lane-b",
          haltReason: null,
        };
      },
    );
    const runIterationSpy = vi.fn(
      async ({
        contextId,
      }: Parameters<
        GraphWorkflowExecutionLoopDeps["iterationOrchestrator"]["runIteration"]
      >[0]): Promise<GraphWorkflowIterationResult> => {
        startedContextIds.add(contextId);
        if (startedContextIds.size === 2) signalBothStarted();
        await bothStarted;
        if (contextId === "unrelated") await unrelatedRelease;

        const next = completeTestContext(harness.getCurrent(), contextId);
        harness.setCurrent(next);
        return {
          conversationId: `conv-${contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 3,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        const result = scheduleDisjointUpstreams(harness.getCurrent());
        harness.setCurrent(result.execution);
        return result;
      },
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const state = execution.contextStates[contextId]!;
          return {
            worktreePath: state.worktreePath!,
            branchName: state.branchName!,
            isolation: "worktree",
            laneId: state.laneId,
          };
        },
      },
      iterationOrchestrator: { runIteration: runIterationSpy },
    });

    const runPromise = createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await vi.waitFor(() => {
      expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledTimes(1);
    });
    const joinId = joinRunSpy.mock.calls[0]![0].joinId;
    const failedJoin = harness.getCurrent().joins[joinId]!;
    const expectedReason: GraphWorkflowHaltReason = {
      type: "join_failure",
      joinId,
      joinKind: "context_merge",
      contextId: "downstream",
      sourceLaneIds: failedJoin.sourceLaneIds,
      targetLaneId: failedJoin.targetLaneId,
      message: "merge conflict in ticket-detail.ts",
      conflictFiles: ["ticket-detail.ts"],
    };
    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledWith({
      projectPath: "/repo",
      sessionName: "session-1",
      reason: expectedReason,
    });
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.scheduleEligibleContextsSpy).toHaveBeenCalledTimes(1);
    expect(harness.getCurrent().contextStates.unrelated?.status).toBe(
      "running",
    );

    releaseUnrelated();
    const result = await runPromise;

    expect(runIterationSpy).toHaveBeenCalledTimes(2);
    expect(harness.scheduleEligibleContextsSpy).toHaveBeenCalledTimes(1);
    expect(harness.drainAndHaltSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toEqual(expectedReason);
    expect(result.contextStates.unrelated?.status).toBe("completed");
    expect(result.contextStates.downstream?.status).toBe("pending");
  });

  it("does not start an eager join when query capacity is exhausted", async () => {
    const definition = createTestDefinition(
      ["source-a", "source-b", "unrelated", "downstream", "integration"],
      [
        ["source-a", "downstream"],
        ["source-b", "downstream"],
        ["downstream", "integration"],
      ],
    );
    const approvedDecision = {
      type: "approved" as const,
      decidedAt: "2026-03-27T11:58:00.000Z",
    };
    const sourceBState = {
      ...baseContextState("source-b"),
      status: "awaiting_approval" as const,
      completedTaskCount: 1,
      iterationCount: 1,
      worktreePath: "/repo/.worktrees/session-1.lane-b",
      branchName: "csm/session-1-lane-b",
      isolation: "worktree" as const,
      laneId: "lane-b",
      pendingApproval: {
        conversationId: "conv-source-b",
        requestedAt: "2026-03-27T11:55:00.000Z",
        decision: approvedDecision,
      },
    };
    const unrelatedState = {
      ...baseContextState("unrelated"),
      status: "awaiting_approval" as const,
      completedTaskCount: 1,
      iterationCount: 1,
      worktreePath: "/repo/.worktrees/session-1.lane-unrelated",
      branchName: "csm/session-1-lane-unrelated",
      isolation: "worktree" as const,
      laneId: "lane-unrelated",
      pendingApproval: {
        conversationId: "conv-unrelated",
        requestedAt: "2026-03-27T11:55:00.000Z",
        decision: null,
      },
    };
    const initial = createRunningExecution(definition, {
      contextStates: {
        "source-a": completedWorktreeContext("source-a", "lane-a"),
        "source-b": sourceBState,
        unrelated: unrelatedState,
        downstream: baseContextState("downstream"),
        integration: baseContextState("integration"),
      },
      taskStates: {
        "task-source-a": {
          ...baseTaskState("task-source-a", "source-a"),
          status: "completed",
          completedAt: "2026-03-27T11:45:00.000Z",
        },
        "task-source-b": {
          ...baseTaskState("task-source-b", "source-b"),
          status: "completed",
          completedAt: "2026-03-27T11:55:00.000Z",
        },
        "task-unrelated": {
          ...baseTaskState("task-unrelated", "unrelated"),
          status: "completed",
          completedAt: "2026-03-27T11:55:00.000Z",
        },
        "task-downstream": baseTaskState("task-downstream", "downstream"),
        "task-integration": baseTaskState("task-integration", "integration"),
      },
      executionLanes: {
        "lane-a": worktreeLane("lane-a", ["source-a"]),
        "lane-b": worktreeLane("lane-b", []),
        "lane-unrelated": worktreeLane("lane-unrelated", []),
      },
    });

    let signalCapacityExhausted!: () => void;
    const capacityExhausted = new Promise<void>((resolve) => {
      signalCapacityExhausted = resolve;
    });
    let releaseUnrelated!: () => void;
    const unrelatedRelease = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    const callOrder: string[] = [];
    const observedCapacities: number[] = [];
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        callOrder.push("join");
        await runInput.mutateActive((execution) => {
          const next = applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            { status: "succeeded" },
          );
          next.status = "aborted";
          return next;
        });
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 1,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async ({ capacityRemaining }) => {
        observedCapacities.push(capacityRemaining ?? -1);
        if (capacityRemaining === 0) {
          callOrder.push("capacity-exhausted");
          signalCapacityExhausted();
        }
        return {
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        };
      },
      waitForApprovalProgress: async ({ contextId }) => {
        expect(contextId).toBe("unrelated");
        await unrelatedRelease;
        const next = structuredClone(harness.getCurrent());
        next.contextStates.unrelated!.pendingApproval!.decision = {
          type: "approved",
          decidedAt: "2026-03-27T12:01:00.000Z",
        };
        harness.setCurrent(next);
      },
      isConversationBusy: () => false,
      acquireConversationLock: () => () => {},
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const state = execution.contextStates[contextId]!;
          return {
            worktreePath: state.worktreePath!,
            branchName: state.branchName!,
            isolation: "worktree",
            laneId: state.laneId,
          };
        },
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error(
            "persisted approval contexts must not seed an iteration",
          );
        },
      },
    });

    const runPromise = createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    await capacityExhausted;
    expect(joinRunSpy).not.toHaveBeenCalled();
    expect(observedCapacities).toEqual([1, 0]);

    releaseUnrelated();
    const result = await runPromise;

    expect(callOrder).toEqual(["capacity-exhausted", "join"]);
    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("aborted");
  });

  it("allows terminal fan-in to reach final publish when no context merge is planned", async () => {
    const definition = createTestDefinition(
      ["source-a", "source-b", "terminal"],
      [
        ["source-a", "terminal"],
        ["source-b", "terminal"],
      ],
    );
    const initial = createRunningExecution(definition, {
      contextStates: {
        "source-a": completedWorktreeContext("source-a", "lane-a"),
        "source-b": completedWorktreeContext("source-b", "lane-b"),
        terminal: baseContextState("terminal"),
      },
      taskStates: {
        "task-source-a": {
          ...baseTaskState("task-source-a", "source-a"),
          status: "completed",
          completedAt: "2026-03-27T11:45:00.000Z",
        },
        "task-source-b": {
          ...baseTaskState("task-source-b", "source-b"),
          status: "completed",
          completedAt: "2026-03-27T11:50:00.000Z",
        },
        "task-terminal": baseTaskState("task-terminal", "terminal"),
      },
      executionLanes: {
        "lane-a": worktreeLane("lane-a", ["source-a"]),
        "lane-b": worktreeLane("lane-b", ["source-b"]),
      },
    });

    expect(
      classifyContextSchedulability({
        contextId: "terminal",
        definition,
        execution: initial,
      }),
    ).toEqual({
      kind: "wait-for-join",
      sourceLaneIds: ["lane-a", "lane-b"],
    });
    expect(
      planContextJoin({
        contextId: "terminal",
        execution: initial,
        now: () => "2026-03-27T11:55:00.000Z",
        generateJoinId: () => "context-join-must-not-be-created",
      }),
    ).toBeNull();

    let terminalScheduled = false;
    const callOrder: string[] = [];
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        const join = harness.getCurrent().joins[runInput.joinId];
        expect(join?.kind).toBe("final_publish");
        callOrder.push("final-publish");
        await runInput.mutateActive((execution) =>
          applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            { status: "succeeded" },
          ),
        );
        return { status: "succeeded" };
      },
    );

    const harness = buildHarness({
      initialExecution: initial,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        callOrder.push("scheduler");
        const current = harness.getCurrent();
        const finalPublishSucceeded = Object.values(current.joins).some(
          (join) =>
            join.kind === "final_publish" && join.status === "succeeded",
        );
        if (!finalPublishSucceeded || terminalScheduled) {
          return {
            execution: current,
            scheduled: { kind: "none" },
          };
        }

        terminalScheduled = true;
        const next = structuredClone(current);
        next.activeContextIds = ["terminal"];
        next.contextStates.terminal!.status = "running";
        harness.setCurrent(next);
        return {
          execution: next,
          scheduled: { kind: "solo", contextId: "terminal" },
        };
      },
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          const next = structuredClone(harness.getCurrent());
          next.contextStates.terminal!.status = "completed";
          next.contextStates.terminal!.completedTaskCount = 1;
          next.contextStates.terminal!.iterationCount = 1;
          next.taskStates["task-terminal"]!.status = "completed";
          next.activeContextIds = [];
          harness.setCurrent(next);
          return {
            conversationId: "conv-terminal",
            execution: next,
            shouldContinueInContext: false,
          };
        },
      },
    });

    const result = await createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf("scheduler")).toBeLessThan(
      callOrder.indexOf("final-publish"),
    );
    const finalPublish = result.joins[joinRunSpy.mock.calls[0]![0].joinId];
    expect(finalPublish).toMatchObject({
      kind: "final_publish",
      contextId: null,
      targetLaneId: "__session__",
      sourceLaneIds: ["lane-a", "lane-b"],
      status: "succeeded",
    });
    expect(
      Object.values(result.joins).some((join) => join.kind === "context_merge"),
    ).toBe(false);
    expect(result.contextStates.terminal?.status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("runs a final publish join before completing when a non-session lane is unpublished", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingUserInput: null,
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

  it("preserves a delivery-gate halt reason when the final publish join is refused", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
          message: "Delivery gate refused merge",
          conflictFiles: [],
          failedSourceLaneId: "lane-plan",
          haltReason: {
            type: "delivery_gate_failed",
            unmet: [
              {
                criterionId: "criterion-1",
                criterionHandle: "native-sdd/R18.4",
                outcome: "unmet",
                reason: "candidate proof is stale",
              },
            ],
            instruction:
              "Re-dispatch the merge to validate the candidate again.",
          },
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
    expect(result.haltReason).toEqual({
      type: "delivery_gate_failed",
      unmet: [
        {
          criterionId: "criterion-1",
          criterionHandle: "native-sdd/R18.4",
          outcome: "unmet",
          reason: "candidate proof is stale",
        },
      ],
      instruction: "Re-dispatch the merge to validate the candidate again.",
    });
  });

  it("final publish publishes only the terminal target lane after a context_merge consumes a non-terminal source", async () => {
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition, {
      contextStates: {
        "ctx-1": {
          pendingApproval: null,
          pendingUserInput: null,
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
          pendingUserInput: null,
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

  describe("user-input gate wait", () => {
    const pendingQuestions = [
      {
        id: "q1",
        question: "Which approach?",
        options: [
          { label: "A", description: "first", recommended: false },
          { label: "B", description: "second", recommended: false },
        ],
        multiSelect: false,
        required: true,
        allowNote: true,
      },
    ];

    function parkedUserInput(
      conversationId: string,
      answers: {
        byQuestionId: Record<
          string,
          { selected: string[]; note: string | null; skipped: boolean }
        >;
        answeredAt: string;
      } | null = null,
    ) {
      return {
        conversationId,
        lane: "implementer" as const,
        questionBatchId: `batch-${conversationId}`,
        questions: structuredClone(pendingQuestions),
        requestedAt: "2026-03-27T12:01:00.000Z",
        answers,
      };
    }

    /**
     * Real gate service over the harness's own execution store. `consumeAnswers`
     * and `withdrawAll` (the only methods the loop calls) run their genuine
     * mutation logic against the harness state, so the tests exercise real gate
     * behavior — not a stubbed echo.
     */
    function buildRealGate(
      harness: LoopHarness,
      overrides: {
        sendConversationEvent?: (
          projectPath: string,
          sessionName: string,
          conversationId: string,
          event: { type: string },
        ) => boolean;
        broadcast?: (event: unknown) => void;
      } = {},
    ) {
      return createUserInputGateService({
        getActive: async () => harness.getCurrent(),
        mutateActive: async (_p, _s, fn) => {
          const next = await fn(structuredClone(harness.getCurrent()));
          harness.setCurrent(next);
          return next;
        },
        publishUserInputPending: () => [],
        publishUserInputResolved: (input) => {
          overrides.broadcast?.({
            type: "graph-workflow-user-input-resolved",
            contextId: input.contextId,
            conversationId: input.conversationId,
            questionBatchId: input.questionBatchId,
            resolution: input.resolution,
          });
          return [];
        },
        sendConversationEvent: overrides.sendConversationEvent ?? (() => true),
        now: () => "2026-03-27T12:03:00.000Z",
      });
    }

    function createParkedUserInputExecution(
      definition: WorkflowSemanticDefinition,
      conversationId = "conv-1",
    ): GraphWorkflowExecution {
      const execution = createRunningExecution(definition);
      const cs = execution.contextStates["ctx-1"]!;
      cs.status = "awaiting_user_input";
      cs.iterationCount = 1;
      cs.completedTaskCount = 0;
      cs.pendingUserInput = parkedUserInput(conversationId);
      return execution;
    }

    function findUserInputResolvedEvents(
      broadcasts: unknown[],
    ): GraphWorkflowUserInputResolvedEvent[] {
      return broadcasts.filter(
        (event): event is GraphWorkflowUserInputResolvedEvent =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: string }).type ===
            "graph-workflow-user-input-resolved",
      );
    }

    it("waits without seeding another iteration until answers are recorded, then consumes and resumes the context to running", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition);

      const answeredAnswers = {
        byQuestionId: {
          q1: { selected: ["A"], note: null, skipped: false },
        },
        answeredAt: "2026-03-27T12:02:00.000Z",
      };

      // First two polls observe no answers (the wait must hold); the third
      // records the answers so the wait ends and the context resumes.
      let pollCount = 0;
      const waitForUserInputProgress = vi.fn(async () => {
        pollCount += 1;
        if (pollCount >= 3) {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.pendingUserInput!.answers =
            structuredClone(answeredAnswers);
          harness.setCurrent(next);
        }
      });

      let iterationCallCount = 0;
      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        // Production never schedules a parked context; its runner re-enters via
        // the re-entry pass and holds the wait, then runs the resumed iteration
        // in-flight. The scheduler stays idle throughout.
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            iterationCallCount += 1;
            // The resumed turn: context is running, no pending input. Complete
            // the task so the loop can finish.
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            cs.iterationCount += 1;
            cs.completedTaskCount = 1;
            cs.status = "completed";
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
      const gate = buildRealGate(harness);
      harness.deps.userInputGateService = gate;

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      // The wait polled while no answers were present, then observed them.
      expect(waitForUserInputProgress).toHaveBeenCalledTimes(3);
      // Exactly one seeded turn — the resume iteration. No turn ran while parked.
      expect(iterationCallCount).toBe(1);
      expect(result.status).toBe("completed");
      const cs = result.contextStates["ctx-1"]!;
      // The record was consumed on resume (cleared + status flipped).
      expect(cs.pendingUserInput).toBeNull();
      expect(cs.status).toBe("completed");
    });

    it("delivers the consumed answers into the resumed iteration as resumeUserInput (task 4.5)", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition, "conv-ask");

      const answeredAnswers = {
        byQuestionId: {
          q1: {
            selected: ["A"],
            note: "prefer A",
            skipped: false,
            question: "Which approach?",
          },
        },
        answeredAt: "2026-03-27T12:02:00.000Z",
      };

      let pollCount = 0;
      const waitForUserInputProgress = vi.fn(async () => {
        pollCount += 1;
        if (pollCount >= 1) {
          const next = structuredClone(harness.getCurrent());
          next.contextStates["ctx-1"]!.pendingUserInput!.answers =
            structuredClone(answeredAnswers);
          harness.setCurrent(next);
        }
      });

      const runIterationInputs: Array<{
        contextId: string;
        resumeUserInput?: ResumeUserInputContext;
      }> = [];
      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(runInput): Promise<GraphWorkflowIterationResult> {
            runIterationInputs.push({
              contextId: runInput.contextId,
              resumeUserInput: runInput.resumeUserInput,
            });
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            cs.iterationCount += 1;
            cs.completedTaskCount = 1;
            cs.status = "completed";
            next.taskStates["task-1"]!.status = "completed";
            next.activeContextIds = [];
            harness.setCurrent(next);
            return {
              conversationId: "conv-ask",
              execution: next,
              shouldContinueInContext: false,
            };
          },
        },
      });
      const gate = buildRealGate(harness);
      harness.deps.userInputGateService = gate;

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      // The single resumed turn carried the consumed answers: the asking
      // conversation to pin, the batch id, the id-keyed answers, and the lane.
      expect(runIterationInputs).toHaveLength(1);
      const delivered = runIterationInputs[0]!.resumeUserInput;
      expect(delivered).toEqual({
        conversationId: "conv-ask",
        questionBatchId: "batch-conv-ask",
        answers: answeredAnswers.byQuestionId,
        lane: "implementer",
      });
    });

    it("does not consume or resume while answers are absent (the park holds indefinitely)", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition);

      let signalPollStarted!: () => void;
      const pollStarted = new Promise<void>((resolve) => {
        signalPollStarted = resolve;
      });
      let releasePoll!: () => void;
      const pollRelease = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const waitForUserInputProgress = vi.fn(async () => {
        signalPollStarted();
        await pollRelease;
      });

      const runIteration = vi.fn(
        async (): Promise<GraphWorkflowIterationResult> => {
          throw new Error("no iteration may be seeded while parked");
        },
      );

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: { runIteration },
      });
      harness.deps.userInputGateService = buildRealGate(harness);

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
      // Still parked: the loop never completes, never seeds an iteration.
      expect(raceOutcome).toBe("pending");
      expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);
      expect(runIteration).not.toHaveBeenCalled();
      expect(harness.sendSpy).not.toHaveBeenCalled();

      // Abort to unwind the loop.
      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releasePoll();
      const result = await runPromise;
      expect(result.status).toBe("aborted");
    });

    it("re-enters two persisted parked contexts and answers them independently", async () => {
      _resetActiveLoopsForTesting();
      const definition = createTwoParkedContextDefinition();
      const initial = createRunningExecution(definition, {
        contextStates: {
          "ctx-1": {
            ...baseContextState("ctx-1"),
            status: "awaiting_user_input",
            iterationCount: 1,
            pendingUserInput: parkedUserInput("conv-1"),
          },
          "ctx-2": {
            ...baseContextState("ctx-2"),
            status: "awaiting_user_input",
            iterationCount: 1,
            pendingUserInput: parkedUserInput("conv-2"),
          },
        },
        taskStates: {
          "task-1": baseTaskState("task-1", "ctx-1"),
          "task-2": baseTaskState("task-2", "ctx-2"),
        },
      });

      const answered = {
        byQuestionId: { q1: { selected: ["A"], note: null, skipped: false } },
        answeredAt: "2026-03-27T12:02:00.000Z",
      };

      // ctx-2 blocks indefinitely (never answered) so its runner genuinely
      // keeps waiting; ctx-1 is answered on its first poll and resumes.
      let releaseCtx2Poll!: () => void;
      const ctx2Blocked = new Promise<void>((resolve) => {
        releaseCtx2Poll = resolve;
      });
      const perContextPolls: Record<string, number> = {
        "ctx-1": 0,
        "ctx-2": 0,
      };
      const waitForUserInputProgress = vi.fn(
        async (input: { contextId: string }) => {
          perContextPolls[input.contextId] =
            (perContextPolls[input.contextId] ?? 0) + 1;
          if (input.contextId === "ctx-1") {
            const next = structuredClone(harness.getCurrent());
            next.contextStates["ctx-1"]!.pendingUserInput!.answers =
              structuredClone(answered);
            harness.setCurrent(next);
            return;
          }
          // ctx-2 is never answered → its runner blocks on the wait poll.
          await ctx2Blocked;
        },
      );

      const resumedContexts: string[] = [];
      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(input): Promise<GraphWorkflowIterationResult> {
            resumedContexts.push(input.contextId);
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates[input.contextId]!;
            cs.completedTaskCount = 1;
            cs.status = "completed";
            harness.setCurrent(next);
            return {
              conversationId: `conv-${input.contextId}`,
              execution: next,
              shouldContinueInContext: false,
            };
          },
        },
      });
      harness.deps.userInputGateService = buildRealGate(harness);

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const runPromise = loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      // ctx-1 resumes; ctx-2 keeps waiting so the loop never settles.
      const raceOutcome = await Promise.race([
        runPromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 40),
        ),
      ]);
      expect(raceOutcome).toBe("pending");

      // Only ctx-1 was resumed and consumed; ctx-2 remains parked.
      expect(resumedContexts).toEqual(["ctx-1"]);
      const state = harness.getCurrent();
      expect(state.contextStates["ctx-1"]!.pendingUserInput).toBeNull();
      expect(state.contextStates["ctx-1"]!.status).toBe("completed");
      expect(state.contextStates["ctx-2"]!.status).toBe("awaiting_user_input");
      expect(state.contextStates["ctx-2"]!.pendingUserInput).not.toBeNull();

      // Unwind: abort, then release ctx-2's blocked poll so its runner
      // observes the aborted status and exits.
      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releaseCtx2Poll();
      const finalResult = await runPromise;
      expect(finalResult.status).toBe("aborted");
    });

    it("refuses to complete the execution while a context is parked awaiting user input", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition);

      let signalPollStarted!: () => void;
      const pollStarted = new Promise<void>((resolve) => {
        signalPollStarted = resolve;
      });
      let releasePoll!: () => void;
      const pollRelease = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const waitForUserInputProgress = vi.fn(async () => {
        signalPollStarted();
        await pollRelease;
      });

      // The scheduler finds nothing schedulable (the only context is parked).
      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            throw new Error("parked context must not seed an iteration");
          },
        },
      });
      harness.deps.userInputGateService = buildRealGate(harness);

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
          setTimeout(() => resolve("pending"), 30),
        ),
      ]);
      // The completion guard held: nothing schedulable, but a park is open.
      expect(raceOutcome).toBe("pending");
      expect(harness.sendSpy).not.toHaveBeenCalled();
      expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();

      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releasePoll();
      await runPromise;
      // Even after unwind, the execution never transitioned to completed.
      expect(harness.sendSpy).not.toHaveBeenCalled();
    });

    it("applies answers recorded while paused immediately on re-entry without re-waiting", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition);
      // Answers were recorded while the execution was paused: the persisted
      // record already carries them when the loop re-enters on resume.
      initial.contextStates["ctx-1"]!.pendingUserInput!.answers = {
        byQuestionId: { q1: { selected: ["B"], note: null, skipped: false } },
        answeredAt: "2026-03-27T12:02:00.000Z",
      };

      const waitForUserInputProgress = vi.fn(async () => {});
      let iterationCallCount = 0;
      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            iterationCallCount += 1;
            const next = structuredClone(harness.getCurrent());
            const cs = next.contextStates["ctx-1"]!;
            cs.iterationCount += 1;
            cs.completedTaskCount = 1;
            cs.status = "completed";
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
      harness.deps.userInputGateService = buildRealGate(harness);

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const result = await loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      // The answers-present check at the top of the wait short-circuits: no
      // wait-progress poll runs before the resume.
      expect(waitForUserInputProgress).not.toHaveBeenCalled();
      expect(iterationCallCount).toBe(1);
      expect(result.status).toBe("completed");
      expect(result.contextStates["ctx-1"]!.pendingUserInput).toBeNull();
    });

    it("withdraws all parked questions when the execution aborts while parked", async () => {
      _resetActiveLoopsForTesting();
      const definition = createSingleContextDefinition(5);
      const initial = createParkedUserInputExecution(definition);

      let signalPollStarted!: () => void;
      const pollStarted = new Promise<void>((resolve) => {
        signalPollStarted = resolve;
      });
      let releasePoll!: () => void;
      const pollRelease = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const waitForUserInputProgress = vi.fn(async () => {
        signalPollStarted();
        await pollRelease;
      });
      const clearedConversations: string[] = [];
      const broadcasts: unknown[] = [];

      const harness: LoopHarness = buildHarness({
        initialExecution: initial,
        waitForUserInputProgress,
        scheduleEligibleContexts: async () => ({
          execution: harness.getCurrent(),
          scheduled: { kind: "none" },
        }),
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            throw new Error("parked context must not seed an iteration");
          },
        },
      });
      harness.deps.userInputGateService = buildRealGate(harness, {
        sendConversationEvent: (_p, _s, conversationId, event) => {
          if (event.type === "CLEAR_PENDING_QUESTION") {
            clearedConversations.push(conversationId);
          }
          return true;
        },
        broadcast: (event) => broadcasts.push(event),
      });

      const loop = createGraphWorkflowExecutionLoop(harness.deps);
      const runPromise = loop.run({
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: initial,
      });

      await pollStarted;
      const aborted = structuredClone(harness.getCurrent());
      aborted.status = "aborted";
      harness.setCurrent(aborted);
      releasePoll();

      const result = await runPromise;
      expect(result.status).toBe("aborted");

      // The abort path withdrew the parked question: record cleared, machine
      // told to clear its pending question, resolved(withdrawn) published.
      const finalState = harness.getCurrent();
      expect(finalState.contextStates["ctx-1"]!.pendingUserInput).toBeNull();
      expect(clearedConversations).toEqual(["conv-1"]);
      const withdrawnEvents = findUserInputResolvedEvents(broadcasts);
      expect(withdrawnEvents).toHaveLength(1);
      expect(withdrawnEvents[0]).toMatchObject({
        contextId: "ctx-1",
        conversationId: "conv-1",
        resolution: "withdrawn",
      });
    });
  });
});

describe("execution loop generation fencing", () => {
  it("exits through generation fencing when an eager join is replaced mid-run", async () => {
    const { initialExecution: initial } = createEagerJoinFixture();
    const successor = createRunningExecution(createSingleContextDefinition(5), {
      id: "exec-2",
    });
    const startedContextIds = new Set<string>();
    let signalBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    let releaseUnrelated!: () => void;
    const unrelatedRelease = new Promise<void>((resolve) => {
      releaseUnrelated = resolve;
    });
    let signalUnrelatedReturned!: () => void;
    const unrelatedReturned = new Promise<void>((resolve) => {
      signalUnrelatedReturned = resolve;
    });
    let scheduledSnapshot: GraphWorkflowExecution | null = null;
    const joinRunSpy = vi.fn(
      async (
        runInput: Parameters<JoinRunner["run"]>[0],
      ): ReturnType<JoinRunner["run"]> => {
        harness.setCurrent(structuredClone(successor));
        await runInput.mutateActive((execution) =>
          applyJoinProgress(
            execution,
            runInput.joinId,
            "2026-03-27T12:00:00.000Z",
            { status: "succeeded" },
          ),
        );
        return { status: "succeeded" };
      },
    );
    const runIterationSpy = vi.fn(
      async ({
        contextId,
      }: Parameters<
        GraphWorkflowExecutionLoopDeps["iterationOrchestrator"]["runIteration"]
      >[0]): Promise<GraphWorkflowIterationResult> => {
        startedContextIds.add(contextId);
        if (startedContextIds.size === 2) signalBothStarted();
        await bothStarted;
        if (contextId === "unrelated") {
          await unrelatedRelease;
          const staleResult = completeTestContext(
            scheduledSnapshot!,
            contextId,
          );
          signalUnrelatedReturned();
          return {
            conversationId: "conv-unrelated",
            execution: staleResult,
            shouldContinueInContext: false,
          };
        }

        const next = completeTestContext(harness.getCurrent(), contextId);
        harness.setCurrent(next);
        return {
          conversationId: `conv-${contextId}`,
          execution: next,
          shouldContinueInContext: false,
        };
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      getMaxConcurrentQueries: async () => 3,
      joinRunner: { run: joinRunSpy },
      scheduleEligibleContexts: async () => {
        const result = scheduleDisjointUpstreams(harness.getCurrent());
        scheduledSnapshot = structuredClone(result.execution);
        harness.setCurrent(result.execution);
        return result;
      },
      executionTargetResolver: {
        resolve({ execution, contextId }) {
          const state = execution.contextStates[contextId]!;
          return {
            worktreePath: state.worktreePath!,
            branchName: state.branchName!,
            isolation: "worktree",
            laneId: state.laneId,
          };
        },
      },
      iterationOrchestrator: { runIteration: runIterationSpy },
    });
    const mutateActive = harness.deps.workflowManager.mutateActive;
    harness.deps.workflowManager.mutateActive = async (
      projectPath,
      sessionName,
      mutator,
    ) => {
      const current = harness.getCurrent();
      if (current.id !== initial.id) {
        throw new StaleLoopFenceError(
          {
            projectPath: "/repo",
            sessionName: "session-1",
            executionId: initial.id,
            loopEpoch: initial.loopEpoch,
          },
          current,
        );
      }
      return mutateActive(projectPath, sessionName, mutator);
    };

    const result = await createGraphWorkflowExecutionLoop(harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(joinRunSpy).toHaveBeenCalledTimes(1);
    expect(harness.scheduleEligibleContextsSpy).toHaveBeenCalledTimes(1);
    expect(runIterationSpy).toHaveBeenCalledTimes(2);
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(result.id).toBe(initial.id);
    expect(harness.getCurrent()).toMatchObject({
      id: "exec-2",
      loopEpoch: 0,
      status: "running",
      pendingHaltReason: null,
      joins: {},
      contextStates: { "ctx-1": { status: "pending" } },
    });

    releaseUnrelated();
    await unrelatedReturned;
  });

  it("exits silently when an iteration surfaces a stale-fence rejection instead of halting the successor", async () => {
    // Incident shape (loop A): the loop's execution was aborted and replaced
    // while it was blocked; its next persisted write throws
    // StaleLoopFenceError. The loop must NOT translate that into a halt — the
    // halt would land on the successor execution it no longer owns.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new StaleLoopFenceError(
            {
              projectPath: "/repo",
              sessionName: "session-1",
              executionId: "exec-1",
              loopEpoch: 0,
            },
            { id: "exec-2", loopEpoch: 0 },
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

    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.sendSpy).not.toHaveBeenCalled();
    // The successor's state is untouched: still running, no halt recorded.
    expect(harness.getCurrent().status).toBe("running");
    expect(harness.getCurrent().pendingHaltReason).toBeNull();
    expect(result.status).toBe("running");
  });

  it("exits without adopting a successor execution observed on refresh", async () => {
    // Incident shape (loop A, adoption variant): getActive is session-scoped,
    // so after this loop's execution is aborted and a new one started, refresh
    // returns the successor. The loop must exit instead of driving it.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const successor = createRunningExecution(definition, { id: "exec-2" });
    const runIteration = vi.fn(
      async (): Promise<GraphWorkflowIterationResult> => {
        if (runIteration.mock.calls.length === 1) {
          // During the turn, the original execution is aborted and replaced.
          harness.setCurrent(structuredClone(successor));
          const finished = structuredClone(initial);
          finished.contextStates["ctx-1"]!.status = "completed";
          finished.contextStates["ctx-1"]!.completedTaskCount = 1;
          finished.taskStates["task-1"]!.status = "completed";
          return {
            conversationId: "conv-1",
            execution: finished,
            shouldContinueInContext: false,
          };
        }
        // A second call means the loop kept driving work — for whichever
        // execution — after its own was replaced.
        const next = structuredClone(harness.getCurrent());
        next.contextStates["ctx-1"]!.status = "completed";
        next.contextStates["ctx-1"]!.completedTaskCount = 1;
        next.taskStates["task-1"]!.status = "completed";
        harness.setCurrent(next);
        return {
          conversationId: "conv-2",
          execution: next,
          shouldContinueInContext: false,
        };
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: { runIteration },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(runIteration).toHaveBeenCalledTimes(1);
    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    // The successor is untouched.
    expect(harness.getCurrent().id).toBe("exec-2");
    expect(harness.getCurrent().status).toBe("running");
    expect(harness.getCurrent().contextStates["ctx-1"]?.status).toBe("pending");
  });

  it("exits after a resume bumps the loop epoch instead of scheduling the next wave", async () => {
    // Incident shape (loop B): the execution was halted and resumed while
    // this loop was blocked in a turn. Resume cleared the halt signals, so
    // status checks pass — only the epoch bump reveals the loop is stale. It
    // must not schedule more work or complete the resumed execution.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const runIteration = vi.fn(
      async (): Promise<GraphWorkflowIterationResult> => {
        if (runIteration.mock.calls.length === 1) {
          // Halt + resume land while the turn is in flight: the persisted
          // execution is now generation 1 with the context still incomplete.
          const resumed = structuredClone(initial);
          resumed.loopEpoch = 1;
          harness.setCurrent(resumed);
          // The zombie's own view of its finished iteration (generation 0).
          const finished = structuredClone(initial);
          finished.contextStates["ctx-1"]!.status = "completed";
          finished.contextStates["ctx-1"]!.completedTaskCount = 1;
          finished.taskStates["task-1"]!.status = "completed";
          return {
            conversationId: "conv-1",
            execution: finished,
            shouldContinueInContext: false,
          };
        }
        const next = structuredClone(harness.getCurrent());
        next.contextStates["ctx-1"]!.status = "completed";
        next.contextStates["ctx-1"]!.completedTaskCount = 1;
        next.taskStates["task-1"]!.status = "completed";
        harness.setCurrent(next);
        return {
          conversationId: "conv-2",
          execution: next,
          shouldContinueInContext: false,
        };
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: { runIteration },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(runIteration).toHaveBeenCalledTimes(1);
    expect(harness.sendSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    // The resumed generation is untouched: still running, still incomplete.
    expect(harness.getCurrent().loopEpoch).toBe(1);
    expect(harness.getCurrent().status).toBe("running");
    expect(
      harness.getCurrent().contextStates["ctx-1"]?.completedTaskCount,
    ).toBe(0);
  });

  it("keeps the session marked loop-active while a newer loop instance is still running", async () => {
    // The registry must be instance-keyed: when a stale loop exits after a
    // newer loop registered for the same session, the exit must not
    // unregister the newer loop.
    _resetActiveLoopsForTesting();

    const definition = createSingleContextDefinition(5);

    function buildGatedHarness(): {
      harness: LoopHarness;
      releaseIteration: () => void;
    } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const initial = createRunningExecution(definition);
      const harness = buildHarness({
        initialExecution: initial,
        iterationOrchestrator: {
          async runIteration(): Promise<GraphWorkflowIterationResult> {
            await gate;
            const next = structuredClone(harness.getCurrent());
            next.contextStates["ctx-1"]!.status = "completed";
            next.contextStates["ctx-1"]!.completedTaskCount = 1;
            next.taskStates["task-1"]!.status = "completed";
            harness.setCurrent(next);
            return {
              conversationId: "conv-1",
              execution: next,
              shouldContinueInContext: false,
            };
          },
        },
      });
      return { harness, releaseIteration: () => release() };
    }

    const first = buildGatedHarness();
    const second = buildGatedHarness();

    const firstRun = createGraphWorkflowExecutionLoop(first.harness.deps).run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: first.harness.getCurrent(),
    });
    // Let the first loop register and block inside its iteration.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);

    const secondRun = createGraphWorkflowExecutionLoop(second.harness.deps).run(
      {
        projectPath: "/repo",
        projectName: "test",
        sessionName: "session-1",
        execution: second.harness.getCurrent(),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The stale first loop exits while the second is still running.
    first.releaseIteration();
    await firstRun;
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(true);

    second.releaseIteration();
    await secondRun;
    expect(isExecutionLoopActive("/repo", "session-1")).toBe(false);
  });

  it("exits without recording a halt when a turn cancelled by a pause settles as an abort failure", async () => {
    // Pause/halt actively cancel in-flight turns; the cancelled turn wakes
    // into its failure path within seconds while the execution is already
    // suspended. Recording that as agent_turn_failed would poison the
    // suspended state and drain-halt the next resume with a stale reason.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const runIteration = vi.fn(
      async (): Promise<GraphWorkflowIterationResult> => {
        // The pause transition lands mid-turn and cancels it.
        const paused = structuredClone(harness.getCurrent());
        paused.status = "paused";
        harness.setCurrent(paused);
        throw new AgentTurnFailedError("Prompt execution was aborted", {
          contextId: "ctx-1",
          engine: "claude",
          cause: "abort",
          originalMessage: "Prompt execution was aborted",
        });
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: { runIteration },
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(harness.recordPendingHaltReasonSpy).not.toHaveBeenCalled();
    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(harness.getCurrent().status).toBe("paused");
    expect(harness.getCurrent().pendingHaltReason).toBeNull();
    expect(result.status).toBe("paused");
  });

  it("still halts on an abort-caused turn failure when the execution is running (not transition-cancelled)", async () => {
    // An abort with no lifecycle transition behind it (e.g. a direct Stop on
    // the lane conversation) is a genuine interruption of a running
    // execution — the drain-then-halt path must still engage.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new AgentTurnFailedError("Prompt execution was aborted", {
            contextId: "ctx-1",
            engine: "claude",
            cause: "abort",
            originalMessage: "Prompt execution was aborted",
          });
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

    expect(harness.recordPendingHaltReasonSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("halted");
    expect(result.haltReason).toMatchObject({
      type: "agent_turn_failed",
      cause: "abort",
    });
  });

  it("skips drain-and-halt when a recovery error lands after the execution left running", async () => {
    // The recovery path records a pending halt then drains. If a lifecycle
    // transition parked the execution while the loop was failing, the
    // transition owns the terminal state: the (refused) record must not be
    // followed by a drain that flips paused to halted.
    const definition = createSingleContextDefinition(5);
    const initial = createRunningExecution(definition);
    const scheduleEligibleContexts = vi.fn(
      async (): Promise<ScheduleEligibleContextsResult> => {
        const paused = structuredClone(harness.getCurrent());
        paused.status = "paused";
        harness.setCurrent(paused);
        throw new Error("unexpected scheduler failure");
      },
    );
    const harness = buildHarness({
      initialExecution: initial,
      iterationOrchestrator: {
        async runIteration(): Promise<GraphWorkflowIterationResult> {
          throw new Error("iteration should not run in this test");
        },
      },
      scheduleEligibleContexts,
    });

    const loop = createGraphWorkflowExecutionLoop(harness.deps);
    const result = await loop.run({
      projectPath: "/repo",
      projectName: "test",
      sessionName: "session-1",
      execution: initial,
    });

    expect(harness.drainAndHaltSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("paused");
    expect(harness.getCurrent().status).toBe("paused");
    expect(harness.getCurrent().pendingHaltReason).toBeNull();
  });
});
