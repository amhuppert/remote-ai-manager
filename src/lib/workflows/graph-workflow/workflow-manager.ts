import { randomUUID } from "node:crypto";
import path from "node:path";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createLogger } from "@/lib/logging";
import {
  createExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
  getExecutionLogger,
} from "@/lib/workflow-graph/execution-logger";
import {
  ResetExecutionContextError,
  resetExecutionContext,
} from "@/lib/workflows/graph-workflow/reset-context";
import {
  validateContextId,
  type ParallelWorktrees,
  type ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowStatus,
  SessionState,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/types";

interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
}

interface GraphWorkflowExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

export type GraphWorkflowRecoveryMode =
  | "none"
  | "rehydrated"
  | "interrupted_task"
  | "restart_normalized"
  | "restart_drain_resumed";

export interface GraphWorkflowLifecycleSnapshot {
  schemaVersion: 1;
  lifecycleStatus: GraphWorkflowStatus;
  activeContextId: string | null;
  recoveryMode: GraphWorkflowRecoveryMode;
  hasLiveIteration: boolean;
}

export interface GraphWorkflowStartInput {
  projectPath: string;
  sessionName: string;
  definitionId: string;
}

export interface GraphWorkflowRetryableIterationErrorInput {
  contextId: string;
  errorMessage: string;
}

export type GraphWorkflowManagerEvent =
  | { type: "pause" }
  | { type: "abort" }
  | { type: "complete" }
  | { type: "halt"; reason: GraphWorkflowHaltReason };

