import { randomUUID } from "node:crypto";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowStatus,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
  WorkflowValidatorIssue,
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

export interface GraphWorkflowContextValidationResultInput {
  contextId: string;
  pass: boolean;
  summary?: string | null;
  issues?: WorkflowValidatorIssue[];
  reopenTaskIds?: string[];
  scriptOutput?: string;
  scriptOutputDocumentPath?: string;
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

function reopenTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
  reopenTaskIds: string[],
  now: string,
): void {
  for (const taskId of reopenTaskIds) {
    const taskState = execution.taskStates[taskId];
    if (!taskState || taskState.contextId !== contextId) continue;
    if (taskState.status !== "completed") continue;

    taskState.status = "pending";
    taskState.summary = null;
    taskState.completedAt = null;
    taskState.reopenedCount += 1;
    taskState.lastReopenedAt = now;
  }
}

function createFixTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
  issues: WorkflowValidatorIssue[],
): void {
  const contextTasks = execution.workingDefinition.tasks.filter(
    (t) => t.contextId === contextId,
  );
  let maxOrder = contextTasks.reduce((max, t) => Math.max(max, t.order), 0);

  for (const issue of issues) {
    const taskId = `fix-${randomUUID().slice(0, 8)}`;
    maxOrder += 1;

    execution.workingDefinition.tasks.push({
      id: taskId,
      contextId,
      order: maxOrder,
      title: `Fix: ${issue.title}`,
      instructions: issue.description,
      source: "validator",
    });

    execution.taskStates[taskId] = {
      taskId,
      contextId,
      order: maxOrder,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      reopenedCount: 0,
      lastReopenedAt: null,
      failureMessage: null,
    };
  }
}

function recomputeContextCounts(
  execution: GraphWorkflowExecution,
  contextId: string,
): void {
  const contextState = execution.contextStates[contextId];
  if (!contextState) return;

  const contextTasks = execution.workingDefinition.tasks.filter(
    (t) => t.contextId === contextId,
  );
  contextState.totalTaskCount = contextTasks.length;
  contextState.completedTaskCount = contextTasks.filter(
    (t) => execution.taskStates[t.id]?.status === "completed",
  ).length;
}

function registerScriptOutputDocument(
  execution: GraphWorkflowExecution,
  result: GraphWorkflowContextValidationResultInput,
  now: string,
): void {
  const docPath = result.scriptOutputDocumentPath!;
  const existingIndex = execution.sharedDocuments.findIndex(
    (entry) => entry.relativePath === docPath,
  );

  const entry: GraphWorkflowSharedDocumentEntry = {
    id:
      existingIndex >= 0
        ? execution.sharedDocuments[existingIndex]!.id
        : `validation-output-${result.contextId}`,
    relativePath: docPath,
    description: "Output from failed pre-merge validation script",
    readWhen: "When fixing validation failures for this execution context",
    createdAt:
      existingIndex >= 0
        ? execution.sharedDocuments[existingIndex]!.createdAt
        : now,
    updatedAt: now,
    lastUpdatedByConversationId: null,
  };

  if (existingIndex >= 0) {
    execution.sharedDocuments[existingIndex] = entry;
  } else {
    execution.sharedDocuments.push(entry);
  }
}

function buildFallbackFixInstructions(
  result: GraphWorkflowContextValidationResultInput,
): string {
  const parts: string[] = [];

  if (result.scriptOutputDocumentPath) {
    parts.push(
      `The pre-merge validation script failed. Read the validation output at \`${result.scriptOutputDocumentPath}\` for details on what failed.`,
    );
  }

  if (result.summary) {
    parts.push(`Summary: ${result.summary}`);
  }

  if (result.scriptOutput && !result.scriptOutputDocumentPath) {
    parts.push("Validation output:", "```", result.scriptOutput, "```");
  }

  parts.push("Fix all validation errors and verify the fix passes validation.");

  return parts.join("\n\n");
}

function applyValidationRemediations(
  execution: GraphWorkflowExecution,
  result: GraphWorkflowContextValidationResultInput,
  now: string,
): void {
  const taskIds = result.reopenTaskIds ?? [];
  if (taskIds.length > 0) {
    reopenTasks(execution, result.contextId, taskIds, now);
  }

  const issues = result.issues ?? [];
  if (issues.length > 0) {
    createFixTasks(execution, result.contextId, issues);
  }

  if (result.scriptOutputDocumentPath) {
    registerScriptOutputDocument(execution, result, now);
  }

  // Fallback guarantee: if no incomplete tasks exist after remediations,
  // create a fix task to prevent the retry deadlock
  const hasIncompleteTask = execution.workingDefinition.tasks
    .filter((t) => t.contextId === result.contextId)
    .some((t) => execution.taskStates[t.id]?.status !== "completed");

  if (!hasIncompleteTask) {
    const fallbackIssue: WorkflowValidatorIssue = {
      title: "Fix validation failures",
      description: buildFallbackFixInstructions(result),
    };
    createFixTasks(execution, result.contextId, [fallbackIssue]);
  }

  recomputeContextCounts(execution, result.contextId);
}

