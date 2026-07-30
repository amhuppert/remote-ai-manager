import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { assertLoopFence } from "./loop-fence";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import { refValueForBackend } from "@/lib/agent-backends/continuity";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowAgentSessionStateSchema,
  type GraphWorkflowExecution,
  type GraphWorkflowHaltReason,
  type GraphWorkflowTaskValidationFailure,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowCollaborationContinuation } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowResolvedContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";
import { DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from "./constants";
import type { ConversationTelemetrySummary } from "./conversation-telemetry";
import { IterationFailureWithProgressError } from "./iteration-failure-with-progress";
import type {
  ResolveImplementerCallInput,
  ResolvedImplementerCall,
  RecordLaneTurnOutcomeInput,
} from "./lane-continuity";
import type { LaneOutcome } from "@/lib/workflows/primitives/lane-service";
import {
  buildIterationPrompt,
  buildFollowUpPrompt,
  type LatestContextValidationFailureFeedback,
} from "./iteration-prompt";
import {
  createGraphWorkflowValidationService,
  type GraphWorkflowValidationService,
} from "@/lib/workflow-graph/execution-validation";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
} from "@/lib/workflow-graph/execution-events";
import {
  createApprovalGateService,
  type ApprovalGateService,
} from "@/lib/workflow-graph/approval-gate";
import {
  createUserInputGateService,
  type ResumeUserInputContext,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import { getConversation as defaultGetConversation } from "@/lib/state-store";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { ScriptValidatorOutcome } from "@/lib/workflow-graph/script-validator-runner";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { ToolResultBlock } from "./tool-dispatcher";
import {
  runCircuitBreakerGate as defaultRunCircuitBreakerGate,
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";
import { scriptValidationGateFromOutcome } from "@/lib/workflows/primitives/script-validation-gate";
import {
  buildLifecycleSnapshot,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";
import type { MutateActiveResult } from "./execution-repository";
import { getErrorMessage } from "@/lib/shared/errors";
import { graphLaneContextMetrics } from "@/lib/workflow-graph/graph-lane-store";

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
    ) => MutateActiveResult | GraphWorkflowExecution,
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
  /**
   * Effective ask-user-questions availability for this implementer turn — the
   * context's resolved toggle (an implementer lane always holds a real
   * conversation). Threaded into the runner's prompt-stream options so the
   * session instructions advertise the tool (Req 8.1-8.4).
   */
  askUserQuestionsEnabled?: boolean;
}

export interface GraphWorkflowAgentIterationResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
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
  recordLaneTurnOutcome(
    input: RecordLaneTurnOutcomeInput,
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
  /**
   * Latest persisted `graph-workflow-validation-result` event filed under the
   * context, or null. Replaces the backward scan over `execution.history` — the
   * orchestrator only ever needs the most recent validation event, which the
   * context index resolves in a single row lookup.
   */
  findLatestContextValidationEvent(
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowExecutionEvent | null>;
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
  /**
   * Gate that owns the `pendingUserInput` lifecycle. The orchestrator calls
   * `enterAwaitingUserInput` from the post-turn park check; a default is built
   * from `executionRepository` + `eventPublisher` when not injected.
   */
  userInputGateService?: UserInputGateService;
  /**
   * Read the post-turn pending-question state of a lane conversation. The
   * post-turn park check reads it to decide whether the turn ended with a
   * question batch pending on its conversation. Returns null when the
   * conversation is unknown.
   */
  readLaneConversation?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{
    pendingQuestionId: string | null;
    pendingQuestions: AskQuestionItem[];
  } | null>;
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
  /**
   * Summarize the lane conversation's transcript (true lineage cost, SDK turn
   * count, file re-read stats) for the `conversation.telemetry` iteration
   * event. Best-effort: absent dep, null return, or a throw skips the event
   * without affecting the iteration.
   */
  readConversationTelemetry?(
    conversationId: string,
  ): Promise<ConversationTelemetrySummary | null>;
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
  /**
   * Set when the loop resumes a context after its parked question was answered.
   * The asking conversation is pinned (rotation still outranks) and the answers
   * block is embedded in the resumed turn's prompt — the follow-up (pinned) or
   * seed (rotated) implementer prompt, or the validator prompt when the resumed
   * lane is `context_validator` (5.1, 5.3, 5.5).
   */
  resumeUserInput?: ResumeUserInputContext;
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

/**
 * Cap for a task's append-only `failureHistory`. The sole consumer renders the
 * full array into the retry prompt (`iteration-prompt.ts`), where only the most
 * recent failures matter; the cap is a guardrail against a pathological
 * validation loop growing the persisted execution blob without bound.
 */
const MAX_FAILURE_HISTORY = 10;

/**
 * Append one validation failure to a task's history, keeping only the most
 * recent {@link MAX_FAILURE_HISTORY} entries. Pure.
 */
export function appendFailureHistory(
  existing: GraphWorkflowTaskValidationFailure[] | undefined,
  entry: GraphWorkflowTaskValidationFailure,
): GraphWorkflowTaskValidationFailure[] {
  return [...(existing ?? []), entry].slice(-MAX_FAILURE_HISTORY);
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

/**
 * The latest persisted validation-result event for a context is the failure
 * that reopened its tasks: a passing validation completes the context and the
 * loop never re-enters to build this feedback. We therefore read just the most
 * recent validation event (via the context index) and apply the failure
 * predicate, rather than scanning the full event log.
 */
function isReopeningFailure(
  event: GraphWorkflowSSEEvent,
): event is GraphWorkflowValidationResultEvent {
  return (
    event.type === "graph-workflow-validation-result" &&
    event.validatorType === "context" &&
    event.pass === false &&
    event.reopenTaskIds.length > 0
  );
}

async function resolveLatestContextValidationFailureFeedback(
  deps: GraphWorkflowIterationOrchestratorDeps,
  execution: GraphWorkflowExecution,
  contextId: string,
): Promise<LatestContextValidationFailureFeedback | undefined> {
  const latest = await deps.findLatestContextValidationEvent(
    execution.id,
    contextId,
  );
  if (!latest || !isReopeningFailure(latest.event)) {
    return undefined;
  }
  return buildLatestContextValidationFailureFeedback(
    execution,
    contextId,
    latest.event,
  );
}

function buildLatestContextValidationFailureFeedback(
  execution: GraphWorkflowExecution,
  contextId: string,
  latestFailure: GraphWorkflowValidationResultEvent,
): LatestContextValidationFailureFeedback | undefined {
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
 *
 * Both the started entry and its outcome entry are written retrospectively,
 * back-to-back, AFTER the turn returns — their log timestamps are ~1ms apart
 * regardless of how long the wait ran. The started payload carries
 * `startedAt` (back-dated by `durationMs`) so it self-describes the wait's
 * true begin time.
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
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    durationMs,
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
  const userInputGateService =
    deps.userInputGateService ??
    createUserInputGateService({
      getActive: (projectPath, sessionName) =>
        deps.executionRepository.getActive(projectPath, sessionName),
      mutateActive: (projectPath, sessionName, fn) =>
        deps.executionRepository.mutateActive(projectPath, sessionName, fn),
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      deliver: eventPublisher.deliver,
      // Withdraw-only concern; the orchestrator never calls `withdrawAll`, so a
      // no-op refusal (actor treated as not live) is correct on the park path.
      sendConversationEvent: () => false,
      now: () => getNow(deps),
    });
  const readLaneConversation =
    deps.readLaneConversation ??
    (async (projectPath, sessionName, conversationId) => {
      try {
        const conversation = await defaultGetConversation(
          projectPath,
          sessionName,
          conversationId,
        );
        if (!conversation) {
          return null;
        }
        return {
          pendingQuestionId: conversation.pendingQuestionId,
          pendingQuestions: conversation.pendingQuestions ?? [],
        };
      } catch (error) {
        // A read failure cannot confirm a pending question, so the park check
        // treats it as "no question" (deny-by-default). Logged so a systematic
        // failure is visible rather than silently suppressing every park.
        logger.warn("graph-workflow.iteration.read_lane_conversation_failed", {
          conversationId,
          error: getErrorMessage(error),
        });
        return null;
      }
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
    // Fence before the status/null checks: for a stale loop generation those
    // errors would describe the SUCCESSOR's state and be recorded against it
    // as a halt. The fence error instead exits the caller silently, before a
    // conversation is created or an agent turn is prompted.
    assertLoopFence(projectPath, sessionName, execution);
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
    assertLoopFence(projectPath, sessionName, execution);
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
        nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
          hasLiveIteration: true,
        });
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
    ) => GraphWorkflowEventDelivery;
  }): Promise<GraphWorkflowExecution> {
    // Reopened-task observability captured (pure) inside the reducer and emitted
    // AFTER the mutation commits, so the write-queue critical section performs no
    // logging I/O (`no-slow-work-in-critical-section`).
    const reopenedTaskLog: Array<{ taskId: string; failureMessage: string }> =
      [];
    const committed = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const nextExecution = cloneExecution(latest);
        const failureTimestamp = getNow(deps);
        reopenedTaskLog.length = 0;

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
          taskState.failureHistory = appendFailureHistory(
            taskState.failureHistory,
            { message: failureMessage, timestamp: failureTimestamp },
          );

          reopenedTaskLog.push({ taskId, failureMessage });
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

        nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
          hasLiveIteration: true,
        });

        const delivery = input.publishValidationEvent?.(nextExecution);
        return {
          execution: nextExecution,
          events: delivery?.events ?? [],
          pushes: delivery?.pushes ?? [],
        };
      },
    );

    // Post-commit: emit the reopened-task logs (file I/O) outside the lock.
    const execLogger = getExecutionLogger(committed.id);
    for (const { taskId, failureMessage } of reopenedTaskLog) {
      execLogger?.task(input.contextId, "task.reopened", {
        taskId,
        failureMessage,
      });
      logger.info("graph-workflow.task.reopened", {
        executionId: committed.id,
        contextId: input.contextId,
        taskId,
      });
    }
    return committed;
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
          failureHistory: appendFailureHistory(undefined, {
            message: input.outcome.summary,
            timestamp: failureTimestamp,
          }),
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

        nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
          hasLiveIteration: true,
        });
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
      execLogger?.validation(input.contextId, "script_validation.passed", {
        headSha: outcome.treeState?.headSha ?? null,
        dirty: outcome.treeState?.dirty ?? null,
        command: outcome.command ?? null,
      });
      logger.info("graph-workflow.script_validation.passed", {
        executionId: execution.id,
        contextId: input.contextId,
        headSha: outcome.treeState?.headSha ?? null,
      });
      return "pass";
    }

    const gate = scriptValidationGateFromOutcome(outcome);
    const failureClass = gate.details?.failureClass;

    if (outcome.kind === "infra_error") {
      if (outcome.reason === "missing_pre_merge_command") {
        execLogger?.validation(
          input.contextId,
          "script_validation.missing_pre_merge_command",
          { message: gate.reason },
        );
        logger.warn(
          "graph-workflow.script_validation.missing_pre_merge_command",
          {
            executionId: execution.id,
            contextId: input.contextId,
            failureClass,
          },
        );
        const haltReason: GraphWorkflowHaltReason = {
          type: "script_validator_missing_command",
          contextId: input.contextId,
          message: gate.reason,
        };
        await onHalt(haltReason);
        throw new IterationHaltedError(haltReason);
      }

      execLogger?.validation(input.contextId, "script_validation.exception", {
        message: gate.reason,
      });
      logger.warn("graph-workflow.script_validation.exception", {
        executionId: execution.id,
        contextId: input.contextId,
        message: gate.reason,
        failureClass,
      });
      const recoveryReason: GraphWorkflowHaltReason = {
        type: "recovery_error",
        message: `Script validator error: ${gate.reason}`,
      };
      await onHalt(recoveryReason);
      throw new IterationHaltedError(recoveryReason);
    }

    execLogger?.validation(input.contextId, "script_validation.failed", {
      summary: gate.reason,
      logRelativePath: outcome.logRelativePath,
      timedOut: outcome.timedOut,
      headSha: outcome.treeState?.headSha ?? null,
      dirty: outcome.treeState?.dirty ?? null,
      command: outcome.command ?? null,
    });
    logger.info("graph-workflow.script_validation.failed", {
      executionId: execution.id,
      contextId: input.contextId,
      logRelativePath: outcome.logRelativePath,
      failureClass,
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

  /**
   * Shared awaiting-user-input park for both the implementer and context-
   * validator lanes (design "Park detection"; Req 3.2, 3.3). Hands the batch to
   * the user-input gate; on `"answers_ready"` (fast answer) returns null so the
   * caller proceeds. On `"parked"` it commits the park mutation — dropping the
   * context from `activeContextIds`, rebuilding the machine snapshot, and (for
   * the implementer seed increment only) restoring the pre-seed iteration count
   * so parking consumes no iteration — then re-reads and returns the parked
   * iteration result. It never touches `consecutiveFailureCount` or reopens
   * tasks.
   */
  async function parkContextForUserInput(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    lane: "implementer" | "context_validator";
    conversationId: string;
    questionBatchId: string;
    questions: AskQuestionItem[];
    /** When set, the context's iterationCount is restored to this value. */
    restoreIterationCount?: number;
  }): Promise<GraphWorkflowIterationResult | null> {
    const {
      input,
      execLogger,
      lane,
      conversationId,
      questionBatchId,
      questions,
      restoreIterationCount,
    } = params;

    const outcome = await userInputGateService.enterAwaitingUserInput({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      contextId: input.contextId,
      lane,
      conversationId,
      questionBatchId,
      questions,
    });

    if (outcome === "answers_ready") {
      execLogger?.iteration(
        input.contextId,
        "iteration.user_input_fast_answer",
        { lane, conversationId, questionBatchId },
      );
      logger.info("graph-workflow.iteration.user_input_fast_answer", {
        contextId: input.contextId,
        lane,
        questionBatchId,
      });
      return null;
    }

    const parkedExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const parkedContextState = next.contextStates[input.contextId];
        if (parkedContextState && restoreIterationCount !== undefined) {
          parkedContextState.iterationCount = restoreIterationCount;
        }
        next.activeContextIds = next.activeContextIds.filter(
          (id) => id !== input.contextId,
        );
        next.machineSnapshot = buildLifecycleSnapshot(next, {
          hasLiveIteration: false,
        });
        return next;
      },
    );

    execLogger?.iteration(
      input.contextId,
      "iteration.parked_awaiting_user_input",
      {
        lane,
        conversationId,
        questionBatchId,
        questionCount: questions.length,
      },
    );
    logger.info("graph-workflow.iteration.parked_awaiting_user_input", {
      executionId: parkedExecution.id,
      contextId: input.contextId,
      lane,
      questionBatchId,
    });

    return {
      conversationId,
      execution: parkedExecution,
      shouldContinueInContext: false,
    };
  }

  async function processContextCompletionValidation(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<GraphWorkflowIterationResult | null> {
    const { input, execLogger, onHalt } = params;
    const preContextValidationExecution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );

    if (preContextValidationExecution.status !== "running") {
      return null;
    }

    const remainingTasks = getIncompleteTasks(
      preContextValidationExecution,
      input.contextId,
    );
    if (remainingTasks.length > 0) {
      return null;
    }

    const scriptStageResult = await processScriptValidation({
      input,
      execLogger,
      execution: preContextValidationExecution,
      onHalt,
    });

    if (scriptStageResult === "fail") {
      return null;
    }

    const executionForAgentValidation = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );

    if (executionForAgentValidation.status !== "running") {
      return null;
    }

    // Only a validator resume delivers the answers block into the validation
    // prompt and pins the validator conversation. An implementer resume reaches
    // this inline completion check on the same turn; its answers belong in the
    // implementer prompt, never the validator's, so it is excluded here.
    const validatorResume =
      input.resumeUserInput?.lane === "context_validator"
        ? input.resumeUserInput
        : undefined;

    const validation = await validationService.validateContextCompletion({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: executionForAgentValidation,
      contextId: input.contextId,
      executionTarget: input.executionTarget,
      resumeUserInput: validatorResume,
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
        (latest) => {
          const delivery = eventPublisher.publishValidationResult({
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
          });
          return { execution: latest, ...delivery };
        },
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

    // The validator turn ended with a pending question and no verdict (Req 3.2).
    // Park the context on the context_validator lane — never reopen tasks, never
    // increment consecutiveFailureCount, never record a validation-failure event
    // (Req 3.3). `answers_ready` (fast answer) → null, and the caller falls
    // through to the normal finalize path.
    if (validation.kind === "asked_user") {
      return parkContextForUserInput({
        input,
        execLogger,
        lane: "context_validator",
        conversationId: validation.conversationId,
        questionBatchId: validation.questionBatchId,
        questions: validation.questions,
      });
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
      return null;
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
        reset.machineSnapshot = buildLifecycleSnapshot(reset, {
          hasLiveIteration: true,
        });
        const delivery = eventPublisher.publishValidationResult({
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
        return { execution: reset, ...delivery };
      },
    );

    return null;
  }

  async function finalizeIterationResult(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
    terminatedByTerminalError?: boolean;
  }): Promise<GraphWorkflowIterationResult> {
    const {
      input,
      execLogger,
      conversationId,
      terminatedByTerminalError = false,
    } = params;
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
    let consecutiveFailureCount = 0;
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

        if (terminatedByTerminalError) {
          // A swallowed IterationHaltedError still counts as a consecutive
          // failure so a terminal-error loop trips the circuit breaker at the
          // threshold rather than running to maxIterations.
          finalizedContextState.consecutiveFailureCount =
            (finalizedContextState.consecutiveFailureCount ?? 0) + 1;
        }
        consecutiveFailureCount =
          finalizedContextState.consecutiveFailureCount ?? 0;

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
          transitionContextStatus(
            finalizedExecution,
            input.contextId,
            "running",
            {
              reason: "iteration.finalize_continue",
            },
          );
        } else if (gateEnabled) {
          approvalGateService.enterAwaitingApproval(finalizedExecution, {
            contextId: input.contextId,
            conversationId,
          });
          approvalRequestedAt =
            finalizedContextState.pendingApproval?.requestedAt ?? null;
        } else {
          transitionContextStatus(
            finalizedExecution,
            input.contextId,
            "completed",
            {
              reason: "iteration.finalize_complete",
            },
          );
        }
        finalizedExecution.activeContextIds = shouldContinueInContext
          ? finalizedExecution.activeContextIds.includes(input.contextId)
            ? finalizedExecution.activeContextIds
            : [...finalizedExecution.activeContextIds, input.contextId]
          : finalizedExecution.activeContextIds.filter(
              (contextId) => contextId !== input.contextId,
            );
        finalizedExecution.machineSnapshot = buildLifecycleSnapshot(
          finalizedExecution,
          { hasLiveIteration: false },
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
      consecutiveFailureCount,
    });
    if (deps.readConversationTelemetry && execLogger) {
      try {
        const telemetry = await deps.readConversationTelemetry(conversationId);
        if (telemetry) {
          const implementerLane =
            persistedExecution.laneStates[input.contextId]?.["implementer"];
          const laneMetrics = graphLaneContextMetrics(implementerLane);
          execLogger.iteration(input.contextId, "conversation.telemetry", {
            conversationId,
            iterationNumber,
            shouldContinueInContext,
            contextTokens: laneMetrics.contextTokens,
            contextWindowMax: laneMetrics.contextWindowMax,
            ...telemetry,
          });
        }
      } catch (error) {
        logger.warn("graph-workflow.conversation_telemetry.failed", {
          executionId: persistedExecution.id,
          contextId: input.contextId,
          conversationId,
          error: getErrorMessage(error),
        });
      }
    }
    logger.info("graph-workflow.iteration.completed", {
      executionId: persistedExecution.id,
      contextId: input.contextId,
      completedTaskCount,
      remainingTaskCount,
    });

    if (approvalRequestedAt !== null) {
      const requestedAt: string = approvalRequestedAt;
      // Post-commit `gate.pending` — the parking mutation (which called the now
      // pure `enterAwaitingApproval`) has committed, so this logging I/O runs
      // outside the write-queue critical section (`no-slow-work-in-critical-section`).
      logger.info("gate.pending", {
        executionId: persistedExecution.id,
        contextId: input.contextId,
        conversationId,
        requestedAt,
      });
      // This follow-up mutation only persists the approval-pending history
      // entry that the publisher appends alongside its SSE broadcast and push
      // dispatch.
      const executionWithApprovalEvent =
        await deps.executionRepository.mutateActive(
          input.projectPath,
          input.sessionName,
          (latest) => {
            const delivery = eventPublisher.publishApprovalPending({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: latest,
              contextId: input.contextId,
              conversationId,
              requestedAt,
            });
            return { execution: latest, ...delivery };
          },
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
          error: getErrorMessage(haltError),
        });
        throw haltError;
      }
    }

    let terminalErrorCaught = false;
    let parkedResult: GraphWorkflowIterationResult | null = null;
    try {
      parkedResult = await processContextCompletionValidation({
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
      terminalErrorCaught = true;
    }

    // A validator that asked during the re-entry path parks the context; short-
    // circuit finalize so it stays parked (Req 3.2, 3.3).
    if (parkedResult !== null) {
      return parkedResult;
    }

    const conversationId = pickConversationIdForValidationOnlyIteration(
      initialExecution,
      input.contextId,
    );
    return finalizeIterationResult({
      input,
      execLogger,
      conversationId,
      terminatedByTerminalError: terminalErrorCaught,
    });
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
          error: getErrorMessage(err),
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
      await resolveLatestContextValidationFailureFeedback(
        deps,
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
    let previousConversationHandoff:
      | { conversationId: string; note: string }
      | undefined;
    if (deps.continuityService) {
      const resolved = await deps.continuityService.resolveImplementerCall({
        execution: initialExecution,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        contextId: input.contextId,
        backend: context.implementer.backend,
        pinnedConversationId: input.resumeUserInput?.conversationId,
      });
      conversationId = resolved.conversationId;
      resolvedImplementerLaneState =
        resolved.execution.laneStates[input.contextId]?.["implementer"] ?? null;
      promptMode = resolved.promptMode;
      previousConversationHandoff = resolved.previousConversationHandoff;
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
        transitionContextStatus(next, input.contextId, "running", {
          reason: "iteration.seed",
        });
        seededContextState.iterationCount += 1;
        bindConversationToIncompleteTasks(
          next,
          input.contextId,
          conversation.id,
          getNow(deps),
        );
        next.machineSnapshot = buildLifecycleSnapshot(next, {
          hasLiveIteration: true,
        });
        return next;
      },
    );
    const seededContextState = seededExecution.contextStates[input.contextId];
    if (!seededContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }
    // Pre-seed iteration count. A parked iteration must not consume an
    // iteration (Req 3.3, design 3.3 "bypasses seed/failure branches"), so the
    // park short-circuit rolls the seed increment back to this value.
    const iterationCountBeforeSeed =
      initialExecution.contextStates[input.contextId]?.iterationCount ?? 0;
    const collaborationContinuations = getUndeliveredCollaborationContinuations(
      seededExecution,
      input.contextId,
    );
    const allowAgentCollaboration =
      context.collaboration?.enabled.value === true;
    const collaborationContinuationWorkflowIds = collaborationContinuations.map(
      (continuation) => continuation.workflowId,
    );

    async function markCollaborationContinuationsDelivered(): Promise<void> {
      if (collaborationContinuationWorkflowIds.length === 0) {
        return;
      }
      await deps.executionRepository.mutateActive(
        input.projectPath,
        input.sessionName,
        (latest) => {
          const next = cloneExecution(latest);
          next.collaborationContinuations ??= {};
          const continuations =
            next.collaborationContinuations[input.contextId] ?? [];
          const workflowIdSet = new Set(collaborationContinuationWorkflowIds);
          // Delivered continuations are consumed — drop them so the per-context
          // array stays bounded (nothing reads a delivered continuation again).
          const remaining = continuations.filter(
            (continuation) => !workflowIdSet.has(continuation.workflowId),
          );
          if (remaining.length === 0) {
            delete next.collaborationContinuations[input.contextId];
          } else {
            next.collaborationContinuations[input.contextId] = remaining;
          }
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
          error: getErrorMessage(haltError),
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
    let terminalErrorCaught = false;
    let parkedResult: GraphWorkflowIterationResult | null = null;

    // Post-turn park check (Req 3.1, 3.3, 5.4; design "Park detection"). Runs
    // after the agent turn(s) settle and before any continue/validate
    // evaluation: if the lane conversation ended with a question batch pending,
    // hand it to the user-input gate. A `parked` outcome short-circuits the
    // iteration — it skips validation, failure accounting, and
    // continue-scheduling, and rolls the seed iteration increment back so the
    // park consumes no iteration. `answers_ready` (fast answer, 5.4) falls
    // through to the normal finalize path with no park.
    async function parkContextIfQuestionPending(): Promise<GraphWorkflowIterationResult | null> {
      const laneConversation = await readLaneConversation(
        input.projectPath,
        input.sessionName,
        conversation.id,
      );
      const pendingQuestionId = laneConversation?.pendingQuestionId ?? null;
      if (pendingQuestionId === null) {
        return null;
      }

      // Parking rolls the seed increment back (Req 3.3: parking consumes no
      // iteration); the shared helper flips the status, drops the context from
      // the active set, and returns the parked snapshot.
      return parkContextForUserInput({
        input,
        execLogger,
        lane: "implementer",
        conversationId: conversation.id,
        questionBatchId: pendingQuestionId,
        questions: laneConversation?.pendingQuestions ?? [],
        restoreIterationCount: iterationCountBeforeSeed,
      });
    }

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
        askUserQuestionsEnabled: context.askUserQuestions.enabled,
      } as const;

      async function recordTurnOutcome(
        agentResult: GraphWorkflowAgentIterationResult,
      ): Promise<void> {
        const continuityService = deps.continuityService;
        if (!continuityService) return;
        const contextLimitTokens =
          context.iterationPolicy.continuity.contextLimitTokens;
        const latest = await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        );
        if (latest.status !== "running") {
          return;
        }
        const laneBackend = context.implementer.backend;
        const sessionRef = refValueForBackend(
          agentResult.sessionRef,
          laneBackend,
        );
        const outcome: LaneOutcome = {
          backend: laneBackend,
          ...(agentResult.contextTokens !== null
            ? { contextTokens: agentResult.contextTokens }
            : {}),
          ...(agentResult.contextWindowMax !== null
            ? { contextWindowMax: agentResult.contextWindowMax }
            : {}),
          ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
          ...(sessionRef !== undefined ? { ref: sessionRef } : {}),
          ...(agentResult.compacted ? { compactedThisTurn: true } : {}),
        };
        await continuityService.recordLaneTurnOutcome({
          execution: latest,
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          contextId: input.contextId,
          lane: "implementer",
          outcome,
        });
      }

      // Initial agent call — seed prompt for fresh sessions, follow-up for resumed sessions
      const initialTasks = getIncompleteTasks(seededExecution, input.contextId);
      // A resume delivers the answers block in whichever prompt this turn uses:
      // the follow-up when the asking conversation is reused (pinned), or the
      // seed when rotation forced a fresh conversation (5.1, 5.3).
      const resumeUserInputPrompt = input.resumeUserInput
        ? {
            questionBatchId: input.resumeUserInput.questionBatchId,
            answers: input.resumeUserInput.answers,
          }
        : undefined;
      const initialPrompt =
        promptMode === "follow_up"
          ? buildFollowUpPrompt({
              remainingTasks: initialTasks,
              taskStates: seededExecution.taskStates,
              attemptNumber: 1,
              maxAttempts: MAX_FOLLOW_UPS,
              latestContextValidationFailure,
              collaborationContinuations,
              allowAgentCollaboration,
              charter: context.charter,
              charterAmendments: seededExecution.charterAmendments,
              resumeUserInput: resumeUserInputPrompt,
              askUserQuestionsEnabled: context.askUserQuestions.enabled,
            })
          : buildIterationPrompt({
              context,
              tasks: initialTasks,
              taskStates: seededExecution.taskStates,
              sharedDocuments: seededExecution.sharedDocuments,
              allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
              charter: context.charter,
              charterAmendments: seededExecution.charterAmendments,
              askUserQuestionsEnabled: context.askUserQuestions.enabled,
              allowAgentCollaboration,
              contextValidationAcceptanceCriteria:
                context.contextValidator !== null &&
                context.contextValidator.enabled
                  ? context.acceptanceCriteria
                  : undefined,
              latestContextValidationFailure,
              collaborationContinuations,
              resumeUserInput: resumeUserInputPrompt,
              previousConversationHandoff,
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
      // enforcement that pairs with the lane HTTP endpoints' pre-dispatch check
      // `resolveLaneHaltReason` (tool-dispatcher.ts) run by
      // `lane-route-handlers.ts`. The contract is two-part:
      //
      //   1. Within a turn each lane tool call arrives as a separate HTTP
      //      request. Every endpoint checks `pendingHaltReason` and pending
      //      collaboration state BEFORE doing real work. A pending halt returns
      //      the canonical `"iteration halted: <type>"` message; a pending
      //      collaboration returns a non-terminal error so sibling tool calls
      //      in the same turn cannot mutate workflow state while the
      //      collaboration is running.
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

      // Per-turn billing (audit telemetry): conversation-grained cost cannot
      // attribute dollars to iterations or turns, so each turn record carries
      // the transcript's cumulative cost and this turn's delta. Baseline
      // before the first turn — a reused conversation starts non-zero.
      let previousCumulativeCostUsd: number | null = null;
      const readTurnBilling = async (): Promise<{
        cumulativeCostUsd: number | null;
        costUsdDelta: number | null;
      }> => {
        if (!deps.readConversationTelemetry || !execLogger) {
          return { cumulativeCostUsd: null, costUsdDelta: null };
        }
        try {
          const telemetry = await deps.readConversationTelemetry(
            conversation.id,
          );
          const cumulative = telemetry?.costUsd ?? null;
          const delta =
            cumulative === null
              ? null
              : Math.max(0, cumulative - (previousCumulativeCostUsd ?? 0));
          if (cumulative !== null) {
            previousCumulativeCostUsd = cumulative;
          }
          return { cumulativeCostUsd: cumulative, costUsdDelta: delta };
        } catch {
          // Billing telemetry must never fail the turn that emits it.
          return { cumulativeCostUsd: null, costUsdDelta: null };
        }
      };
      if (deps.readConversationTelemetry && execLogger) {
        try {
          previousCumulativeCostUsd =
            (await deps.readConversationTelemetry(conversation.id))?.costUsd ??
            null;
        } catch {
          previousCumulativeCostUsd = null;
        }
      }

      let agentResult = await deps.runAgentIteration({
        ...agentCallBase,
        prompt: initialPrompt,
      });
      await markCollaborationContinuationsDelivered();
      await recordTurnOutcome(agentResult);
      completedTurnCount += 1;

      const initialTurnBilling = await readTurnBilling();
      execLogger?.iteration(input.contextId, "iteration.agent_turn_completed", {
        turnNumber: 0,
        contextTokens: agentResult.contextTokens,
        contextWindowMax: agentResult.contextWindowMax,
        // Without a window max, contextTokens is a backend-specific counter
        // (codex: cumulative processed tokens) and MUST NOT be read as window
        // occupancy downstream.
        occupancyMeasurable: agentResult.contextWindowMax !== null,
        cumulativeCostUsd: initialTurnBilling.cumulativeCostUsd,
        costUsdDelta: initialTurnBilling.costUsdDelta,
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
          const rotationScheduled = laneState
            ? graphWorkflowAgentSessionStateSchema.parse(laneState).metrics
                .rotateBeforeNextTurn
            : false;
          if (rotationScheduled) {
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

        // Park before dispatching the next follow-up. The conversation
        // machine's waitingForInput state accepts SUBMIT_PROMPT by wiping the
        // pending question (any claimed turn supersedes it), so a follow-up
        // sent onto an ask-ended conversation destroys the batch the user is
        // being asked to answer — the post-loop check would then find nothing
        // and the ask would be lost (design "Park detection": the check runs
        // after every agent turn). Runs after the other break conditions so a
        // loop that is exiting anyway leaves the question to the post-loop
        // check. `answers_ready` (fast answer, 5.4) falls through and the
        // follow-up proceeds.
        parkedResult = await parkContextIfQuestionPending();
        if (parkedResult !== null) {
          break;
        }

        const followUpPrompt = buildFollowUpPrompt({
          remainingTasks: remaining,
          taskStates: midExecution.taskStates,
          attemptNumber: attempt,
          maxAttempts: MAX_FOLLOW_UPS,
          latestContextValidationFailure:
            await resolveLatestContextValidationFailureFeedback(
              deps,
              midExecution,
              input.contextId,
            ),
          collaborationContinuations: [],
          allowAgentCollaboration,
          charter: context.charter,
          charterAmendments: midExecution.charterAmendments,
          askUserQuestionsEnabled: context.askUserQuestions.enabled,
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

        const followUpTurnBilling = await readTurnBilling();
        execLogger?.iteration(
          input.contextId,
          "iteration.agent_turn_completed",
          {
            turnNumber: attempt,
            contextTokens: agentResult.contextTokens,
            contextWindowMax: agentResult.contextWindowMax,
            occupancyMeasurable: agentResult.contextWindowMax !== null,
            cumulativeCostUsd: followUpTurnBilling.cumulativeCostUsd,
            costUsdDelta: followUpTurnBilling.costUsdDelta,
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

      if (!stoppedForCollaboration && parkedResult === null) {
        // Park before validation/continue so a question-ending turn skips both
        // (design "Park detection": the check runs before finalize evaluates
        // continue/validate). Covers the final turn of an exhausted follow-up
        // loop, which the pre-dispatch check inside the loop never sees.
        parkedResult = await parkContextIfQuestionPending();
      }

      if (!stoppedForCollaboration && parkedResult === null) {
        // The validator can also park (it asked a question); its parked result
        // flows through the same short-circuit as the implementer park below.
        parkedResult = await processContextCompletionValidation({
          input,
          execLogger,
          onHalt: haltIteration,
        });
      }
    } catch (error) {
      if (!(error instanceof IterationHaltedError)) {
        // Park before failure classification (design "Park detection" ordering).
        // A lane agent that asked and ended its turn can surface as a transient
        // sessionDiedMidTurn SDK error: the implementer runner's
        // waitForBackgroundTasks settlement barrier holds the query pump past the
        // `result` message, so the ask-interrupt is reported as a thrown turn
        // error rather than a clean return. A pending user question is a
        // legitimate turn ending and must win over that error — otherwise it is
        // misclassified as a failure and retried instead of parked. The park
        // check only parks when a question is actually pending, so a genuine
        // failure still propagates.
        parkedResult = await parkContextIfQuestionPending();
        if (parkedResult === null) {
          if (completedTurnCount > 0) {
            throw new IterationFailureWithProgressError(
              error,
              completedTurnCount,
            );
          }
          throw error;
        }
      } else {
        execLogger?.iteration(
          input.contextId,
          "iteration.terminal_error_caught",
          {
            errorType: error.name,
            message: error.message,
          },
        );
        terminalErrorCaught = true;
      }
    } finally {
      await toolServer.close?.();
    }

    // A parked context short-circuits finalize: no validation, no failure
    // accounting, no continue-scheduling (Req 3.1, 3.3).
    if (parkedResult !== null) {
      return parkedResult;
    }

    return finalizeIterationResult({
      input,
      execLogger,
      conversationId: conversation.id,
      terminatedByTerminalError: terminalErrorCaught,
    });
  }

  return { runIteration };
}