export interface GraphWorkflowManagerDeps {
  executionRepository: GraphWorkflowExecutionRepository;
  loadDefinition(
    projectPath: string,
    definitionId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
  now?(): string;
  createExecutionId?(): string;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  /** Check if an execution loop is currently running for this session. When true, normalizeAfterRestart skips normalization. */
  isExecutionLoopActive?(projectPath: string, sessionName: string): boolean;
  parallelWorktrees?: ParallelWorktrees;
  getSession?(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  createBatchId?(): string;
}

export interface ScheduleEligibleContextsInput {
  projectPath: string;
  sessionName: string;
}

export type ScheduleEligibleContextsOutcome =
  | { kind: "none" }
  | { kind: "solo"; contextId: string }
  | { kind: "parallel"; batchId: string; contextIds: string[] };

export interface ScheduleEligibleContextsResult {
  execution: GraphWorkflowExecution;
  scheduled: ScheduleEligibleContextsOutcome;
}

export interface RecordPendingHaltReasonInput {
  projectPath: string;
  sessionName: string;
  reason: GraphWorkflowHaltReason;
  /**
   * Additional mutation applied to the execution within the same
   * mutateActive transaction that records the pending halt reason.
   *
   * Runs unconditionally — even when first-failure-wins rejects the new
   * `reason` — so callers can persist auxiliary state (e.g., a context's
   * merge failure status) atomically with the pending halt write. This is
   * what makes drain-then-halt restart-safe: a crash between the auxiliary
   * write and the halt write would otherwise leave a failed fan-in without
   * the persisted halt reason needed to resume cleanly.
   */
  applyAdditionalMutation?(execution: GraphWorkflowExecution): void;
}

export interface RecordPendingHaltReasonResult {
  execution: GraphWorkflowExecution;
  accepted: boolean;
}

export interface DrainAndHaltInput {
  projectPath: string;
  sessionName: string;
}

const logger = createLogger("graph-workflow-manager");

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getNow(deps: GraphWorkflowManagerDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function getExecutionId(deps: GraphWorkflowManagerDeps): string {
  return deps.createExecutionId?.() ?? randomUUID();
}

function buildMachineSnapshot(
  execution: GraphWorkflowExecution,
  lifecycleStatus: GraphWorkflowStatus,
  recoveryMode: GraphWorkflowRecoveryMode,
  hasLiveIteration: boolean,
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus,
    activeContextId: execution.activeContextIds[0] ?? null,
    recoveryMode,
    hasLiveIteration,
  };
}

function requireRunningExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  if (execution.status !== "running") {
    throw new Error("Only running graph workflow executions can be updated");
  }

  return execution;
}

function markActiveContextReady(execution: GraphWorkflowExecution): void {
  if (execution.activeContextIds.length === 0) {
    return;
  }

  for (const activeContextId of execution.activeContextIds) {
    const activeContext = execution.contextStates[activeContextId];
    if (!activeContext) {
      continue;
    }

    if (activeContext.status === "running") {
      activeContext.status = "ready";
    }
  }
}

function interruptRunningTasks(execution: GraphWorkflowExecution): boolean {
  let foundRunning = false;
  for (const taskState of Object.values(execution.taskStates)) {
    if (taskState.status === "running") {
      taskState.status = "interrupted";
      foundRunning = true;
    }
  }
  return foundRunning;
}

function transitionToNonRunningState(
  execution: GraphWorkflowExecution,
  status: Extract<GraphWorkflowStatus, "paused" | "halted" | "aborted">,
  completedAt: string | null,
  haltReason: GraphWorkflowHaltReason | null,
): GraphWorkflowExecution {
  const nextExecution = cloneExecution(execution);
  const hadRunningTasks = interruptRunningTasks(nextExecution);
  markActiveContextReady(nextExecution);
  nextExecution.status = status;
  nextExecution.completedAt = completedAt;
  nextExecution.haltReason = haltReason;
  nextExecution.machineSnapshot = buildMachineSnapshot(
    nextExecution,
    status,
    hadRunningTasks ? "interrupted_task" : "none",
    false,
  );
  return nextExecution;
}

export function createGraphWorkflowManager(deps: GraphWorkflowManagerDeps) {
  async function start(
    input: GraphWorkflowStartInput,
  ): Promise<GraphWorkflowExecution> {
    const existing = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (existing) {
      throw new Error(
        `Session "${input.sessionName}" already has an active graph workflow execution`,
      );
    }

    const definition = await deps.loadDefinition(
      input.projectPath,
      input.definitionId,
    );
    if (!definition) {
      throw new Error(
        `Workflow definition "${input.definitionId}" was not found`,
      );
    }

    await deps.executionRepository.create(
      input.projectPath,
      input.sessionName,
      {
        definition: definition.definition,
        definitionId: definition.id,
        definitionRevision: definition.revision,
        executionId: getExecutionId(deps),
        startedAt: getNow(deps),
      },
    );

    const nextExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (execution) => {
        execution.status = "running";
        execution.machineSnapshot = buildMachineSnapshot(
          execution,
          "running",
          "none",
          false,
        );
        return execution;
      },
    );

    // Initialize per-execution structured logger
    const execLogger = createExecutionLogger(nextExecution.id);
    registerExecutionLogger(execLogger);
    execLogger.writeManifest(nextExecution);
    execLogger.lifecycle("execution.started", {
      definitionId: definition.id,
      definitionRevision: definition.revision,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      contextCount: definition.definition.executionContexts.length,
      taskCount: definition.definition.tasks.length,
    });
    logger.info("graph-workflow.execution.started", {
      executionId: nextExecution.id,
      definitionId: definition.id,
      definitionRevision: definition.revision,
    });

    return nextExecution;
  }

