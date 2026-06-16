import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowCollaborationContinuation,
  GraphWorkflowExecution,
  GraphWorkflowResolvedContext,
  GraphWorkflowHaltReason,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationResultEvent,
  WorkflowValidatorIssue,
} from "@/lib/workflows/schemas";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import { IterationFailureWithProgressError } from "./iteration-failure-with-progress";
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
  createApprovalGateService,
  type ApprovalGateService,
} from "@/lib/workflow-graph/approval-gate";
import type { ScriptValidatorOutcome } from "@/lib/workflow-graph/script-validator-runner";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { ToolResultBlock } from "./tool-dispatcher";
import {
  runCircuitBreakerGate as defaultRunCircuitBreakerGate,
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";
import type { GraphWorkflowLifecycleSnapshot } from "./workflow-manager";

interface GraphWorkflowIterationExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution | Promise<GraphWorkflowExecution>,
  ): Promise<GraphWorkflowExecution>;
}

interface GraphWorkflowIterationConversation {
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
  /**
   * Resolved per-context execution target. When the context is isolated in a
   * sub-worktree (parallel batch), this carries the sub-worktree path and
   * branch; otherwise it carries the session worktree/branch.
   */
  executionTarget?: ExecutionTarget;
}

export interface GraphWorkflowAgentIterationResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  sessionRef?: AgentSessionRef | null;
  /**
   * Summary of the bounded background-task wait the implementer turn performed
   * inside this single `runAgentIteration` call. Present only when a wait
   * actually occurred. The orchestrator reads it for lifecycle logging
   * (Req 7.1–7.3); it never changes control flow, so iteration / failure
   * accounting is preserved (Req 5.1–5.3).
   */
  backgroundWait?: BackgroundWaitSummary;
}

interface IterationOrchestratorContinuityService {
  resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall>;
  recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): Promise<GraphWorkflowExecution>;
  recordCodexTurnOutcome(
    input: RecordCodexLaneTurnInput,
  ): Promise<GraphWorkflowExecution>;
}

export interface IterationOrchestratorScriptValidatorInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  /**
   * Resolved per-context execution target. When provided, the script validator
   * runs against this target's worktree/branch instead of the session's.
   */
  executionTarget?: ExecutionTarget;
}

interface IterationOrchestratorScriptValidatorService {
  runScriptValidator(
    input: IterationOrchestratorScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome>;
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
  scriptValidatorService?: IterationOrchestratorScriptValidatorService;
  approvalGateService?: ApprovalGateService;
  createTaskId?(): string;
  now?(): string;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
  /**
   * Optional override for the shared circuit-breaker gate primitive.
   * Production routes both the script-validator failure path and the context-
   * validator failure path through `runCircuitBreakerGate` so the
   * "give up after N consecutive failures" decision uses the workflow
   * primitive layer's gate vocabulary instead of duplicated inline checks.
   */
  runCircuitBreakerGate?: (
    input: RunCircuitBreakerGateInput,
  ) => CircuitBreakerGateResult;
  /**
   * Optional hook that copies the execution's charter + shared documents into a
   * lane worktree before the agent runs. Invoked only for worktree-isolation
   * lanes (which fork from the committed session branch and therefore lack any
   * uncommitted alignment docs). Best-effort: a failure warns and continues,
   * since the charter digest is also inlined into the prompt.
   */
  materializeWorkflowDocuments?(input: {
    execution: GraphWorkflowExecution;
    worktreePath: string;
  }): Promise<void>;
}

export interface GraphWorkflowIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
  /**
   * Resolved per-context execution target supplied by the loop's
   * ExecutionTargetResolver. When omitted (e.g., legacy callers), the
   * orchestrator threads `undefined` through and the implementer runner falls
   * back to the session worktree/branch.
   */
  executionTarget?: ExecutionTarget;
}

export interface GraphWorkflowIterationResult {
  conversationId: string;
  execution: GraphWorkflowExecution;
  shouldContinueInContext: boolean;
}

