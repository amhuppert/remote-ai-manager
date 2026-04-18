import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  AgentBackendId,
  AgentSessionRef,
  GraphWorkflowExecution,
  GraphWorkflowResolvedContext,
  GraphWorkflowHaltReason,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationResultEvent,
  WorkflowValidatorIssue,
} from "@/types";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import type {
  ResolveImplementerCallInput,
  ResolvedImplementerCall,
  RecordClaudeLaneTurnInput,
  RecordCodexLaneTurnInput,
} from "./workflow-continuity-service";
import {
  buildIterationPrompt,
  buildFollowUpPrompt,
  type LatestContextValidationFailureFeedback,
} from "./iteration-prompt";
import {
  createGraphWorkflowValidationService,
  type GraphWorkflowValidationService,
} from "@/lib/workflow-graph/execution-validation";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import {
  emit as defaultEmitStreamFrame,
  type GraphWorkflowStreamFrame,
} from "@/lib/workflow-graph/stream-registry";
import type { GraphWorkflowLifecycleSnapshot } from "./workflow-manager";

export interface GraphWorkflowIterationExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
}

export interface GraphWorkflowIterationConversation {
  id: string;
}

export interface GraphWorkflowIterationToolServer {
  server: unknown;
  close?(): Promise<void> | void;
}

export interface GraphWorkflowIterationToolServerInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  executionId: string;
  conversationId: string;
  contextId: string;
  contextTitle: string;
  allowAgentTaskAdd: boolean;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  completeTask(
    taskId: string,
    summary: string,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowRunAgentIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  executionId: string;
  conversationId: string;
  contextId: string;
  prompt: string;
  backend: AgentBackendId;
  model: string;
  reasoningEffort: string;
  toolServer: unknown;
  emitStreamFrame?(frame: GraphWorkflowStreamFrame): void;
}

export interface GraphWorkflowAgentIterationResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  sessionRef?: AgentSessionRef | null;
}

export interface IterationOrchestratorContinuityService {
  resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall>;
  recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): GraphWorkflowExecution;
  recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): GraphWorkflowExecution;
}

export interface GraphWorkflowIterationOrchestratorDeps {
  executionRepository: GraphWorkflowIterationExecutionRepository;
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: { role: "iteration" },
  ): Promise<GraphWorkflowIterationConversation>;
  createToolServer(
    input: GraphWorkflowIterationToolServerInput,
  ): GraphWorkflowIterationToolServer;
  runAgentIteration(
    input: GraphWorkflowRunAgentIterationInput,
  ): Promise<GraphWorkflowAgentIterationResult>;
  signalHalt?(
    input: GraphWorkflowSignalHaltInput,
  ): Promise<GraphWorkflowExecution>;
  continuityService?: IterationOrchestratorContinuityService;
  validationService?: GraphWorkflowValidationService;
  now?(): string;
  emitStreamFrame?(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
}

export interface GraphWorkflowIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
}

export interface GraphWorkflowIterationResult {
  conversationId: string;
  execution: GraphWorkflowExecution;
  shouldContinueInContext: boolean;
}

export class IterationHaltedError extends Error {
  readonly haltReason: GraphWorkflowHaltReason;

  constructor(haltReason: GraphWorkflowHaltReason) {
    super(`Iteration halted: ${haltReason.type}`);
    this.name = "IterationHaltedError";
    this.haltReason = haltReason;
  }
}

export interface GraphWorkflowSignalHaltInput {
  projectPath: string;
  sessionName: string;
  reason: GraphWorkflowHaltReason;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getNow(deps: GraphWorkflowIterationOrchestratorDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function buildMachineSnapshot(
  execution: GraphWorkflowExecution,
  hasLiveIteration: boolean,
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus: execution.status,
    activeContextId: execution.activeContextId,
    recoveryMode: "none",
    hasLiveIteration,
  };
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function getContextTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

function getIncompleteTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status !== "completed",
  );
}

function countCompletedTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status === "completed",
  ).length;
}

function countRemainingTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getIncompleteTasks(execution, contextId).length;
}

function bindConversationToIncompleteTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
  conversationId: string,
  startedAt: string,
): void {
  for (const task of getIncompleteTasks(execution, contextId)) {
    const taskState = execution.taskStates[task.id];
    if (!taskState) {
      continue;
    }

    taskState.lastConversationId = conversationId;
    taskState.startedAt ??= startedAt;
  }
}