  async function send(
    projectPath: string,
    sessionName: string,
    event: GraphWorkflowManagerEvent,
  ): Promise<GraphWorkflowExecution> {
    const now = getNow(deps);

    if (event.type === "pause") {
      const nextExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) =>
          transitionToNonRunningState(execution, "paused", null, null),
      );
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.paused");
      logger.info("graph-workflow.execution.paused", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    if (event.type === "abort") {
      const nextExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) =>
          transitionToNonRunningState(execution, "aborted", now, {
            type: "aborted",
          }),
      );
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.aborted");
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(nextExecution.id);
      logger.info("graph-workflow.execution.aborted", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    if (event.type === "complete") {
      const nextExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) => {
          execution.status = "completed";
          execution.completedAt = now;
          execution.haltReason = null;
          execution.machineSnapshot = buildMachineSnapshot(
            execution,
            "completed",
            "none",
            false,
          );
          return execution;
        },
      );
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.completed");
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(nextExecution.id);
      logger.info("graph-workflow.execution.completed", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    const haltReason = event.reason;
    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) =>
        transitionToNonRunningState(execution, "halted", now, haltReason),
    );
    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason,
    });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(nextExecution.id);
    logger.info("graph-workflow.execution.halted", {
      executionId: nextExecution.id,
      haltReasonType: haltReason.type,
    });
    return nextExecution;
  }

  async function resume(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    let previousStatus: GraphWorkflowStatus | null = null;
    let hasInterrupted = false;

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const resumableStatuses: GraphWorkflowStatus[] = ["paused", "halted"];
        if (!resumableStatuses.includes(execution.status)) {
          throw new Error(
            "Only paused or halted graph workflow executions can be resumed",
          );
        }

        previousStatus = execution.status;
        execution.status = "running";
        execution.completedAt = null;
        execution.haltReason = null;

        for (const contextState of Object.values(execution.contextStates)) {
          if (contextState.status === "halted") {
            contextState.status = "ready";
            contextState.consecutiveFailureCount = 0;
          }
        }

        hasInterrupted = Object.values(execution.taskStates).some(
          (ts) => ts.status === "interrupted",
        );
        execution.machineSnapshot = buildMachineSnapshot(
          execution,
          "running",
          hasInterrupted ? "interrupted_task" : "none",
          false,
        );
        return execution;
      },
    );

    // Re-register execution logger on resume
    const execLogger = createExecutionLogger(nextExecution.id);
    registerExecutionLogger(execLogger);
    execLogger.lifecycle("execution.resumed", {
      previousStatus,
      hasInterruptedTasks: hasInterrupted,
      resetContextIds: Object.values(nextExecution.contextStates)
        .filter((cs) => cs.status === "ready")
        .map((cs) => cs.contextId),
    });
    logger.info("graph-workflow.execution.resumed", {
      executionId: nextExecution.id,
      previousStatus,
    });

    return nextExecution;
  }

  async function normalizeAfterRestart(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      return null;
    }

    if (execution.status !== "running") {
      return execution;
    }

    // If the execution loop is genuinely active in this process, the
    // iteration is still running — skip normalization.
    if (deps.isExecutionLoopActive?.(projectPath, sessionName)) {
      return execution;
    }

    const normalizedExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (current) => {
        if (current.status !== "running") {
          return current;
        }

        if (current.pendingHaltReason !== null) {
          const haltReason = current.pendingHaltReason;
          const transitioned = transitionToNonRunningState(
            current,
            "halted",
            getNow(deps),
            haltReason,
          );
          transitioned.pendingHaltReason = null;
          transitioned.machineSnapshot = buildMachineSnapshot(
            transitioned,
            "halted",
            "restart_drain_resumed",
            false,
          );
          return transitioned;
        }

        const nextExecution = transitionToNonRunningState(
          current,
          "paused",
          null,
          null,
        );
        nextExecution.machineSnapshot = buildMachineSnapshot(
          nextExecution,
          "paused",
          "restart_normalized",
          false,
        );
        return nextExecution;
      },
    );

    if (
      normalizedExecution.status === "halted" &&
      normalizedExecution.haltReason !== null
    ) {
      const execLogger = getExecutionLogger(normalizedExecution.id);
      execLogger?.lifecycle("execution.halted", {
        haltReason: normalizedExecution.haltReason,
        cause: "restart_drain_resumed",
      });
      execLogger?.writeManifest(normalizedExecution);
      unregisterExecutionLogger(normalizedExecution.id);
      logger.info("graph-workflow.execution.halted", {
        executionId: normalizedExecution.id,
        haltReasonType: normalizedExecution.haltReason.type,
        cause: "restart_drain_resumed",
      });
    }

    return normalizedExecution;
  }

  async function scheduleNextContext(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    let scheduledContextId: string | null = null;
    let scheduledEligibleContextIds: string[] = [];
    let scheduledClearedLanes: string[] = [];

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const running = requireRunningExecution(execution);
        const eligibleContextIds = getEligibleContextIds(
          running.workingDefinition,
          running,
        );

        for (const contextId of eligibleContextIds) {
          const contextState = running.contextStates[contextId];
          if (!contextState) {
            continue;
          }

          contextState.status = "ready";
        }

        const nextContextId = eligibleContextIds[0] ?? null;
        running.activeContextIds = nextContextId ? [nextContextId] : [];
        if (nextContextId) {
          running.contextStates[nextContextId]!.status = "running";
          const clearedLanes = Object.keys(running.laneStates);
          running.laneStates = {};

          scheduledContextId = nextContextId;
          scheduledEligibleContextIds = eligibleContextIds;
          scheduledClearedLanes = clearedLanes;
        }

        running.machineSnapshot = buildMachineSnapshot(
          running,
          "running",
          "none",
          false,
        );
        return running;
      },
    );

    if (scheduledContextId) {
      logger.info("graph-workflow.context.scheduled", {
        executionId: nextExecution.id,
        nextContextId: scheduledContextId,
        eligibleContextIds: scheduledEligibleContextIds,
        clearedLanes: scheduledClearedLanes,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("context.scheduled", {
        contextId: scheduledContextId,
        eligibleContextIds: scheduledEligibleContextIds,
        clearedLanes: scheduledClearedLanes,
      });
    }

    return nextExecution;
  }

  async function scheduleEligibleContexts(
    input: ScheduleEligibleContextsInput,
  ): Promise<ScheduleEligibleContextsResult> {
    const { projectPath, sessionName } = input;
    const outcome: { value: ScheduleEligibleContextsOutcome } = {
      value: { kind: "none" },
    };
    let scheduledClearedLanes: string[] = [];

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      async (execution) => {
        const running = requireRunningExecution(execution);
        const eligibleContextIds = getEligibleContextIds(
          running.workingDefinition,
          running,
        );

        if (eligibleContextIds.length === 0) {
          running.machineSnapshot = buildMachineSnapshot(
            running,
            "running",
            "none",
            false,
          );
          outcome.value = { kind: "none" };
          return running;
        }

        for (const contextId of eligibleContextIds) {
          const contextState = running.contextStates[contextId];
          if (contextState) {
            contextState.status = "ready";
          }
        }

        if (eligibleContextIds.length === 1) {
          const soloContextId = eligibleContextIds[0]!;
          const contextState = running.contextStates[soloContextId]!;
          contextState.status = "running";
          contextState.isolation = "session";
          contextState.worktreePath = null;
          contextState.branchName = null;
          contextState.batchId = null;
          running.activeContextIds = [soloContextId];

          const clearedLanes = Object.keys(running.laneStates);
          running.laneStates = {};
          scheduledClearedLanes = clearedLanes;

          running.machineSnapshot = buildMachineSnapshot(
            running,
            "running",
            "none",
            false,
          );
          outcome.value = { kind: "solo", contextId: soloContextId };
          return running;
        }

        if (!deps.parallelWorktrees) {
          throw new Error(
            "scheduleEligibleContexts requires `parallelWorktrees` dep when ≥2 contexts are eligible",
          );
        }
        if (!deps.getSession) {
          throw new Error(
            "scheduleEligibleContexts requires `getSession` dep when ≥2 contexts are eligible",
          );
        }

        for (const contextId of eligibleContextIds) {
          validateContextId(contextId);
        }

        const session = await deps.getSession(projectPath, sessionName);
        if (!session) {
          throw new Error(
            `Session "${sessionName}" was not found for parallel scheduling`,
          );
        }
        const sessionDir = path.basename(session.worktreePath);
        const sessionBranch = session.branchName;
        const batchId = deps.createBatchId?.() ?? randomUUID();

        const provisioned: Array<{
          contextId: string;
          result: ProvisionResult;
        }> = [];
        try {
          for (const contextId of eligibleContextIds) {
            const result = await deps.parallelWorktrees.provision({
              projectPath,
              sessionName,
              sessionDir,
              sessionBranch,
              contextId,
            });
            provisioned.push({ contextId, result });
          }
        } catch (err) {
          for (const { result } of provisioned) {
            await deps.parallelWorktrees.dispose({
              projectPath,
              worktreePath: result.worktreePath,
              branchName: result.branchName,
            });
          }
          throw err;
        }

        for (const { contextId, result } of provisioned) {
          const contextState = running.contextStates[contextId]!;
          contextState.status = "running";
          contextState.isolation = "worktree";
          contextState.worktreePath = result.worktreePath;
          contextState.branchName = result.branchName;
          contextState.batchId = batchId;
        }

        running.activeContextIds = [...eligibleContextIds];
        const clearedLanes = Object.keys(running.laneStates);
        running.laneStates = {};
        scheduledClearedLanes = clearedLanes;

        running.machineSnapshot = buildMachineSnapshot(
          running,
          "running",
          "none",
          false,
        );

        outcome.value = {
          kind: "parallel",
          batchId,
          contextIds: [...eligibleContextIds],
        };
        return running;
      },
    );

    const scheduled = outcome.value;
    if (scheduled.kind === "solo") {
      logger.info("graph-workflow.context.scheduled", {
        executionId: nextExecution.id,
        nextContextId: scheduled.contextId,
        eligibleContextIds: [scheduled.contextId],
        clearedLanes: scheduledClearedLanes,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("context.scheduled", {
        contextId: scheduled.contextId,
        eligibleContextIds: [scheduled.contextId],
        clearedLanes: scheduledClearedLanes,
      });
    } else if (scheduled.kind === "parallel") {
      logger.info("graph-workflow.parallel.batch_scheduled", {
        executionId: nextExecution.id,
        batchId: scheduled.batchId,
        contextIds: scheduled.contextIds,
        clearedLanes: scheduledClearedLanes,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.batch_scheduled", {
        batchId: scheduled.batchId,
        contextIds: scheduled.contextIds,
        clearedLanes: scheduledClearedLanes,
      });
    }

    return { execution: nextExecution, scheduled };
  }

  async function recoverRetryableIterationError(
    projectPath: string,
    sessionName: string,
    input: GraphWorkflowRetryableIterationErrorInput,
  ): Promise<GraphWorkflowExecution> {
    const now = getNow(deps);
    let rotationScheduled = false;

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const running = requireRunningExecution(execution);
        const contextState = running.contextStates[input.contextId];
        if (!contextState) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }

        contextState.status = "ready";
        if (!running.activeContextIds.includes(input.contextId)) {
          running.activeContextIds = [
            ...running.activeContextIds,
            input.contextId,
          ];
        }
        running.completedAt = null;
        running.haltReason = null;
        running.machineSnapshot = buildMachineSnapshot(
          running,
          "running",
          "none",
          false,
        );

        const implementerLane =
          running.laneStates[input.contextId]?.["implementer"];
        rotationScheduled =
          implementerLane?.engine === "claude" &&
          implementerLane.contextId === input.contextId;

        if (rotationScheduled && implementerLane) {
          implementerLane.rotateBeforeNextTurn = true;
          implementerLane.lastUsedAt = now;
        }

        return running;
      },
    );

    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.decision("iteration.retryable_error_recovery", {
      contextId: input.contextId,
      error: input.errorMessage,
      rotationScheduled,
    });
    logger.warn("graph-workflow.iteration.retryable_error_recovery", {
      executionId: nextExecution.id,
      contextId: input.contextId,
      error: input.errorMessage,
      rotationScheduled,
    });

    return nextExecution;
  }

  async function recordPendingHaltReason(
    input: RecordPendingHaltReasonInput,
  ): Promise<RecordPendingHaltReasonResult> {
    const { projectPath, sessionName, reason, applyAdditionalMutation } = input;
    let accepted = false;

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const next = cloneExecution(execution);
        if (applyAdditionalMutation) {
          applyAdditionalMutation(next);
        }
        if (execution.pendingHaltReason === null) {
          next.pendingHaltReason = reason;
          accepted = true;
        }
        return next;
      },
    );

    if (accepted) {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.pending_halt_recorded", {
        haltReason: reason,
      });
      logger.info("graph-workflow.parallel.pending_halt_recorded", {
        executionId: nextExecution.id,
        haltReasonType: reason.type,
      });
    } else {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.secondary_failure", {
        attemptedHaltReason: reason,
        existingHaltReason: nextExecution.pendingHaltReason,
      });
      logger.info("graph-workflow.parallel.secondary_failure", {
        executionId: nextExecution.id,
        attemptedHaltReasonType: reason.type,
        existingHaltReasonType: nextExecution.pendingHaltReason?.type ?? null,
      });
    }

    return { execution: nextExecution, accepted };
  }

  async function drainAndHalt(
    input: DrainAndHaltInput,
  ): Promise<GraphWorkflowExecution> {
    const { projectPath, sessionName } = input;
    const now = getNow(deps);

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const haltReason = execution.pendingHaltReason;
        if (haltReason === null) {
          throw new Error(
            "drainAndHalt requires pendingHaltReason to be set before invocation",
          );
        }
        const transitioned = transitionToNonRunningState(
          execution,
          "halted",
          now,
          haltReason,
        );
        transitioned.pendingHaltReason = null;
        return transitioned;
      },
    );

    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason: nextExecution.haltReason,
      cause: "drain_and_halt",
    });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(nextExecution.id);
    logger.info("graph-workflow.execution.halted", {
      executionId: nextExecution.id,
      haltReasonType: nextExecution.haltReason?.type,
      cause: "drain_and_halt",
    });

    return nextExecution;
  }

  async function hasActive(
    projectPath: string,
    sessionName: string,
  ): Promise<boolean> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    return execution !== null;
  }

  async function resetContext(
    projectPath: string,
    sessionName: string,
    contextId: string,
  ): Promise<GraphWorkflowExecution> {
    let previousStatus: GraphWorkflowStatus | null = null;

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        previousStatus = execution.status;
        logger.info("graph-workflow.context.reset_requested", {
          executionId: execution.id,
          contextId,
          status: execution.status,
        });

        try {
          return resetExecutionContext(execution, contextId);
        } catch (error) {
          if (error instanceof ResetExecutionContextError) {
            logger.warn("graph-workflow.context.reset_rejected", {
              executionId: execution.id,
              contextId,
              status: execution.status,
              reason: error.message,
            });
          }
          throw error;
        }
      },
    );

    let execLogger = getExecutionLogger(nextExecution.id);
    if (!execLogger) {
      execLogger = createExecutionLogger(nextExecution.id);
      registerExecutionLogger(execLogger);
    }
    execLogger.lifecycle("context.reset", {
      contextId,
      previousStatus,
    });
    logger.info("graph-workflow.context.reset_applied", {
      executionId: nextExecution.id,
      contextId,
      previousStatus,
    });

    return nextExecution;
  }

  async function mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution> {
    return deps.executionRepository.mutateActive(projectPath, sessionName, fn);
  }

  async function getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    return deps.executionRepository.getActive(projectPath, sessionName);
  }

  return {
    start,
    send,
    resume,
    normalizeAfterRestart,
    scheduleNextContext,
    scheduleEligibleContexts,
    recoverRetryableIterationError,
    recordPendingHaltReason,
    drainAndHalt,
    resetContext,
    hasActive,
    mutateActive,
    getActive,
  };
}