export class IterationHaltedError extends Error {
  readonly haltReason: GraphWorkflowHaltReason;
  readonly syntheticToolResults?: readonly ToolResultBlock[];

  constructor(
    haltReason: GraphWorkflowHaltReason,
    syntheticToolResults?: readonly ToolResultBlock[],
  ) {
    super(`Iteration halted: ${haltReason.type}`);
    this.name = "IterationHaltedError";
    this.haltReason = haltReason;
    if (syntheticToolResults && syntheticToolResults.length > 0) {
      this.syntheticToolResults = syntheticToolResults;
    }
  }
}

interface GraphWorkflowSignalHaltInput {
  projectPath: string;
  sessionName: string;
  contextId?: string;
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

function getUndeliveredCollaborationContinuations(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowCollaborationContinuation[] {
  return (execution.collaborationContinuations?.[contextId] ?? []).filter(
    (continuation) => continuation.deliveredAt === null,
  );
}

function buildMachineSnapshot(
  execution: GraphWorkflowExecution,
  hasLiveIteration: boolean,
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus: execution.status,
    activeContextId: execution.activeContextIds[0] ?? null,
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

/**
 * Emit the structured wait-lifecycle log entries (Req 7.1–7.3) for a single
 * agent turn that performed a bounded background-task wait. No-op when the
 * turn did not wait (`backgroundWait` absent). Logging only — never changes
 * iteration control flow.
 */
function logBackgroundWaitLifecycle(params: {
  execLogger: ReturnType<typeof getExecutionLogger>;
  executionId: string;
  contextId: string;
  turnNumber: number;
  backgroundWait: BackgroundWaitSummary | undefined;
}): void {
  const { execLogger, executionId, contextId, turnNumber, backgroundWait } =
    params;
  if (!backgroundWait) {
    return;
  }

  const { waitedTaskIds, settledTaskIds, timedOut, durationMs } =
    backgroundWait;

  // 7.1 — record the begin-wait entry identifying the context + waited tasks.
  execLogger?.iteration(contextId, "iteration.background_wait_started", {
    turnNumber,
    waitedTaskIds,
  });
  logger.info("graph-workflow.iteration.background_wait_started", {
    executionId,
    contextId,
    turnNumber,
    waitedTaskCount: waitedTaskIds.length,
  });

  if (timedOut) {
    // 7.3 — record the timeout entry with the tasks still in-flight.
    const settled = new Set(settledTaskIds);
    const stillInFlightTaskIds = waitedTaskIds.filter(
      (taskId) => !settled.has(taskId),
    );
    execLogger?.iteration(contextId, "iteration.background_wait_timed_out", {
      turnNumber,
      stillInFlightTaskIds,
      durationMs,
    });
    logger.warn("graph-workflow.iteration.background_wait_timed_out", {
      executionId,
      contextId,
      turnNumber,
      stillInFlightTaskCount: stillInFlightTaskIds.length,
      durationMs,
    });
    return;
  }

  // 7.2 — record the resolve entry with the settled outcome.
  execLogger?.iteration(contextId, "iteration.background_wait_resolved", {
    turnNumber,
    settledTaskIds,
    durationMs,
  });
  logger.info("graph-workflow.iteration.background_wait_resolved", {
    executionId,
    contextId,
    turnNumber,
    settledTaskCount: settledTaskIds.length,
    durationMs,
  });
}

export function createGraphWorkflowIterationOrchestrator(
  deps: GraphWorkflowIterationOrchestratorDeps,
) {
  const validationService =
    deps.validationService ?? createGraphWorkflowValidationService();
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const approvalGateService =
    deps.approvalGateService ??
    createApprovalGateService({
      mutateActive: (projectPath, sessionName, fn) =>
        deps.executionRepository.mutateActive(projectPath, sessionName, fn),
      now: () => getNow(deps),
    });
  const signalHalt =
    deps.signalHalt ??
    (async () => {
      throw new Error(
        "signalHalt dependency is not configured on the iteration orchestrator",
      );
    });
  const createTaskId = deps.createTaskId ?? (() => `task-${randomUUID()}`);
  const runCircuitBreakerGate =
    deps.runCircuitBreakerGate ?? defaultRunCircuitBreakerGate;

  function getConsecutiveFailureThreshold(
    contextDef: GraphWorkflowResolvedContext | undefined,
  ): number {
    return (
      contextDef?.circuitBreaker.consecutiveFailureThreshold ??
      DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD
    );
  }

  function shouldTripCircuitBreaker(
    failureCount: number,
    threshold: number,
  ): boolean {
    return runCircuitBreakerGate({ failureCount, threshold }).status === "fail";
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

  async function markTaskCompleted(input: {
    projectPath: string;
    sessionName: string;
    contextId: string;
    taskId: string;
    summary: string;
    conversationId: string;
    completedAt: string;
  }): Promise<GraphWorkflowExecution> {
    return deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const nextExecution = cloneExecution(latest);
        const taskState = nextExecution.taskStates[input.taskId];
        if (!taskState) {
          throw new Error(
            `Task "${input.taskId}" does not exist in runtime state`,
          );
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
        nextExecution.machineSnapshot = buildMachineSnapshot(
          nextExecution,
          true,
        );
        return nextExecution;
      },
    );
  }

  async function reopenTasksAfterContextValidationFailure(input: {
    projectPath: string;
    sessionName: string;
    contextId: string;
    reopenTaskIds: string[];
    taskFailureMessages: Record<string, string>;
    publishValidationEvent?: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowExecution;
  }): Promise<GraphWorkflowExecution> {
    return deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const nextExecution = cloneExecution(latest);
        const failureTimestamp = getNow(deps);
        const execLogger = getExecutionLogger(nextExecution.id);

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
            executionId: nextExecution.id,
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

        nextExecution.machineSnapshot = buildMachineSnapshot(
          nextExecution,
          true,
        );

        return input.publishValidationEvent
          ? input.publishValidationEvent(nextExecution)
          : nextExecution;
      },
    );
  }

  function buildScriptValidatorRemediationTaskInstructions(
    logRelativePath: string,
    summary: string,
  ): string {
    return [
      "Pre-merge validation failed. The script validator runs the project's `preMergeCommand` to catch deterministic problems (tests, type errors, lint, build, etc.).",
      "",
      `Summary: ${summary}`,
      "",
      `Read the full output at \`${logRelativePath}\` (relative to the worktree root) and address the issues.`,
      "",
      "When you believe the issues are resolved, mark this task complete. The pre-merge script will run again to confirm.",
    ].join("\n");
  }

  async function applyScriptValidatorFailure(input: {
    projectPath: string;
    sessionName: string;
    contextId: string;
    outcome: Extract<ScriptValidatorOutcome, { kind: "fail" }>;
  }): Promise<GraphWorkflowExecution> {
    const taskId = createTaskId();
    const failureTimestamp = getNow(deps);
    return deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const nextExecution = cloneExecution(latest);
        const contextTasks = nextExecution.workingDefinition.tasks.filter(
          (task) => task.contextId === input.contextId,
        );
        const maxOrder = contextTasks.reduce(
          (currentMax, task) => Math.max(currentMax, task.order),
          0,
        );
        const order = maxOrder + 1;

        const instructions = buildScriptValidatorRemediationTaskInstructions(
          input.outcome.logRelativePath,
          input.outcome.summary,
        );
        const title = `Fix pre-merge validation errors (${input.outcome.logRelativePath})`;

        nextExecution.workingDefinition.tasks.push({
          id: taskId,
          contextId: input.contextId,
          order,
          title,
          instructions,
          source: "user",
          metadata: {
            origin: "script_validator",
            logRelativePath: input.outcome.logRelativePath,
          },
        });
        nextExecution.taskStates[taskId] = {
          taskId,
          contextId: input.contextId,
          order,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: input.outcome.summary,
          failureHistory: [
            {
              message: input.outcome.summary,
              timestamp: failureTimestamp,
            },
          ],
        };

        const contextState = nextExecution.contextStates[input.contextId];
        if (contextState) {
          contextState.totalTaskCount =
            nextExecution.workingDefinition.tasks.filter(
              (task) => task.contextId === input.contextId,
            ).length;
          contextState.consecutiveFailureCount =
            (contextState.consecutiveFailureCount ?? 0) + 1;
        }

        nextExecution.machineSnapshot = buildMachineSnapshot(
          nextExecution,
          true,
        );
        return nextExecution;
      },
    );
  }

  async function processScriptValidation(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    execution: GraphWorkflowExecution;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<"pass" | "skip" | "fail"> {
    const { input, execLogger, execution, onHalt } = params;
    const contextDef = getContextDefinition(execution, input.contextId);
    if (!contextDef.scriptValidator.enabled) {
      return "skip";
    }

    if (!deps.scriptValidatorService) {
      throw new Error(
        "Script validator is enabled for this context but no scriptValidatorService is configured",
      );
    }

    execLogger?.validation(input.contextId, "script_validation.started", {});
    logger.info("graph-workflow.script_validation.started", {
      executionId: execution.id,
      contextId: input.contextId,
    });

    const outcome = await deps.scriptValidatorService.runScriptValidator({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution,
      contextId: input.contextId,
      executionTarget: input.executionTarget,
    });

    if (outcome.kind === "pass") {
      execLogger?.validation(input.contextId, "script_validation.passed", {});
      logger.info("graph-workflow.script_validation.passed", {
        executionId: execution.id,
        contextId: input.contextId,
      });
      return "pass";
    }

    if (outcome.kind === "infra_error") {
      if (outcome.reason === "missing_pre_merge_command") {
        execLogger?.validation(
          input.contextId,
          "script_validation.missing_pre_merge_command",
          { message: outcome.message },
        );
        logger.warn(
          "graph-workflow.script_validation.missing_pre_merge_command",
          {
            executionId: execution.id,
            contextId: input.contextId,
          },
        );
        const haltReason: GraphWorkflowHaltReason = {
          type: "script_validator_missing_command",
          contextId: input.contextId,
          message: outcome.message,
        };
        await onHalt(haltReason);
        throw new IterationHaltedError(haltReason);
      }

      execLogger?.validation(input.contextId, "script_validation.exception", {
        message: outcome.message,
      });
      logger.warn("graph-workflow.script_validation.exception", {
        executionId: execution.id,
        contextId: input.contextId,
        message: outcome.message,
      });
      const recoveryReason: GraphWorkflowHaltReason = {
        type: "recovery_error",
        message: `Script validator error: ${outcome.message}`,
      };
      await onHalt(recoveryReason);
      throw new IterationHaltedError(recoveryReason);
    }

    execLogger?.validation(input.contextId, "script_validation.failed", {
      summary: outcome.summary,
      logRelativePath: outcome.logRelativePath,
      timedOut: outcome.timedOut,
    });
    logger.info("graph-workflow.script_validation.failed", {
      executionId: execution.id,
      contextId: input.contextId,
      logRelativePath: outcome.logRelativePath,
    });

    const failedExecution = await applyScriptValidatorFailure({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      contextId: input.contextId,
      outcome,
    });

    const threshold = getConsecutiveFailureThreshold(contextDef);
    const failureCount =
      failedExecution.contextStates[input.contextId]?.consecutiveFailureCount ??
      0;
    if (shouldTripCircuitBreaker(failureCount, threshold)) {
      execLogger?.decision("circuit_breaker.tripped", {
        contextId: input.contextId,
        consecutiveFailureCount: failureCount,
        threshold,
        source: "script_validator",
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

    return "fail";
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

    const scriptStageResult = await processScriptValidation({
      input,
      execLogger,
      execution: preContextValidationExecution,
      onHalt,
    });

    if (scriptStageResult === "fail") {
      return;
    }

    const executionForAgentValidation = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );

    if (executionForAgentValidation.status !== "running") {
      return;
    }

    const validation = await validationService.validateContextCompletion({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: executionForAgentValidation,
      contextId: input.contextId,
      executionTarget: input.executionTarget,
    });

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
      await deps.executionRepository.mutateActive(
        input.projectPath,
        input.sessionName,
        (latest) =>
          eventPublisher.publishValidationResult({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: latest,
            contextId: input.contextId,
            validatorType: "context",
            pass: false,
            summary: infraErrorSummary,
            issues: [],
            reopenTaskIds: [],
            sessionRef: null,
            reviewArtifact: null,
          }),
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

      const executionWithValidationEvent =
        await reopenTasksAfterContextValidationFailure({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          contextId: input.contextId,
          reopenTaskIds: validation.reopenTaskIds,
          taskFailureMessages,
          publishValidationEvent: (reopened) =>
            eventPublisher.publishValidationResult({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: reopened,
              contextId: input.contextId,
              validatorType: "context",
              pass: false,
              summary: validation.summary,
              issues: validation.issues,
              reopenTaskIds: validation.reopenTaskIds,
              sessionRef: validation.sessionRef ?? null,
              reviewArtifact: validation.reviewArtifact ?? null,
            }),
        });

      const contextDef =
        executionWithValidationEvent.workingDefinition.executionContexts.find(
          (entry) => entry.id === input.contextId,
        );
      const threshold = getConsecutiveFailureThreshold(contextDef);
      const failureCount =
        executionWithValidationEvent.contextStates[input.contextId]
          ?.consecutiveFailureCount ?? 0;
      if (shouldTripCircuitBreaker(failureCount, threshold)) {
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

    await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const reset = cloneExecution(latest);
        const contextState = reset.contextStates[input.contextId];
        if (!contextState) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }
        contextState.consecutiveFailureCount = 0;
        reset.machineSnapshot = buildMachineSnapshot(reset, true);
        return eventPublisher.publishValidationResult({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: reset,
          contextId: input.contextId,
          validatorType: "context",
          pass: true,
          summary: validation.summary,
          issues: [],
          reopenTaskIds: [],
          sessionRef: validation.sessionRef ?? null,
          reviewArtifact: validation.reviewArtifact ?? null,
        });
      },
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

    let completedTaskCount = 0;
    let remainingTaskCount = 0;
    let shouldContinueInContext = false;
    let iterationNumber = 0;
    let approvalRequestedAt: string | null = null;

    const persistedExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const finalizedExecution = cloneExecution(latest);
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

        remainingTaskCount = countRemainingTasks(
          finalizedExecution,
          input.contextId,
        );
        completedTaskCount = finalizedContextState.completedTaskCount;
        shouldContinueInContext = remainingTaskCount > 0;
        iterationNumber = finalizedContextState.iterationCount;

        // A context only reaches the no-remaining-tasks branch after every
        // enabled validator passed (failures reopen tasks), so the gate
        // decision reduces to the resolved per-context config.
        const gateEnabled =
          finalizedExecution.workingDefinition.executionContexts.find(
            (entry) => entry.id === input.contextId,
          )?.humanApprovalGate.enabled ?? false;

        if (shouldContinueInContext) {
          finalizedContextState.status = "running";
        } else if (gateEnabled) {
          approvalGateService.enterAwaitingApproval(finalizedExecution, {
            contextId: input.contextId,
            conversationId,
          });
          approvalRequestedAt =
            finalizedContextState.pendingApproval?.requestedAt ?? null;
        } else {
          finalizedContextState.status = "completed";
        }
        finalizedExecution.activeContextIds = shouldContinueInContext
          ? finalizedExecution.activeContextIds.includes(input.contextId)
            ? finalizedExecution.activeContextIds
            : [...finalizedExecution.activeContextIds, input.contextId]
          : finalizedExecution.activeContextIds.filter(
              (contextId) => contextId !== input.contextId,
            );
        finalizedExecution.machineSnapshot = buildMachineSnapshot(
          finalizedExecution,
          false,
        );
        return finalizedExecution;
      },
    );

    execLogger?.iteration(input.contextId, "iteration.completed", {
      conversationId,
      iterationNumber,
      completedTaskCount,
      remainingTaskCount,
      shouldContinueInContext,
    });
    logger.info("graph-workflow.iteration.completed", {
      executionId: persistedExecution.id,
      contextId: input.contextId,
      completedTaskCount,
      remainingTaskCount,
    });

    if (approvalRequestedAt !== null) {
      const requestedAt: string = approvalRequestedAt;
      // The parking mutation has committed; this follow-up mutation only
      // persists the approval-pending history entry that the publisher
      // appends alongside its SSE broadcast and push dispatch.
      const executionWithApprovalEvent =
        await deps.executionRepository.mutateActive(
          input.projectPath,
          input.sessionName,
          (latest) =>
            eventPublisher.publishApprovalPending({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: latest,
              contextId: input.contextId,
              conversationId,
              requestedAt,
            }),
        );
      return {
        conversationId,
        execution: executionWithApprovalEvent,
        shouldContinueInContext,
      };
    }

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
          contextId: input.contextId,
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

    // Lane worktrees fork from the committed session branch, so charter +
    // shared documents (often uncommitted) are absent until materialized.
    // Session-lane contexts run in the session worktree where these files
    // already live, so they are skipped to avoid dirtying it.
    if (
      input.executionTarget?.isolation === "worktree" &&
      deps.materializeWorkflowDocuments
    ) {
      try {
        await deps.materializeWorkflowDocuments({
          execution: initialExecution,
          worktreePath: input.executionTarget.worktreePath,
        });
      } catch (err) {
        logger.warn("graph-workflow.iteration.materialize_failed", {
          executionId: initialExecution.id,
          contextId: input.contextId,
          worktreePath: input.executionTarget.worktreePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
    let resolvedImplementerLaneState:
      | GraphWorkflowExecution["laneStates"][string][string]
      | null = null;
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
      resolvedImplementerLaneState =
        resolved.execution.laneStates[input.contextId]?.["implementer"] ?? null;
      promptMode = resolved.promptMode;
    } else {
      const conversation = await deps.createConversation(
        input.projectPath,
        input.sessionName,
        { role: "iteration" },
      );
      conversationId = conversation.id;
    }

    execLogger?.iteration(input.contextId, "iteration.conversation_resolved", {
      conversationId,
      promptMode,
      sessionAction: deps.continuityService ? "continuity_managed" : "fresh",
    });

    const conversation = { id: conversationId };
    const seededExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const seededContextState = next.contextStates[input.contextId];
        if (!seededContextState) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }

        if (resolvedImplementerLaneState) {
          next.laneStates[input.contextId] = {
            ...next.laneStates[input.contextId],
            implementer: resolvedImplementerLaneState,
          };
        }
        if (!next.activeContextIds.includes(input.contextId)) {
          next.activeContextIds = [...next.activeContextIds, input.contextId];
        }
        next.completedAt = null;
        next.haltReason = null;
        seededContextState.status = "running";
        seededContextState.iterationCount += 1;
        bindConversationToIncompleteTasks(
          next,
          input.contextId,
          conversation.id,
          getNow(deps),
        );
        next.machineSnapshot = buildMachineSnapshot(next, true);
        return next;
      },
    );
    const seededContextState = seededExecution.contextStates[input.contextId];
    if (!seededContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }
    const collaborationContinuations = getUndeliveredCollaborationContinuations(
      seededExecution,
      input.contextId,
    );
    const collaborationContinuationWorkflowIds = collaborationContinuations.map(
      (continuation) => continuation.workflowId,
    );

    async function markCollaborationContinuationsDelivered(): Promise<void> {
      if (collaborationContinuationWorkflowIds.length === 0) {
        return;
      }
      const deliveredAt = getNow(deps);
      await deps.executionRepository.mutateActive(
        input.projectPath,
        input.sessionName,
        (latest) => {
          const next = cloneExecution(latest);
          const continuations =
            next.collaborationContinuations?.[input.contextId] ?? [];
          next.collaborationContinuations ??= {};
          const workflowIdSet = new Set(collaborationContinuationWorkflowIds);
          next.collaborationContinuations[input.contextId] = continuations.map(
            (continuation) =>
              workflowIdSet.has(continuation.workflowId) &&
              continuation.deliveredAt === null
                ? { ...continuation, deliveredAt }
                : continuation,
          );
          return next;
        },
      );
      execLogger?.iteration(input.contextId, "collaboration.delivered", {
        workflowIds: collaborationContinuationWorkflowIds,
      });
      logger.info("graph-workflow.collaboration.delivered", {
        executionId: seededExecution.id,
        contextId: input.contextId,
        workflowIds: collaborationContinuationWorkflowIds,
      });
    }

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
          contextId: input.contextId,
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
    let completedTurnCount = 0;

    try {
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
        executionTarget: input.executionTarget,
      } as const;

      async function recordTurnOutcome(
        agentResult: GraphWorkflowAgentIterationResult,
      ): Promise<void> {
        const continuityService = deps.continuityService;
        if (!continuityService) return;
        const contextLimitTokens =
          context.iterationPolicy.continuity.contextLimitTokens;
        await deps.executionRepository.mutateActive(
          input.projectPath,
          input.sessionName,
          async (latest) => {
            if (latest.status !== "running") {
              return latest;
            }
            return context.implementer.backend === "codex"
              ? await continuityService.recordCodexTurnOutcome({
                  execution: latest,
                  contextId: input.contextId,
                  lane: "implementer",
                  usage: null,
                  contextLimitTokens,
                  newThreadId:
                    agentResult.sessionRef?.backend === "codex"
                      ? agentResult.sessionRef.threadId
                      : null,
                })
              : await continuityService.recordClaudeTurnOutcome({
                  execution: latest,
                  contextId: input.contextId,
                  lane: "implementer",
                  contextTokens: agentResult.contextTokens,
                  contextWindowMax: agentResult.contextWindowMax,
                  contextLimitTokens,
                });
          },
        );
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
              collaborationContinuations,
              charter: context.charter,
            })
          : buildIterationPrompt({
              context,
              tasks: initialTasks,
              taskStates: seededExecution.taskStates,
              sharedDocuments: seededExecution.sharedDocuments,
              allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
              charter: context.charter,
              // Mirrors the request_collaboration registration gate in the
              // workflow-execution MCP server, which exposes the tool to every
              // implementer context. Keep these in lockstep if an enable toggle
              // is ever introduced.
              allowAgentCollaboration: true,
              contextValidationAcceptanceCriteria:
                context.contextValidator !== null &&
                context.contextValidator.enabled
                  ? context.acceptanceCriteria
                  : undefined,
              latestContextValidationFailure,
              collaborationContinuations,
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

      // Same-Turn Tool Dispatch Contract (design §Same-Turn Tool Dispatch
      // Contract, R5.3, R5.4). This helper is the orchestrator-level
      // enforcement that pairs with the production per-handler wrapper
      // `wrapMcpHandlerWithHaltCheck` (tool-dispatcher.ts) registered in
      // `tool-server.ts`. The contract is two-part:
      //
      //   1. Within a turn the MCP transport serializes sibling tool_use
      //      blocks one request at a time. Each wrapped handler checks
      //      `pendingHaltReason` and pending collaboration state BEFORE doing
      //      real work. A pending halt returns the canonical
      //      `"iteration halted: <type>"` message; a pending collaboration
      //      returns a non-terminal tool error so sibling tool calls in the
      //      same turn cannot mutate workflow state while the collaboration
      //      is running.
      //
      //   2. After every agent turn the orchestrator inspects
      //      `pendingHaltReason` and, if set, terminates the iteration with
      //      `IterationHaltedError`. This guarantees R5.3 ("no further tool
      //      calls in the iteration") at the iteration boundary regardless of
      //      whether the agent intended a follow-up turn.
      async function checkPendingHaltOrThrow(
        turnLabel: "initial_turn" | "follow_up_turn",
        attempt: number,
      ): Promise<void> {
        const latest = await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        );
        if (!latest.pendingHaltReason) {
          return;
        }
        execLogger?.iteration(
          input.contextId,
          "iteration.pending_halt_detected",
          {
            haltReasonType: latest.pendingHaltReason.type,
            turnLabel,
            attempt,
          },
        );
        await haltIteration(latest.pendingHaltReason);
        throw new IterationHaltedError(latest.pendingHaltReason);
      }

      async function hasPendingCollaboration(
        turnLabel: "initial_turn" | "follow_up_turn",
        attempt: number,
      ): Promise<boolean> {
        const latest = await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        );
        const pending = latest.pendingCollaborations?.[input.contextId];
        if (!pending) {
          return false;
        }
        execLogger?.iteration(
          input.contextId,
          "iteration.collaboration_pending",
          {
            workflowId: pending.workflowId,
            turnLabel,
            attempt,
          },
        );
        logger.info("graph-workflow.iteration.collaboration_pending", {
          executionId: latest.id,
          contextId: input.contextId,
          workflowId: pending.workflowId,
          turnLabel,
          attempt,
        });
        return true;
      }

      let stoppedForCollaboration = false;

      let agentResult = await deps.runAgentIteration({
        ...agentCallBase,
        prompt: initialPrompt,
      });
      await markCollaborationContinuationsDelivered();
      await recordTurnOutcome(agentResult);
      completedTurnCount += 1;

      execLogger?.iteration(input.contextId, "iteration.agent_turn_completed", {
        turnNumber: 0,
        contextTokens: agentResult.contextTokens,
        contextWindowMax: agentResult.contextWindowMax,
      });

      logBackgroundWaitLifecycle({
        execLogger,
        executionId: seededExecution.id,
        contextId: input.contextId,
        turnNumber: 0,
        backgroundWait: agentResult.backgroundWait,
      });

      // Post-turn enforcement of the Same-Turn Tool Dispatch Contract
      // (part 2 above). Fires immediately after the initial agent turn so the
      // orchestrator halts even when the agent does not request a follow-up.
      await checkPendingHaltOrThrow("initial_turn", 0);
      stoppedForCollaboration = await hasPendingCollaboration(
        "initial_turn",
        0,
      );

      // Follow-up loop: re-message if there are still incomplete tasks
      for (
        let attempt = 1;
        !stoppedForCollaboration && attempt <= MAX_FOLLOW_UPS;
        attempt++
      ) {
        // Pre-dispatch halt check before sending the next follow-up turn.
        // Pairs with `checkPendingHaltOrThrow` above for full R5.3 coverage.
        await checkPendingHaltOrThrow("follow_up_turn", attempt);
        stoppedForCollaboration = await hasPendingCollaboration(
          "follow_up_turn",
          attempt,
        );
        if (stoppedForCollaboration) {
          break;
        }

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
          const laneState =
            midExecution.laneStates[input.contextId]?.["implementer"];
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
          collaborationContinuations: [],
          charter: context.charter,
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
        completedTurnCount += 1;

        execLogger?.iteration(
          input.contextId,
          "iteration.agent_turn_completed",
          {
            turnNumber: attempt,
            contextTokens: agentResult.contextTokens,
            contextWindowMax: agentResult.contextWindowMax,
          },
        );

        logBackgroundWaitLifecycle({
          execLogger,
          executionId: seededExecution.id,
          contextId: input.contextId,
          turnNumber: attempt,
          backgroundWait: agentResult.backgroundWait,
        });

        await checkPendingHaltOrThrow("follow_up_turn", attempt);
        stoppedForCollaboration = await hasPendingCollaboration(
          "follow_up_turn",
          attempt,
        );
      }

      if (!stoppedForCollaboration) {
        await processContextCompletionValidation({
          input,
          execLogger,
          onHalt: haltIteration,
        });
      }
    } catch (error) {
      if (!(error instanceof IterationHaltedError)) {
        if (completedTurnCount > 0) {
          throw new IterationFailureWithProgressError(
            error,
            completedTurnCount,
          );
        }
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