function getLatestFailedContextValidationEvent(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowValidationResultEvent | null {
  for (let index = execution.history.length - 1; index >= 0; index -= 1) {
    const entry = execution.history[index];
    if (!entry) {
      continue;
    }

    const { event } = entry;
    if (
      event.type === "graph-workflow-validation-result" &&
      event.contextId === contextId &&
      event.validatorType === "context" &&
      event.pass === false &&
      event.reopenTaskIds.length > 0
    ) {
      return event;
    }
  }

  return null;
}

function buildLatestContextValidationFailureFeedback(
  execution: GraphWorkflowExecution,
  contextId: string,
): LatestContextValidationFailureFeedback | undefined {
  const latestFailure = getLatestFailedContextValidationEvent(
    execution,
    contextId,
  );
  if (!latestFailure) {
    return undefined;
  }

  const contextTasks = getContextTasks(execution, contextId);
  const taskTitles = new Map(
    contextTasks.map((task) => [task.id, task.title] as const),
  );
  const reopenedTasks = latestFailure.reopenTaskIds.map((taskId) => ({
    taskId,
    title: taskTitles.get(taskId) ?? taskId,
  }));

  const scopedIssues = new Map<string, WorkflowValidatorIssue[]>();
  const generalIssues: WorkflowValidatorIssue[] = [];
  for (const issue of latestFailure.issues) {
    if (issue.taskId && taskTitles.has(issue.taskId)) {
      const existing = scopedIssues.get(issue.taskId) ?? [];
      existing.push(issue);
      scopedIssues.set(issue.taskId, existing);
      continue;
    }
    generalIssues.push(issue);
  }

  const groupedIssues: LatestContextValidationFailureFeedback["groupedIssues"] =
    reopenedTasks.flatMap((task) => {
      const issues = scopedIssues.get(task.taskId);
      if (!issues || issues.length === 0) {
        return [];
      }
      return [
        {
          heading: `Task \`${task.taskId}\` - ${task.title}`,
          issues: issues.map((issue) => ({
            title: issue.title,
            description: issue.description,
          })),
        },
      ];
    });
  const groupedTaskIds = new Set(reopenedTasks.map((task) => task.taskId));
  for (const [taskId, issues] of scopedIssues.entries()) {
    if (groupedTaskIds.has(taskId)) {
      continue;
    }

    groupedIssues.push({
      heading: `Task \`${taskId}\` - ${taskTitles.get(taskId) ?? taskId}`,
      issues: issues.map((issue) => ({
        title: issue.title,
        description: issue.description,
      })),
    });
  }

  if (generalIssues.length > 0) {
    groupedIssues.push({
      heading: "General Issues",
      issues: generalIssues.map((issue) => ({
        title: issue.title,
        description: issue.description,
      })),
    });
  }

  return {
    summary: latestFailure.summary,
    reopenedTasks,
    groupedIssues,
  };
}

function buildTaskFailureMessages(input: {
  summary: string;
  issues: WorkflowValidatorIssue[];
  reopenTaskIds: string[];
}): Record<string, string> {
  const scopedIssuesByTaskId = new Map<string, WorkflowValidatorIssue[]>();
  for (const issue of input.issues) {
    if (!issue.taskId) {
      continue;
    }

    const issues = scopedIssuesByTaskId.get(issue.taskId) ?? [];
    issues.push(issue);
    scopedIssuesByTaskId.set(issue.taskId, issues);
  }

  return Object.fromEntries(
    input.reopenTaskIds.map((taskId) => {
      const scopedIssues = scopedIssuesByTaskId.get(taskId);
      if (!scopedIssues || scopedIssues.length === 0) {
        return [taskId, input.summary];
      }

      return [
        taskId,
        [
          input.summary,
          ...scopedIssues.map(
            (issue) => `- ${issue.title}: ${issue.description}`,
          ),
        ].join("\n"),
      ];
    }),
  );
}

const logger = createLogger("graph-workflow-iteration");

export function createGraphWorkflowIterationOrchestrator(
  deps: GraphWorkflowIterationOrchestratorDeps,
) {
  const validationService =
    deps.validationService ?? createGraphWorkflowValidationService();
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const signalHalt =
    deps.signalHalt ??
    (async () => {
      throw new Error(
        "signalHalt dependency is not configured on the iteration orchestrator",
      );
    });

  function getConsecutiveFailureThreshold(
    contextDef: GraphWorkflowResolvedContext | undefined,
  ): number {
    return (
      contextDef?.circuitBreaker.consecutiveFailureThreshold ??
      DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
    );
  }

  function emitStreamFrame(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void {
    (deps.emitStreamFrame ?? defaultEmitStreamFrame)(
      projectPath,
      sessionName,
      frame,
    );
  }

  async function requireExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }

    if (execution.status !== "running") {
      throw new Error(
        "Only running graph workflow executions can run iterations",
      );
    }

    return execution;
  }

  async function loadCurrentExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }
    return execution;
  }

  async function persistExecution(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    await deps.executionRepository.update(projectPath, sessionName, execution);
    return execution;
  }

  async function markTaskCompleted(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
    taskId: string;
    summary: string;
    conversationId: string;
    completedAt: string;
  }): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(input.execution);
    const taskState = nextExecution.taskStates[input.taskId];
    if (!taskState) {
      throw new Error(`Task "${input.taskId}" does not exist in runtime state`);
    }

    if (taskState.contextId !== input.contextId) {
      throw new Error(
        `Task "${input.taskId}" does not belong to context "${input.contextId}"`,
      );
    }

    if (taskState.status === "completed") {
      throw new Error(`Task "${input.taskId}" is already completed`);
    }

    const contextState = nextExecution.contextStates[taskState.contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${taskState.contextId}" does not exist in runtime state`,
      );
    }

    taskState.status = "completed";
    taskState.summary = input.summary;
    taskState.completedAt = input.completedAt;
    taskState.lastConversationId = input.conversationId;
    taskState.failureMessage = null;
    contextState.completedTaskCount = countCompletedTasks(
      nextExecution,
      taskState.contextId,
    );
    nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution, true);

    return persistExecution(
      input.projectPath,
      input.sessionName,
      nextExecution,
    );
  }

  async function resetContextFailureCount(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
  }): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(input.execution);
    const contextState = nextExecution.contextStates[input.contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    contextState.consecutiveFailureCount = 0;
    nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution, true);

    return persistExecution(
      input.projectPath,
      input.sessionName,
      nextExecution,
    );
  }

  async function reopenTasksAfterContextValidationFailure(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
    reopenTaskIds: string[];
    taskFailureMessages: Record<string, string>;
  }): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(input.execution);
    const failureTimestamp = getNow(deps);
    const execLogger = getExecutionLogger(input.execution.id);

    for (const taskId of input.reopenTaskIds) {
      const taskState = nextExecution.taskStates[taskId];
      if (!taskState) {
        throw new Error(`Task "${taskId}" does not exist in runtime state`);
      }

      if (taskState.contextId !== input.contextId) {
        throw new Error(
          `Task "${taskId}" does not belong to context "${input.contextId}"`,
        );
      }

      const failureMessage = input.taskFailureMessages[taskId];
      if (!failureMessage) {
        throw new Error(
          `Missing failure message for reopened task "${taskId}"`,
        );
      }

      taskState.status = "pending";
      taskState.summary = null;
      taskState.completedAt = null;
      taskState.failureMessage = failureMessage;
      taskState.failureHistory = [
        ...(taskState.failureHistory ?? []),
        {
          message: failureMessage,
          timestamp: failureTimestamp,
        },
      ];

      execLogger?.task(input.contextId, "task.reopened", {
        taskId,
        failureMessage,
      });
      logger.info("graph-workflow.task.reopened", {
        executionId: input.execution.id,
        contextId: input.contextId,
        taskId,
      });
    }

    const contextState = nextExecution.contextStates[input.contextId];
    if (contextState) {
      contextState.completedTaskCount = countCompletedTasks(
        nextExecution,
        input.contextId,
      );
      contextState.consecutiveFailureCount =
        (contextState.consecutiveFailureCount ?? 0) + 1;
    }

    nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution, true);

    return persistExecution(
      input.projectPath,
      input.sessionName,
      nextExecution,
    );
  }

  async function processContextCompletionValidation(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<void> {
    const { input, execLogger, onHalt } = params;
    const preContextValidationExecution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );

    if (preContextValidationExecution.status !== "running") {
      return;
    }

    const remainingTasks = getIncompleteTasks(
      preContextValidationExecution,
      input.contextId,
    );
    if (remainingTasks.length > 0) {
      return;
    }

    const validation = await validationService.validateContextCompletion({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: preContextValidationExecution,
      contextId: input.contextId,
    });

    const postValidationExecution = await requireExecution(
      input.projectPath,
      input.sessionName,
    );

    if (validation.kind === "infra_error") {
      execLogger?.validation(
        input.contextId,
        "context.validation_infra_error",
        {
          engine: validation.engine,
          reason: validation.reason,
          message: validation.message,
        },
      );
      logger.warn("graph-workflow.context_validation.infra_error", {
        executionId: preContextValidationExecution.id,
        contextId: input.contextId,
        engine: validation.engine,
        reason: validation.reason,
      });
      const infraErrorSummary = `Validator infra error (${validation.reason}): ${validation.message}`;
      const executionWithValidationEvent =
        eventPublisher.publishValidationResult({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: postValidationExecution,
          contextId: input.contextId,
          validatorType: "context",
          pass: false,
          summary: infraErrorSummary,
          issues: [],
          reopenTaskIds: [],
          sessionRef: null,
          reviewArtifact: null,
        });
      await persistExecution(
        input.projectPath,
        input.sessionName,
        executionWithValidationEvent,
      );
      const haltReason: GraphWorkflowHaltReason = {
        type: "validator_infra_error",
        contextId: input.contextId,
        engine: validation.engine,
        infraReason: validation.reason,
        message: validation.message,
        summary: null,
      };
      await onHalt(haltReason);
      throw new IterationHaltedError(haltReason);
    }

    if (validation.kind === "fail") {
      execLogger?.validation(input.contextId, "context.validation_reopened", {
        issueCount: validation.issues.length,
        reopenTaskIds: validation.reopenTaskIds,
      });
      logger.info("graph-workflow.context_validation.reopened", {
        executionId: preContextValidationExecution.id,
        contextId: input.contextId,
        reopenTaskIds: validation.reopenTaskIds,
      });

      const taskFailureMessages = buildTaskFailureMessages({
        summary: validation.summary,
        issues: validation.issues,
        reopenTaskIds: validation.reopenTaskIds,
      });

      const failedExecution = await reopenTasksAfterContextValidationFailure({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution: postValidationExecution,
        contextId: input.contextId,
        reopenTaskIds: validation.reopenTaskIds,
        taskFailureMessages,
      });

      const executionWithValidationEvent =
        eventPublisher.publishValidationResult({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: failedExecution,
          contextId: input.contextId,
          validatorType: "context",
          pass: false,
          summary: validation.summary,
          issues: validation.issues,
          reopenTaskIds: validation.reopenTaskIds,
          sessionRef: validation.sessionRef ?? null,
          reviewArtifact: validation.reviewArtifact ?? null,
        });
      await persistExecution(
        input.projectPath,
        input.sessionName,
        executionWithValidationEvent,
      );

      const contextDef =
        executionWithValidationEvent.workingDefinition.executionContexts.find(
          (entry) => entry.id === input.contextId,
        );
      const threshold = getConsecutiveFailureThreshold(contextDef);
      const failureCount =
        executionWithValidationEvent.contextStates[input.contextId]
          ?.consecutiveFailureCount ?? 0;
      if (failureCount >= threshold) {
        execLogger?.decision("circuit_breaker.tripped", {
          contextId: input.contextId,
          consecutiveFailureCount: failureCount,
          threshold,
        });
        const haltReason: GraphWorkflowHaltReason = {
          type: "circuit_breaker",
          contextId: input.contextId,
          condition: "retry_exhaustion",
          failureCount,
          summary: null,
        };
        await onHalt(haltReason);
        throw new IterationHaltedError(haltReason);
      }
      return;
    }

    execLogger?.validation(input.contextId, "context_validation.passed", {
      summary: validation.summary,
    });
    logger.info("graph-workflow.context_validation.completed", {
      executionId: preContextValidationExecution.id,
      contextId: input.contextId,
      kind: validation.kind,
    });

    const executionWithResetFailureCount = await resetContextFailureCount({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: postValidationExecution,
      contextId: input.contextId,
    });
    const executionWithValidationEvent = eventPublisher.publishValidationResult(
      {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        execution: executionWithResetFailureCount,
        contextId: input.contextId,
        validatorType: "context",
        pass: true,
        summary: validation.summary,
        issues: [],
        reopenTaskIds: [],
        sessionRef: validation.sessionRef ?? null,
        reviewArtifact: validation.reviewArtifact ?? null,
      },
    );
    await persistExecution(
      input.projectPath,
      input.sessionName,
      executionWithValidationEvent,
    );
  }

  async function finalizeIterationResult(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
  }): Promise<GraphWorkflowIterationResult> {
    const { input, execLogger, conversationId } = params;
    const currentExecution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );
    if (currentExecution.status !== "running") {
      execLogger?.iteration(input.contextId, "iteration.halted_mid_flight", {
        haltReason: currentExecution.haltReason,
      });
      logger.info("graph-workflow.iteration.halted_mid_flight", {
        executionId: currentExecution.id,
        contextId: input.contextId,
        haltReasonType: currentExecution.haltReason?.type,
      });
      return {
        conversationId,
        execution: currentExecution,
        shouldContinueInContext: false,
      };
    }
    const finalizedExecution = cloneExecution(currentExecution);
    const finalizedContextState =
      finalizedExecution.contextStates[input.contextId];
    if (!finalizedContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    finalizedContextState.completedTaskCount = countCompletedTasks(
      finalizedExecution,
      input.contextId,
    );

    const remainingTaskCount = countRemainingTasks(
      finalizedExecution,
      input.contextId,
    );
    const completedTaskCount = finalizedContextState.completedTaskCount;
    const shouldContinueInContext = remainingTaskCount > 0;

    execLogger?.iteration(input.contextId, "iteration.completed", {
      conversationId,
      iterationNumber: finalizedContextState.iterationCount,
      completedTaskCount,
      remainingTaskCount,
      shouldContinueInContext,
    });
    logger.info("graph-workflow.iteration.completed", {
      executionId: finalizedExecution.id,
      contextId: input.contextId,
      completedTaskCount,
      remainingTaskCount,
    });

    finalizedContextState.status = shouldContinueInContext
      ? "running"
      : "completed";
    finalizedExecution.activeContextId = shouldContinueInContext
      ? input.contextId
      : null;
    finalizedExecution.machineSnapshot = buildMachineSnapshot(
      finalizedExecution,
      false,
    );

    const persistedExecution = await persistExecution(
      input.projectPath,
      input.sessionName,
      finalizedExecution,
    );

    return {
      conversationId,
      execution: persistedExecution,
      shouldContinueInContext,
    };
  }

  function pickConversationIdForValidationOnlyIteration(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): string {
    const contextTasks = getContextTasks(execution, contextId);
    for (let index = contextTasks.length - 1; index >= 0; index -= 1) {
      const task = contextTasks[index];
      if (!task) {
        continue;
      }

      const taskState = execution.taskStates[task.id];
      if (taskState?.lastConversationId) {
        return taskState.lastConversationId;
      }
    }
    return "validation-only";
  }

  async function runValidationOnlyIteration(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    initialExecution: GraphWorkflowExecution;
  }): Promise<GraphWorkflowIterationResult> {
    const { input, execLogger, initialExecution } = params;

    execLogger?.iteration(input.contextId, "iteration.revalidate_started", {
      reason: "all_tasks_completed_at_entry",
      iterationNumber:
        initialExecution.contextStates[input.contextId]?.iterationCount ?? 0,
      completedTaskCount: countCompletedTasks(
        initialExecution,
        input.contextId,
      ),
    });
    logger.info("graph-workflow.iteration.revalidate_started", {
      executionId: initialExecution.id,
      contextId: input.contextId,
    });

    async function signalHaltOnly(
      reason: GraphWorkflowHaltReason,
    ): Promise<void> {
      try {
        await signalHalt({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          reason,
        });
      } catch (haltError) {
        execLogger?.iteration(input.contextId, "iteration.signal_halt_error", {
          error:
            haltError instanceof Error ? haltError.message : String(haltError),
        });
        throw haltError;
      }
    }

    try {
      await processContextCompletionValidation({
        input,
        execLogger,
        onHalt: signalHaltOnly,
      });
    } catch (error) {
      if (!(error instanceof IterationHaltedError)) {
        throw error;
      }
      execLogger?.iteration(
        input.contextId,
        "iteration.terminal_error_caught",
        {
          errorType: error.name,
          message: error.message,
        },
      );
    }

    const conversationId = pickConversationIdForValidationOnlyIteration(
      initialExecution,
      input.contextId,
    );
    return finalizeIterationResult({ input, execLogger, conversationId });
  }

  async function runIteration(
    input: GraphWorkflowIterationInput,
  ): Promise<GraphWorkflowIterationResult> {
    const initialExecution = await requireExecution(
      input.projectPath,
      input.sessionName,
    );
    const context = getContextDefinition(initialExecution, input.contextId);
    const execLogger = getExecutionLogger(initialExecution.id);
    const incompleteTasks = getIncompleteTasks(
      initialExecution,
      input.contextId,
    );

    // All tasks already complete on entry — the prior iteration finished its
    // implementer phase but could not record a pass/fail validation outcome
    // (e.g., the run halted with validator_infra_error). Re-run validation
    // without creating a new implementer conversation or tool server.
    if (incompleteTasks.length === 0) {
      return runValidationOnlyIteration({
        input,
        execLogger,
        initialExecution,
      });
    }

    const latestContextValidationFailure =
      buildLatestContextValidationFailureFeedback(
        initialExecution,
        input.contextId,
      );

    execLogger?.iteration(input.contextId, "iteration.started", {
      iterationNumber:
        (initialExecution.contextStates[input.contextId]?.iterationCount ?? 0) +
        1,
      incompleteTaskCount: incompleteTasks.length,
      incompleteTaskIds: incompleteTasks.map((t) => t.id),
      model: context.implementer.model,
      reasoningEffort: context.implementer.reasoningEffort,
    });
    logger.info("graph-workflow.iteration.started", {
      executionId: initialExecution.id,
      contextId: input.contextId,
      incompleteTaskCount: incompleteTasks.length,
    });

    // Resolve the implementer conversation — continuity service decides reuse vs fresh
    let conversationId: string;
    let executionWithLaneState: GraphWorkflowExecution;
    let promptMode: "iteration_seed" | "follow_up" = "iteration_seed";
    if (deps.continuityService) {
      const resolved = await deps.continuityService.resolveImplementerCall({
        execution: initialExecution,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        contextId: input.contextId,
        engine: context.implementer.backend,
      });
      conversationId = resolved.conversationId;
      executionWithLaneState = resolved.execution;
      promptMode = resolved.promptMode;
    } else {
      const conversation = await deps.createConversation(
        input.projectPath,
        input.sessionName,
        { role: "iteration" },
      );
      conversationId = conversation.id;
      executionWithLaneState = initialExecution;
    }

    execLogger?.iteration(input.contextId, "iteration.conversation_resolved", {
      conversationId,
      promptMode,
      sessionAction: deps.continuityService ? "continuity_managed" : "fresh",
    });

    const conversation = { id: conversationId };
    const seededExecution = cloneExecution(executionWithLaneState);
    const seededContextState = seededExecution.contextStates[input.contextId];
    if (!seededContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    seededExecution.activeContextId = input.contextId;
    seededExecution.completedAt = null;
    seededExecution.haltReason = null;
    seededContextState.status = "running";
    seededContextState.iterationCount += 1;
    bindConversationToIncompleteTasks(
      seededExecution,
      input.contextId,
      conversation.id,
      getNow(deps),
    );
    seededExecution.machineSnapshot = buildMachineSnapshot(
      seededExecution,
      true,
    );

    await persistExecution(
      input.projectPath,
      input.sessionName,
      seededExecution,
    );

    // Pre-declare toolServer so haltIteration can close it before toolServer is assigned below.
    // eslint-disable-next-line prefer-const
    let toolServer: GraphWorkflowIterationToolServer;

    async function haltIteration(
      reason: GraphWorkflowHaltReason,
    ): Promise<void> {
      try {
        await signalHalt({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          reason,
        });
      } catch (haltError) {
        execLogger?.iteration(input.contextId, "iteration.signal_halt_error", {
          error:
            haltError instanceof Error ? haltError.message : String(haltError),
        });
        throw haltError;
      }
      try {
        await toolServer?.close?.();
      } catch (closeError) {
        execLogger?.iteration(
          input.contextId,
          "iteration.tool_server_close_error",
          {
            error:
              closeError instanceof Error
                ? closeError.message
                : String(closeError),
          },
        );
      }
    }

    toolServer = deps.createToolServer({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
      executionId: seededExecution.id,
      conversationId: conversation.id,
      contextId: input.contextId,
      contextTitle: context.title,
      allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
      sharedDocuments: seededExecution.sharedDocuments,
      completeTask: async (taskId: string, summary: string) => {
        execLogger?.task(input.contextId, "task.completion_attempted", {
          taskId,
          summaryLength: summary.length,
          summaryPreview: summary.slice(0, 200),
        });
        const preValidationExecution = await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        );
        if (preValidationExecution.status !== "running") {
          execLogger?.task(input.contextId, "task.completion_short_circuit", {
            taskId,
            reason: "execution_already_halted",
            haltReasonType: preValidationExecution.haltReason?.type ?? null,
          });
          throw new IterationHaltedError(
            preValidationExecution.haltReason ?? {
              type: "recovery_error",
              message: "Execution is not running",
            },
          );
        }
        const taskStateBeforeValidation =
          preValidationExecution.taskStates[taskId];
        if (taskStateBeforeValidation?.status === "completed") {
          execLogger?.task(input.contextId, "task.completion_short_circuit", {
            taskId,
            reason: "already_completed",
            firstCompletedAt: taskStateBeforeValidation.completedAt,
          });
          logger.info("graph-workflow.task.completion_idempotent", {
            executionId: preValidationExecution.id,
            contextId: input.contextId,
            taskId,
          });
          return preValidationExecution;
        }
        const completedExecution = await markTaskCompleted({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: preValidationExecution,
          contextId: input.contextId,
          taskId,
          summary,
          conversationId: conversation.id,
          completedAt: getNow(deps),
        });
        execLogger?.task(input.contextId, "task.completed", {
          taskId,
          summaryLength: summary.length,
        });
        logger.info("graph-workflow.task.completed", {
          executionId: preValidationExecution.id,
          contextId: input.contextId,
          taskId,
        });
        return completedExecution;
      },
    });

    const MAX_FOLLOW_UPS = 2;

    try {
      emitStreamFrame(input.projectPath, input.sessionName, {
        type: "iteration-boundary",
        conversationId: conversation.id,
        contextId: input.contextId,
        status: "started",
      });

      const agentCallBase = {
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        executionId: seededExecution.id,
        conversationId: conversation.id,
        contextId: input.contextId,
        backend: context.implementer.backend,
        model: context.implementer.model,
        reasoningEffort: context.implementer.reasoningEffort,
        toolServer: toolServer.server,
        emitStreamFrame: (frame: GraphWorkflowStreamFrame) =>
          emitStreamFrame(input.projectPath, input.sessionName, frame),
      } as const;

      async function recordTurnOutcome(
        agentResult: GraphWorkflowAgentIterationResult,
      ): Promise<void> {
        if (!deps.continuityService) return;
        const current = await requireExecution(
          input.projectPath,
          input.sessionName,
        );
        const contextLimitTokens =
          context.iterationPolicy.continuity.contextLimitTokens;
        const updated =
          context.implementer.backend === "codex"
            ? deps.continuityService.recordCodexTurnOutcome({
                execution: current,
                lane: "implementer",
                usage: null,
                contextLimitTokens,
                newThreadId:
                  agentResult.sessionRef?.backend === "codex"
                    ? agentResult.sessionRef.threadId
                    : null,
              })
            : deps.continuityService.recordClaudeTurnOutcome({
                execution: current,
                lane: "implementer",
                contextTokens: agentResult.contextTokens,
                contextWindowMax: agentResult.contextWindowMax,
                contextLimitTokens,
              });
        await persistExecution(input.projectPath, input.sessionName, updated);
      }

      // Initial agent call — seed prompt for fresh sessions, follow-up for resumed sessions
      const initialTasks = getIncompleteTasks(seededExecution, input.contextId);
      const initialPrompt =
        promptMode === "follow_up"
          ? buildFollowUpPrompt({
              remainingTasks: initialTasks,
              taskStates: seededExecution.taskStates,
              attemptNumber: 1,
              maxAttempts: MAX_FOLLOW_UPS,
              latestContextValidationFailure,
            })
          : buildIterationPrompt({
              context,
              tasks: initialTasks,
              taskStates: seededExecution.taskStates,
              sharedDocuments: seededExecution.sharedDocuments,
              allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
              contextValidationAcceptanceCriteria:
                context.contextValidator !== null &&
                context.contextValidator.enabled
                  ? context.acceptanceCriteria
                  : undefined,
              latestContextValidationFailure,
            });

      // Log the prompt sent to the agent
      const iterationNum = seededContextState.iterationCount;
      execLogger?.writePrompt(
        input.contextId,
        promptMode === "follow_up"
          ? `iteration-${iterationNum}-followup-0.md`
          : `iteration-${iterationNum}.md`,
        initialPrompt,
      );
      execLogger?.iteration(input.contextId, "iteration.prompt_sent", {
        promptMode,
        promptLength: initialPrompt.length,
        model: context.implementer.model,
        reasoningEffort: context.implementer.reasoningEffort,
      });

      let agentResult = await deps.runAgentIteration({
        ...agentCallBase,
        prompt: initialPrompt,
      });
      await recordTurnOutcome(agentResult);

      execLogger?.iteration(input.contextId, "iteration.agent_turn_completed", {
        turnNumber: 0,
        contextTokens: agentResult.contextTokens,
        contextWindowMax: agentResult.contextWindowMax,
      });

      // Follow-up loop: re-message if there are still incomplete tasks
      for (let attempt = 1; attempt <= MAX_FOLLOW_UPS; attempt++) {
        const midExecution = await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        );

        if (midExecution.status !== "running") {
          execLogger?.iteration(
            input.contextId,
            "iteration.follow_up_skipped",
            {
              reason: "execution_halted",
              attempt,
              haltReasonType: midExecution.haltReason?.type ?? null,
            },
          );
          break;
        }

        const remaining = getIncompleteTasks(midExecution, input.contextId);
        if (remaining.length === 0) {
          execLogger?.iteration(
            input.contextId,
            "iteration.follow_up_skipped",
            {
              reason: "all_tasks_completed",
              attempt,
            },
          );
          break;
        }

        // Stop if the continuity service has scheduled a rotation due to context limit
        if (deps.continuityService) {
          const laneState = midExecution.laneStates["implementer"];
          if (laneState?.rotateBeforeNextTurn) {
            execLogger?.iteration(
              input.contextId,
              "iteration.follow_up_skipped",
              {
                reason: "context_rotation_scheduled",
                attempt,
                remainingTaskCount: remaining.length,
              },
            );
            execLogger?.decision("rotation.caused_follow_up_skip", {
              contextId: input.contextId,
              lane: "implementer",
              remainingTaskCount: remaining.length,
            });
            break;
          }
        }

        const followUpPrompt = buildFollowUpPrompt({
          remainingTasks: remaining,
          taskStates: midExecution.taskStates,
          attemptNumber: attempt,
          maxAttempts: MAX_FOLLOW_UPS,
          latestContextValidationFailure:
            buildLatestContextValidationFailureFeedback(
              midExecution,
              input.contextId,
            ),
        });
        execLogger?.writePrompt(
          input.contextId,
          `iteration-${iterationNum}-followup-${attempt}.md`,
          followUpPrompt,
        );
        execLogger?.iteration(input.contextId, "iteration.follow_up_sent", {
          attempt,
          maxAttempts: MAX_FOLLOW_UPS,
          remainingTaskIds: remaining.map((t) => t.id),
        });

        agentResult = await deps.runAgentIteration({
          ...agentCallBase,
          prompt: followUpPrompt,
        });
        await recordTurnOutcome(agentResult);

        execLogger?.iteration(
          input.contextId,
          "iteration.agent_turn_completed",
          {
            turnNumber: attempt,
            contextTokens: agentResult.contextTokens,
            contextWindowMax: agentResult.contextWindowMax,
          },
        );
      }

      await processContextCompletionValidation({
        input,
        execLogger,
        onHalt: haltIteration,
      });

      emitStreamFrame(input.projectPath, input.sessionName, {
        type: "iteration-boundary",
        conversationId: conversation.id,
        contextId: input.contextId,
        status: "completed",
      });
    } catch (error) {
      if (!(error instanceof IterationHaltedError)) {
        throw error;
      }
      execLogger?.iteration(
        input.contextId,
        "iteration.terminal_error_caught",
        {
          errorType: error.name,
          message: error.message,
        },
      );
    } finally {
      await toolServer.close?.();
    }

    return finalizeIterationResult({
      input,
      execLogger,
      conversationId: conversation.id,
    });
  }

  return { runIteration };
}
