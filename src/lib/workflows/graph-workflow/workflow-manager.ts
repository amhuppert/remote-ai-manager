import { randomUUID } from "node:crypto";
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
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowStatus,
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
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
}

export type GraphWorkflowRecoveryMode =
  | "none"
  | "rehydrated"
  | "interrupted_task"
  | "restart_normalized";

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
    activeContextId: execution.activeContextId,
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
  if (!execution.activeContextId) {
    return;
  }

  const activeContext = execution.contextStates[execution.activeContextId];
  if (!activeContext) {
    return;
  }

  if (activeContext.status === "running") {
    activeContext.status = "ready";
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

async function requireActiveExecution(
  repository: GraphWorkflowExecutionRepository,
  projectPath: string,
  sessionName: string,
): Promise<GraphWorkflowExecution> {
  const execution = await repository.getActive(projectPath, sessionName);
  if (!execution) {
    throw new Error("Session does not have an active graph workflow execution");
  }

  return execution;
}

async function updateExecution(
  repository: GraphWorkflowExecutionRepository,
  projectPath: string,
  sessionName: string,
  execution: GraphWorkflowExecution,
): Promise<GraphWorkflowExecution> {
  await repository.update(projectPath, sessionName, execution);
  return execution;
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

    const created = await deps.executionRepository.create(
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

    const nextExecution = cloneExecution(created);
    nextExecution.status = "running";
    nextExecution.machineSnapshot = buildMachineSnapshot(
      nextExecution,
      "running",
      "none",
      false,
    );

    await deps.executionRepository.update(
      input.projectPath,
      input.sessionName,
      nextExecution,
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
    const execution = await requireActiveExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
    );
    const now = getNow(deps);

    const execLogger = getExecutionLogger(execution.id);

    if (event.type === "pause") {
      const nextExecution = transitionToNonRunningState(
        execution,
        "paused",
        null,
        null,
      );
      await deps.executionRepository.update(
        projectPath,
        sessionName,
        nextExecution,
      );
      execLogger?.lifecycle("execution.paused");
      logger.info("graph-workflow.execution.paused", {
        executionId: execution.id,
      });
      return nextExecution;
    }

    if (event.type === "abort") {
      const nextExecution = transitionToNonRunningState(
        execution,
        "aborted",
        now,
        { type: "aborted" },
      );
      await deps.executionRepository.update(
        projectPath,
        sessionName,
        nextExecution,
      );
      execLogger?.lifecycle("execution.aborted");
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(execution.id);
      logger.info("graph-workflow.execution.aborted", {
        executionId: execution.id,
      });
      return nextExecution;
    }

    if (event.type === "complete") {
      const nextExecution = cloneExecution(execution);
      nextExecution.status = "completed";
      nextExecution.completedAt = now;
      nextExecution.haltReason = null;
      nextExecution.machineSnapshot = buildMachineSnapshot(
        nextExecution,
        "completed",
        "none",
        false,
      );
      await deps.executionRepository.update(
        projectPath,
        sessionName,
        nextExecution,
      );
      execLogger?.lifecycle("execution.completed");
      execLogger?.writeManifest(nextExecution);
      unregisterExecutionLogger(execution.id);
      logger.info("graph-workflow.execution.completed", {
        executionId: execution.id,
      });
      return nextExecution;
    }

    const nextExecution = transitionToNonRunningState(
      execution,
      "halted",
      now,
      event.reason,
    );
    await deps.executionRepository.update(
      projectPath,
      sessionName,
      nextExecution,
    );
    execLogger?.lifecycle("execution.halted", {
      haltReason: event.reason,
    });
    execLogger?.writeManifest(nextExecution);
    unregisterExecutionLogger(execution.id);
    logger.info("graph-workflow.execution.halted", {
      executionId: execution.id,
      haltReasonType: event.reason.type,
    });
    return nextExecution;
  }

  async function resume(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    const execution = await requireActiveExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
    );
    const resumableStatuses: GraphWorkflowStatus[] = ["paused", "halted"];
    if (!resumableStatuses.includes(execution.status)) {
      throw new Error(
        "Only paused or halted graph workflow executions can be resumed",
      );
    }

    const nextExecution = cloneExecution(execution);
    nextExecution.status = "running";
    nextExecution.completedAt = null;
    nextExecution.haltReason = null;

    for (const contextState of Object.values(nextExecution.contextStates)) {
      if (contextState.status === "halted") {
        contextState.status = "ready";
        contextState.consecutiveFailureCount = 0;
      }
    }

    const hasInterrupted = Object.values(nextExecution.taskStates).some(
      (ts) => ts.status === "interrupted",
    );
    nextExecution.machineSnapshot = buildMachineSnapshot(
      nextExecution,
      "running",
      hasInterrupted ? "interrupted_task" : "none",
      false,
    );

    await deps.executionRepository.update(
      projectPath,
      sessionName,
      nextExecution,
    );

    // Re-register execution logger on resume
    const execLogger = createExecutionLogger(nextExecution.id);
    registerExecutionLogger(execLogger);
    execLogger.lifecycle("execution.resumed", {
      previousStatus: execution.status,
      hasInterruptedTasks: hasInterrupted,
      resetContextIds: Object.values(nextExecution.contextStates)
        .filter((cs) => cs.status === "ready")
        .map((cs) => cs.contextId),
    });
    logger.info("graph-workflow.execution.resumed", {
      executionId: nextExecution.id,
      previousStatus: execution.status,
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

    const nextExecution = transitionToNonRunningState(
      execution,
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
    await deps.executionRepository.update(
      projectPath,
      sessionName,
      nextExecution,
    );
    return nextExecution;
  }

  async function scheduleNextContext(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    const execution = requireRunningExecution(
      await requireActiveExecution(
        deps.executionRepository,
        projectPath,
        sessionName,
      ),
    );
    const nextExecution = cloneExecution(execution);
    const eligibleContextIds = getEligibleContextIds(
      nextExecution.workingDefinition,
      nextExecution,
    );

    for (const contextId of eligibleContextIds) {
      const contextState = nextExecution.contextStates[contextId];
      if (!contextState) {
        continue;
      }

      contextState.status = "ready";
    }

    const nextContextId = eligibleContextIds[0] ?? null;
    nextExecution.activeContextId = nextContextId;
    if (nextContextId) {
      nextExecution.contextStates[nextContextId]!.status = "running";
      const clearedLanes = Object.keys(nextExecution.laneStates);
      logger.info("graph-workflow.context.scheduled", {
        executionId: nextExecution.id,
        nextContextId,
        eligibleContextIds,
        clearedLanes,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("context.scheduled", {
        contextId: nextContextId,
        eligibleContextIds,
        clearedLanes,
      });
      nextExecution.laneStates = {};
    }

    nextExecution.machineSnapshot = buildMachineSnapshot(
      nextExecution,
      "running",
      "none",
      false,
    );

    return updateExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
      nextExecution,
    );
  }

  async function recoverRetryableIterationError(
    projectPath: string,
    sessionName: string,
    input: GraphWorkflowRetryableIterationErrorInput,
  ): Promise<GraphWorkflowExecution> {
    const execution = requireRunningExecution(
      await requireActiveExecution(
        deps.executionRepository,
        projectPath,
        sessionName,
      ),
    );
    const now = getNow(deps);
    const nextExecution = cloneExecution(execution);
    const contextState = nextExecution.contextStates[input.contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    contextState.status = "ready";
    nextExecution.activeContextId = input.contextId;
    nextExecution.completedAt = null;
    nextExecution.haltReason = null;
    nextExecution.machineSnapshot = buildMachineSnapshot(
      nextExecution,
      "running",
      "none",
      false,
    );

    const implementerLane = nextExecution.laneStates["implementer"];
    const rotationScheduled =
      implementerLane?.engine === "claude" &&
      implementerLane.contextId === input.contextId;

    if (rotationScheduled) {
      implementerLane.rotateBeforeNextTurn = true;
      implementerLane.lastUsedAt = now;
    }

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

    return updateExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
      nextExecution,
    );
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
    const execution = await requireActiveExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
    );

    logger.info("graph-workflow.context.reset_requested", {
      executionId: execution.id,
      contextId,
      status: execution.status,
    });

    let nextExecution: GraphWorkflowExecution;
    try {
      nextExecution = resetExecutionContext(execution, contextId);
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

    await deps.executionRepository.update(
      projectPath,
      sessionName,
      nextExecution,
    );

    let execLogger = getExecutionLogger(nextExecution.id);
    if (!execLogger) {
      execLogger = createExecutionLogger(nextExecution.id);
      registerExecutionLogger(execLogger);
    }
    execLogger.lifecycle("context.reset", {
      contextId,
      previousStatus: execution.status,
    });
    logger.info("graph-workflow.context.reset_applied", {
      executionId: nextExecution.id,
      contextId,
      previousStatus: execution.status,
    });

    return nextExecution;
  }

  return {
    start,
    send,
    resume,
    normalizeAfterRestart,
    scheduleNextContext,
    recoverRetryableIterationError,
    resetContext,
    hasActive,
  };
}