export function createGraphWorkflowManager(deps: GraphWorkflowManagerDeps) {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();

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
    const resumableStatuses: GraphWorkflowStatus[] = [
      "paused",
      "halted",
      "aborted",
    ];
    if (!resumableStatuses.includes(execution.status)) {
      throw new Error(
        "Only paused, halted, or aborted graph workflow executions can be resumed",
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

    for (const retryEntry of Object.values(nextExecution.retryState)) {
      const contextState = nextExecution.contextStates[retryEntry.contextId];
      if (contextState && contextState.status === "ready") {
        retryEntry.attempt = 0;
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

  async function recordContextValidationResult(
    projectPath: string,
    sessionName: string,
    result: GraphWorkflowContextValidationResultInput,
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
    const contextState = nextExecution.contextStates[result.contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${result.contextId}" does not exist in runtime state`,
      );
    }

    contextState.lastValidationAt = now;
    contextState.lastValidationPass = result.pass;

    const validationEventFields = {
      issues: result.issues ?? [],
      reopenTaskIds: result.reopenTaskIds ?? [],
    };

    if (result.pass) {
      contextState.status = "completed";
      contextState.completedTaskCount = contextState.totalTaskCount;
      contextState.consecutiveFailureCount = 0;
      if (nextExecution.retryState[result.contextId]) {
        nextExecution.retryState[result.contextId]!.attempt = 0;
      }
      if (nextExecution.activeContextId === result.contextId) {
        nextExecution.activeContextId = null;
      }
      nextExecution.completedAt = null;
      nextExecution.haltReason = null;
      nextExecution.machineSnapshot = buildMachineSnapshot(
        nextExecution,
        "running",
        "none",
        false,
      );
      const executionWithValidationEvent =
        eventPublisher.publishValidationResult({
          projectPath,
          sessionName,
          execution: nextExecution,
          contextId: result.contextId,
          validatorType: "context",
          pass: true,
          summary: result.summary ?? "Validation passed",
          ...validationEventFields,
        });
      return updateExecution(
        deps.executionRepository,
        projectPath,
        sessionName,
        executionWithValidationEvent,
      );
    }

    // Apply remediations before deciding on retry/halt
    applyValidationRemediations(nextExecution, result, now);

    contextState.consecutiveFailureCount += 1;

    // Single decision: can we retry, or does the circuit breaker trip?
    const retryState = nextExecution.retryState[result.contextId];
    if (retryState) {
      const nextAttempt = retryState.attempt + 1;
      retryState.attempt = nextAttempt;
      if (nextAttempt < retryState.maxAttempts) {
        contextState.status = "ready";
        nextExecution.activeContextId = result.contextId;
        nextExecution.completedAt = null;
        nextExecution.haltReason = null;
        nextExecution.machineSnapshot = buildMachineSnapshot(
          nextExecution,
          "running",
          "none",
          false,
        );
        const executionWithValidationEvent =
          eventPublisher.publishValidationResult({
            projectPath,
            sessionName,
            execution: nextExecution,
            contextId: result.contextId,
            validatorType: "context",
            pass: false,
            summary: result.summary ?? "Validation failed",
            ...validationEventFields,
          });
        return updateExecution(
          deps.executionRepository,
          projectPath,
          sessionName,
          executionWithValidationEvent,
        );
      }
    }

    // Circuit breaker trips: retries exhausted (or no retry policy)
    contextState.status = "halted";
    nextExecution.status = "halted";
    nextExecution.activeContextId = result.contextId;
    nextExecution.completedAt = now;
    nextExecution.haltReason = {
      type: "circuit_breaker",
      contextId: result.contextId,
      condition: "retry_exhaustion",
      failureCount: contextState.consecutiveFailureCount,
      summary: result.summary ?? null,
    };
    nextExecution.machineSnapshot = buildMachineSnapshot(
      nextExecution,
      "halted",
      "none",
      false,
    );
    const executionWithValidationEvent = eventPublisher.publishValidationResult(
      {
        projectPath,
        sessionName,
        execution: nextExecution,
        contextId: result.contextId,
        validatorType: "context",
        pass: false,
        summary: result.summary ?? "Validation failed",
        ...validationEventFields,
      },
    );
    return updateExecution(
      deps.executionRepository,
      projectPath,
      sessionName,
      executionWithValidationEvent,
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

  return {
    start,
    send,
    resume,
    normalizeAfterRestart,
    scheduleNextContext,
    recordContextValidationResult,
    hasActive,
  };
}
