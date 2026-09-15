import type { ContextValidationCoordinator } from "./context-validation-coordinator";
import { WorkflowDocumentDeliveryError } from "./errors";
import { StaleLoopFenceError } from "./loop-fence";
import { unchanged } from "./execution-mutation";
import { accountContextAction } from "./context-accounting";
import {
  getContextDefinition,
  getContextTasks,
  getIncompleteTasks,
  countCompletedTasks,
  countRemainingTasks,
} from "./execution-index";

import { requireCurrentExecution } from "./execution-repository";
import { observeContextValidationCandidate } from "./validation-services";
import { parkContextForUserInput } from "./user-input-gate";
import {
  IterationHaltedError,
  type GraphWorkflowIterationInput,
  type GraphWorkflowIterationResult,
  type GraphWorkflowSignalHaltInput,
} from "./context-outcome";
import { type IterationOrchestratorValidationRoundService } from "./context-validation-coordinator";
import type { ContextDecision } from "./context-outcome";

import { mutationValue } from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import type { GraphWorkflowExecutionRepository } from "./execution-repository";

import { createLogger } from "@/lib/logging";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { assertLoopFence } from "./loop-fence";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { refValueForBackend } from "@/lib/agent-backends/continuity";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowAgentSessionStateSchema,
  type GraphWorkflowApprovalScope,
  type GraphWorkflowExecution,
  type GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowCollaborationContinuation } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  ContextPlacement,
  GraphWorkflowValidationIssue,
} from "@/lib/workflow-graph/definition-schemas";

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
  resolveLogicalAuthoredContextId,
  resolveScopedCharterForContext,
} from "./charter/invariant-scope";
import { contextOwesOutput, resolveUpstreamInputs } from "./context-outputs";
import { resolveLoopHistory } from "./loop-history";

import { isValidationRoundOpen } from "@/lib/workflow-graph/validation-round";
import { resolveContextReviewOrigin } from "./review-origin";

import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";

import { type ApprovalGateService } from "@/lib/workflow-graph/approval-gate";
import {
  type ResumeUserInputContext,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";

import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import {
  loadValidationPromptRegistry,
  resolveValidationPromptSelections,
} from "./validation-prompt-section";
import type { AskQuestionItem } from "@/lib/conversations/schemas";

import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";

import {
  type CircuitBreakerGateResult,
  type RunCircuitBreakerGateInput,
} from "@/lib/workflows/primitives/circuit-breaker-gate";

import {
  buildLifecycleSnapshot,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";
import { getErrorMessage } from "@/lib/shared/errors";
import { graphLaneContextMetrics } from "@/lib/workflow-graph/graph-lane-store";
import {
  assignmentFingerprint,
  laneStateKey,
} from "@/lib/workflow-graph/lane-identity";

import { type GraphExecutionContract } from "./execution-contract-port";
import { composeGraphRolePrompt } from "./prompt-composer";

type GraphWorkflowIterationExecutionRepository = Pick<
  GraphWorkflowExecutionRepository,
  "getActive" | "mutateActive"
>;

interface GraphWorkflowIterationConversation {
  id: string;
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
  modelSelection: BackendModelSelection;
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
  /**
   * The context's authored placement, read from the working definition as of
   * THIS iteration's seed commit. Forwarded so the runner composes this turn's
   * write envelope from the ownership the definition declared, before any
   * dispatch decision (R6). Re-read per iteration rather than captured at
   * launch: a placement change accepted by the live-edit core takes effect on
   * the context's next turn (R10.2), and a stale copy here would run the turn
   * under ownership the operator already revoked.
   *
   * Optional because an execution seeded before placement existed carries none.
   */
  placement?: ContextPlacement;
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

export interface GraphWorkflowIterationOrchestratorDeps {
  executionRepository: GraphWorkflowIterationExecutionRepository;
  /**
   * Latest persisted `graph-workflow-validation-result` event filed under the
   * context, or null. Replaces the backward scan over `execution.history` — the
   * orchestrator only ever needs the most recent validation event, which the
   * context index resolves in a single row lookup.
   */
  findLatestContextValidationEvent(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<GraphWorkflowExecutionEvent | null>;
  createConversation(
    projectPath: string,
    sessionName: string,
    /** `agentBackend` is not optional decoration: the conversation service
     *  defaults a new conversation to Claude, so a context configured for any
     *  other backend must say so or its turns dispatch to the wrong one. */
    opts: {
      role: "iteration";
      agentBackend?: AgentBackendId;
      /** The context implementer's execution-seeded snapshot (R4). */
      profileSnapshot?: AgentProfileSnapshot;
    },
  ): Promise<GraphWorkflowIterationConversation>;
  runAgentIteration(
    input: GraphWorkflowRunAgentIterationInput,
  ): Promise<GraphWorkflowAgentIterationResult>;
  executionContract: GraphExecutionContract;
  signalHalt(
    input: GraphWorkflowSignalHaltInput,
  ): Promise<GraphWorkflowExecution>;
  continuityService: IterationOrchestratorContinuityService | null;
  /**
   * Resolves the git half of a validation round's candidate identity. An unavailable
   * result describes a context with no resolvable worktree; certification
   * decides whether that context requires a tree candidate.
   */
  validationRoundService: IterationOrchestratorValidationRoundService;
  approvalGateService: ApprovalGateService;
  /**
   * Gate that owns the `pendingUserInputs` lifecycle. The orchestrator calls
   * `enterAwaitingUserInput` from the post-turn park check.
   */
  userInputGateService: UserInputGateService;
  /**
   * Read the post-turn pending-question state of a lane conversation. The
   * post-turn park check reads it to decide whether the turn ended with a
   * question batch pending on its conversation. Returns null when the
   * conversation is unknown.
   */
  readLaneConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<{
    pendingQuestionId: string | null;
    pendingQuestions: AskQuestionItem[];
  } | null>;
  /**
   * Reads `CommandCenter.json` so the seed prompt can list the context's
   * effective command selections with costs (validation-concurrency §8).
   * Degraded-not-fatal: a read failure renders explicit empty selections.
   */
  readRepoConfig: typeof defaultReadRepoConfig;
  now?(): string;
  eventPublisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>;
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
   * Copies the execution's charter + shared documents into a
   * execution target before the agent runs. Shared documents can be published
   * from any lane and are distributed through the central store.
   * Failure prevents dispatch of implementers and validators until every
   * advertised input has been delivered for this execution generation. Returns
   * the delivered snapshot so prompt metadata identifies those same inputs.
   */
  materializeWorkflowDocuments(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    worktreePath: string;
  }): Promise<GraphWorkflowExecution>;
  /**
   * Summarize the lane conversation's transcript (true lineage cost, SDK turn
   * count, file re-read stats) for the `conversation.telemetry` iteration
   * event. Best-effort: absent dep, null return, or a throw skips the event
   * without affecting the iteration.
   */
  readConversationTelemetry?(
    conversationId: string,
  ): Promise<ConversationTelemetrySummary | null>;
  contextValidation: ContextValidationCoordinator;
}

/** The implementer's answers, if this resume carries any. One lane per context. */
function implementerResumeEntry(
  input: GraphWorkflowIterationInput,
): ResumeUserInputContext | undefined {
  return input.resumeUserInputs?.find((entry) => entry.lane === "implementer");
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
  projectPath: string,
  sessionName: string,
  execution: GraphWorkflowExecution,
  contextId: string,
): Promise<LatestContextValidationFailureFeedback | undefined> {
  const latest = await deps.findLatestContextValidationEvent(
    projectPath,
    sessionName,
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

  const scopedIssues = new Map<string, GraphWorkflowValidationIssue[]>();
  const generalIssues: GraphWorkflowValidationIssue[] = [];
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
  const executionContract = deps.executionContract;
  const {
    eventPublisher,
    approvalGateService,
    userInputGateService,
    readLaneConversation,
    signalHalt,
    contextValidation,
  } = deps;

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

  /** Freeze the same retained-work candidate for human and automated review. */
  async function freezeApprovalScope(
    input: GraphWorkflowIterationInput,
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowApprovalScope> {
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    if (context === undefined) return { kind: "whole_tree" };
    if (!context.humanApprovalGate.enabled) return { kind: "whole_tree" };
    const review = resolveContextReviewOrigin(execution, input.contextId);
    if (review.kind === "unavailable")
      return { kind: "unreadable", reason: review.reason };
    const scope = review.candidateScope;

    // Only the finalize that actually parks needs a candidate: the gate branch
    // is reached with every task done and no output outstanding, so reading git
    // for anything else spends I/O on an iteration that keeps running. A scope
    // frozen for a branch that is not taken is simply dropped.
    if (
      countRemainingTasks(execution, input.contextId) > 0 ||
      contextOwesOutput(execution, input.contextId)
    ) {
      return {
        kind: "unreadable",
        reason: "the context was not finalizing when the gate opened",
      };
    }

    const observed = await observeContextValidationCandidate(
      deps.validationRoundService,
      input,
      execution,
    );
    if (observed.kind !== "resolved") {
      logger.warn("graph-workflow.approval.scoped_snapshot_unresolved", {
        executionId: execution.id,
        contextId: input.contextId,
        reason: observed.reason,
      });
      return { kind: "unreadable", reason: observed.reason };
    }
    if (scope.mode === "wholeTree") {
      return {
        kind: "whole_tree",
        treeHash: observed.candidate.candidateTreeHash,
        headSha: observed.candidate.headSha,
      };
    }
    return {
      kind: "scoped",
      ownedPaths: [...scope.ownedPaths],
      treeHash: observed.candidate.candidateTreeHash,
      headSha: observed.candidate.headSha,
    };
  }

  async function settleOrdinaryIterationTermination(
    input: GraphWorkflowIterationInput,
  ): Promise<void> {
    const result = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        if (latest.status !== "running") return unchanged();
        const state = latest.contextStates[input.contextId];
        if (!state)
          throw new Error(`Missing context state "${input.contextId}"`);
        Object.assign(
          state,
          accountContextAction(state, { kind: "ordinary_terminal_error" }),
        );
        state.completedTaskCount = countCompletedTasks(latest, input.contextId);
        latest.machineSnapshot = buildLifecycleSnapshot(latest, {
          hasLiveIteration: false,
        });
        return changed(latest);
      },
    );
    logger.info("graph-workflow.iteration.terminal_error_settled", {
      executionId: result.execution.id,
      contextId: input.contextId,
      committed: result.kind === "changed",
    });
  }

  async function finalizeIterationResult(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
  }): Promise<GraphWorkflowIterationResult> {
    const { input, execLogger, conversationId } = params;
    const currentExecution = await requireCurrentExecution(
      deps.executionRepository,
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
        decision: { kind: "execution_stopped" },
      };
    }

    // Frozen BEFORE the parking mutation, because reading git inside a
    // `mutateActive` reducer would put I/O in the write-queue critical section.
    // The gate branch below re-derives its own condition from the latest state;
    // a scope frozen for a branch that is not taken is simply dropped.
    const frozenApprovalScope = await freezeApprovalScope(
      input,
      currentExecution,
    );

    const {
      execution: persistedExecution,
      consecutiveFailureCount,
      remainingTaskCount,
      completedTaskCount,
      decision,
      iterationNumber,
      finalizationWithheldMissingOutput,
      approvalRequestedAt,
      withheldContextStatus,
    } = await deps.executionRepository
      .mutateActive<{
        consecutiveFailureCount: number;
        remainingTaskCount: number;
        completedTaskCount: number;
        decision: ContextDecision;
        iterationNumber: number;
        finalizationWithheldMissingOutput: boolean;
        approvalRequestedAt: string | null;
        withheldContextStatus: "ready" | "pending" | "halted" | null;
      }>(input.projectPath, input.sessionName, (latest) => {
        let completedTaskCount = 0;
        let remainingTaskCount = 0;
        let needsTaskIteration = false;
        let decision: ContextDecision = { kind: "ready_to_land" };
        let iterationNumber = 0;
        let consecutiveFailureCount = 0;
        let approvalRequestedAt: string | null = null;
        let withheldContextStatus: "ready" | "pending" | "halted" | null = null;
        let finalizationWithheldMissingOutput = false;

        const finalizedExecution = structuredClone(latest);
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

        consecutiveFailureCount =
          finalizedContextState.consecutiveFailureCount ?? 0;

        remainingTaskCount = countRemainingTasks(
          finalizedExecution,
          input.contextId,
        );
        completedTaskCount = finalizedContextState.completedTaskCount;
        needsTaskIteration = remainingTaskCount > 0;
        decision = needsTaskIteration
          ? { kind: "continue", reason: "tasks_remaining" }
          : { kind: "ready_to_land" };
        iterationNumber = finalizedContextState.iterationCount;

        // Another writer has already taken this context back for a FRESH
        // iteration — retryable-error recovery and pause-to-edit both return it
        // to a schedulable status. Neither halts the run, so the mid-flight
        // guard above cannot see it: recovery deliberately clears `haltReason`
        // and leaves `execution.status` on "running". This iteration no longer
        // owns the context, so every outcome it would write is stale — and
        // `completed` is worse than stale, because the transition table refuses
        // `ready` -> `completed` and the throw escapes the write queue as an
        // `execution_loop_failed` halt, turning a recoverable error into a dead
        // run. Leave the context wherever the new owner put it, and yield ownership so this iteration's caller stops rather than racing the
        // re-dispatch.
        //
        // A pending halt can leave the execution running while the context is
        // halted. Its owner has withdrawn permission to finalize; only resume
        // may return that context to work.
        if (
          finalizedContextState.status === "ready" ||
          finalizedContextState.status === "pending" ||
          finalizedContextState.status === "halted"
        ) {
          withheldContextStatus = finalizedContextState.status;
          needsTaskIteration = false;
          const haltReason =
            finalizedExecution.pendingHaltReason ??
            finalizedExecution.haltReason;
          decision =
            finalizedContextState.status === "halted" && haltReason
              ? { kind: "halted", haltReason }
              : { kind: "yield", reason: "superseded" };
          finalizedExecution.machineSnapshot = buildLifecycleSnapshot(
            finalizedExecution,
            { hasLiveIteration: false },
          );
          return changed(finalizedExecution, {
            consecutiveFailureCount,
            remainingTaskCount,
            completedTaskCount,
            decision,
            iterationNumber,
            finalizationWithheldMissingOutput,
            approvalRequestedAt,
            withheldContextStatus,
          });
        }

        // A context only reaches the no-remaining-tasks branch after every
        // enabled validator passed (failures reopen tasks), so the gate
        // decision reduces to the resolved per-context config.
        const gateEnabled =
          finalizedExecution.workingDefinition.executionContexts.find(
            (entry) => entry.id === input.contextId,
          )?.humanApprovalGate.enabled ?? false;

        if (needsTaskIteration) {
          transitionContextStatus(
            finalizedExecution,
            input.contextId,
            "running",
            {
              reason: "iteration.finalize_continue",
            },
          );
        } else if (contextOwesOutput(finalizedExecution, input.contextId)) {
          // The output contract or candidate can change after certification.
          // Completion requires the currently declared output to be published.
          finalizationWithheldMissingOutput = true;
          const haltReason =
            finalizedExecution.pendingHaltReason ??
            finalizedExecution.haltReason;
          decision = haltReason
            ? { kind: "halted", haltReason }
            : { kind: "continue", reason: "output_capture_retry" };
        } else if (gateEnabled) {
          decision = { kind: "await_approval" };
          approvalGateService.enterAwaitingApproval(finalizedExecution, {
            contextId: input.contextId,
            conversationId,
            approvalScope: frozenApprovalScope,
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
        finalizedExecution.activeContextIds = needsTaskIteration
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
        const collaboration =
          finalizedExecution.pendingCollaborations?.[input.contextId];
        if (collaboration) {
          decision = {
            kind: "await_collaboration",
            workflowId: collaboration.workflowId,
          };
        }
        if (approvalRequestedAt !== null) {
          const delivery = eventPublisher.publishApprovalPending({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: finalizedExecution,
            contextId: input.contextId,
            conversationId,
            requestedAt: approvalRequestedAt,
          });
          return changed(
            finalizedExecution,
            {
              consecutiveFailureCount,
              remainingTaskCount,
              completedTaskCount,
              decision,
              iterationNumber,
              finalizationWithheldMissingOutput,
              approvalRequestedAt,
              withheldContextStatus,
            },
            { ...delivery },
          );
        }
        return changed(finalizedExecution, {
          consecutiveFailureCount,
          remainingTaskCount,
          completedTaskCount,
          decision,
          iterationNumber,
          finalizationWithheldMissingOutput,
          approvalRequestedAt,
          withheldContextStatus,
        });
      })
      .then((mutation) => ({
        execution: mutation.execution,
        ...mutationValue(mutation),
      }));
    if (withheldContextStatus !== null) {
      const withheldReason =
        withheldContextStatus === "halted"
          ? "context_halted"
          : "context_rescheduled";
      execLogger?.iteration(
        input.contextId,
        "iteration.finalize_withheld_context_rescheduled",
        {
          conversationId,
          status: withheldContextStatus,
          reason: withheldReason,
        },
      );
      logger.info("graph-workflow.iteration.finalize_withheld", {
        executionId: persistedExecution.id,
        contextId: input.contextId,
        reason: withheldReason,
        status: withheldContextStatus,
      });
    }

    if (finalizationWithheldMissingOutput) {
      execLogger?.iteration(
        input.contextId,
        "iteration.finalize_withheld_missing_output",
        { conversationId },
      );
      logger.warn("graph-workflow.iteration.finalize_withheld", {
        executionId: persistedExecution.id,
        contextId: input.contextId,
        reason: "output_not_captured",
      });
    }

    execLogger?.iteration(input.contextId, "iteration.completed", {
      conversationId,
      iterationNumber,
      completedTaskCount,
      remainingTaskCount,
      decision,
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
            decision,
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
      return {
        conversationId,
        execution: persistedExecution,
        decision,
      };
    }

    return {
      conversationId,
      execution: persistedExecution,
      decision,
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

    const conversationId = pickConversationIdForValidationOnlyIteration(
      initialExecution,
      input.contextId,
    );
    const validation = await contextValidation.evaluateExit({
      ...input,
      conversationId,
      laneConversationId: undefined,
    });
    const parkedResult =
      validation.decision.kind === "certified"
        ? null
        : { ...validation, decision: validation.decision };

    // A validator that asked during the re-entry path parks the context, and a
    // refused output capture keeps it running; both short-circuit finalize
    // (Req 3.2, 3.3).
    if (parkedResult !== null) {
      return parkedResult;
    }

    return finalizeIterationResult({
      input,
      execLogger,
      conversationId,
    });
  }

  async function runIteration(
    input: GraphWorkflowIterationInput,
  ): Promise<GraphWorkflowIterationResult> {
    let initialExecution = await requireExecution(
      input.projectPath,
      input.sessionName,
    );

    // Shared documents may have been published by another lane; the central
    // store carries those uncommitted files to every execution target.
    if (input.executionTarget) {
      try {
        initialExecution = await deps.materializeWorkflowDocuments({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: initialExecution,
          worktreePath: input.executionTarget.worktreePath,
        });
      } catch (err) {
        if (err instanceof StaleLoopFenceError) throw err;
        logger.warn("graph-workflow.iteration.materialize_failed", {
          executionId: initialExecution.id,
          contextId: input.contextId,
          worktreePath: input.executionTarget.worktreePath,
          error: getErrorMessage(err),
        });
        throw new WorkflowDocumentDeliveryError(input.contextId, err);
      }
    }

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
      await resolveLatestContextValidationFailureFeedback(
        deps,
        input.projectPath,
        input.sessionName,
        initialExecution,
        input.contextId,
      );

    execLogger?.iteration(input.contextId, "iteration.started", {
      iterationNumber:
        (initialExecution.contextStates[input.contextId]?.iterationCount ?? 0) +
        1,
      incompleteTaskCount: incompleteTasks.length,
      incompleteTaskIds: incompleteTasks.map((t) => t.id),
      modelId: context.implementer.agent.modelSelection.modelId,
      parameterIds: Object.keys(
        context.implementer.agent.modelSelection.parameters,
      ).sort(),
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
        backend: context.implementer.agent.backend,
        // An implementer edited under the running execution rotates its lane:
        // the seeded conversation already replayed the superseded profile
        // block, so a resumed handle would run bytes nobody chose (R11).
        assignmentFingerprint: assignmentFingerprint({
          profileSnapshot: context.implementer.profileSnapshot,
          agent: context.implementer.agent,
          continuity: context.iterationPolicy.continuity,
        }),
        // The lane runs the bytes the execution was seeded with, not a fresh
        // resolution: a lane created (or rotated) after a library edit or
        // deletion must be unaffected by it (R4).
        profileSnapshot: context.implementer.profileSnapshot,
        pinnedConversationId: implementerResumeEntry(input)?.conversationId,
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
        {
          role: "iteration",
          profileSnapshot: context.implementer.profileSnapshot,
        },
      );
      conversationId = conversation.id;
    }

    execLogger?.iteration(input.contextId, "iteration.conversation_resolved", {
      conversationId,
      promptMode,
      sessionAction: deps.continuityService ? "continuity_managed" : "fresh",
    });

    const conversation = { id: conversationId };
    const seededExecution = await deps.executionRepository
      .mutateActive(input.projectPath, input.sessionName, (latest) => {
        const next = structuredClone(latest);
        const seededContextState = next.contextStates[input.contextId];
        if (!seededContextState) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }

        // The cohort owns the candidate while a round is open, and the
        // implementer's whole job is to change it. The engine's within-context
        // serialization already keeps the two apart; this is the structural
        // guard that makes a violation loud instead of silently handing a
        // reviewer a tree that is being rewritten underneath it.
        const latestRound = seededContextState.validationRound ?? null;
        if (latestRound !== null && isValidationRoundOpen(latestRound)) {
          throw new Error(
            `Cannot seed the implementer for execution context "${input.contextId}": validation round ${latestRound.seq} still owns the candidate.`,
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
        Object.assign(
          seededContextState,
          accountContextAction(seededContextState, {
            kind: "iteration_started",
          }),
        );
        bindConversationToIncompleteTasks(
          next,
          input.contextId,
          conversation.id,
          getNow(deps),
        );
        next.machineSnapshot = buildLifecycleSnapshot(next, {
          hasLiveIteration: true,
        });
        return changed(next);
      })
      .then((mutation) => mutation.execution);
    const seededContextState = seededExecution.contextStates[input.contextId];
    if (!seededContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }
    // The definition as of the SEED COMMIT, not as of the snapshot this
    // iteration opened with. Until that commit lands, the context's persisted
    // lifecycle still reads `unstarted`, so the live-edit core can validly
    // accept a placement change for it while this function is awaiting
    // conversation resolution — and there is no later turn such an edit could
    // belong to. The seed carries the edit forward (it clones the latest
    // execution and touches only runtime state), so this read observes it;
    // dispatching the pre-await snapshot instead would run the turn under the
    // superseded envelope. Everything committed after the seed sees `started`
    // and is pause-to-edit, which the next turn's own re-read picks up.
    const seededContext = getContextDefinition(
      seededExecution,
      input.contextId,
    );
    const scopedCharter = seededContext.charter
      ? resolveScopedCharterForContext({
          execution: seededExecution,
          contextId: input.contextId,
          charter: seededContext.charter,
        })
      : undefined;
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
      await deps.executionRepository
        .mutateActive(input.projectPath, input.sessionName, (latest) => {
          const next = structuredClone(latest);
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
          return changed(next);
        })
        .then((mutation) => mutation.execution);
      execLogger?.iteration(input.contextId, "collaboration.delivered", {
        workflowIds: collaborationContinuationWorkflowIds,
      });
      logger.info("graph-workflow.collaboration.delivered", {
        executionId: seededExecution.id,
        contextId: input.contextId,
        workflowIds: collaborationContinuationWorkflowIds,
      });
    }

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
    }

    const MAX_FOLLOW_UPS = 2;
    let completedTurnCount = 0;
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
      return parkContextForUserInput(
        { executionRepository: deps.executionRepository, userInputGateService },
        {
          input,
          execLogger,
          lanes: [
            {
              laneKey: laneStateKey("implementer"),
              conversationId: conversation.id,
              questionBatchId: pendingQuestionId,
              questions: laneConversation?.pendingQuestions ?? [],
            },
          ],
          conversationId: conversation.id,
          restoreIterationCount: iterationCountBeforeSeed,
        },
      );
    }

    try {
      const agentCallBase = {
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        executionId: seededExecution.id,
        conversationId: conversation.id,
        contextId: input.contextId,
        backend: context.implementer.agent.backend,
        modelSelection: context.implementer.agent.modelSelection,
        executionTarget: input.executionTarget,
        askUserQuestionsEnabled: context.askUserQuestions.enabled,
        // Read from the atomically seeded definition, so this is the placement
        // as of the moment this context became `started` — including an edit
        // accepted since the previous turn, and including one that landed
        // inside this iteration's own start-up window. Follow-up turns reuse
        // this base, which is the same boundary the editability tiers draw: a
        // started context is pause-to-edit, so its ownership cannot change
        // underneath a turn already in flight. Absent only for an execution
        // seeded before placement existed; every authored context declares one.
        ...(seededContext.placement !== undefined
          ? { placement: seededContext.placement }
          : {}),
      } as const;

      async function recordTurnOutcome(
        agentResult: GraphWorkflowAgentIterationResult,
      ): Promise<void> {
        const continuityService = deps.continuityService;
        if (!continuityService) return;
        const contextLimitTokens =
          context.iterationPolicy.continuity.contextLimitTokens;
        const latest = await requireCurrentExecution(
          deps.executionRepository,
          input.projectPath,
          input.sessionName,
        );
        if (latest.status !== "running") {
          return;
        }
        const laneBackend = context.implementer.agent.backend;
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
      const implementerResume = implementerResumeEntry(input);
      const resumeUserInputPrompt = implementerResume
        ? {
            questionBatchId: implementerResume.questionBatchId,
            answers: implementerResume.answers,
          }
        : undefined;
      // The frozen seed-time snapshot decides the enabled set; the registry
      // read feeds only cost annotation and the disabled list, and a failed
      // read renders an explicit "registry unavailable" notice instead of
      // silently dropping the section.
      const validationSelections = resolveValidationPromptSelections({
        role: "implementer",
        context,
        registry: await loadValidationPromptRegistry(async () => {
          const repoConfig = await deps.readRepoConfig(input.projectPath);
          return repoConfig?.validation;
        }),
      });

      const basePrompt =
        promptMode === "follow_up"
          ? buildFollowUpPrompt({
              remainingTasks: initialTasks,
              taskStates: seededExecution.taskStates,
              attemptNumber: 1,
              maxAttempts: MAX_FOLLOW_UPS,
              latestContextValidationFailure,
              collaborationContinuations,
              allowAgentCollaboration,
              charter: scopedCharter,
              charterAmendments: seededExecution.charterAmendments,
              resumeUserInput: resumeUserInputPrompt,
              askUserQuestionsEnabled: context.askUserQuestions.enabled,
            })
          : buildIterationPrompt({
              context,
              tasks: initialTasks,
              taskStates: seededExecution.taskStates,
              sharedDocuments: initialExecution.sharedDocuments,
              allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
              charter: scopedCharter,
              // Scoped sources bind authored ids: a loop-instance context
              // renders the charter section under its authored template id,
              // same as invariants.
              charterContextId:
                resolveLogicalAuthoredContextId({
                  execution: seededExecution,
                  contextId: input.contextId,
                }) ?? input.contextId,
              askUserQuestionsEnabled: context.askUserQuestions.enabled,
              allowAgentCollaboration,
              // Passed in its stored shape (prose or records); the prompt
              // builder renders the numbered record list via the criteria
              // helper.
              contextValidationAcceptanceCriteria: context.contextValidator
                .enabled
                ? context.acceptanceCriteria
                : undefined,
              latestContextValidationFailure,
              collaborationContinuations,
              resumeUserInput: resumeUserInputPrompt,
              previousConversationHandoff,
              validationSelections,
              // What this context receives (D2 Req 5) — the same resolver the
              // inspector UI and, later, D4 conditional edges read.
              upstreamInputs: resolveUpstreamInputs(
                seededExecution,
                input.contextId,
              ),
              // Prior passes of this loop (R16.1) — null for every context that
              // is not a pass ENTRY, so ordinary upstream injection stays the
              // only channel for same-pass body contexts.
              loopHistory: resolveLoopHistory(seededExecution, input.contextId),
            });
      const initialPrompt = await composeGraphRolePrompt({
        execution: seededExecution,
        executionContract,
        prompt: basePrompt,
        role: "implementer",
        contextId: input.contextId,
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
        modelId: context.implementer.agent.modelSelection.modelId,
        parameterIds: Object.keys(
          context.implementer.agent.modelSelection.parameters,
        ).sort(),
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
      //   2. After every agent turn the orchestrator first preserves any
      //      question the turn registered, then inspects `pendingHaltReason`.
      //      A parked question ends the iteration while retaining the halt for
      //      the outer drain; otherwise the halt terminates with
      //      `IterationHaltedError`. Either path guarantees R5.3 ("no further
      //      tool calls in the iteration") at the turn boundary.
      async function checkPendingHaltOrThrow(
        turnLabel: "initial_turn" | "follow_up_turn",
        attempt: number,
      ): Promise<void> {
        const latest = await requireCurrentExecution(
          deps.executionRepository,
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

      async function parkQuestionBeforePendingHalt(
        turnLabel: "initial_turn" | "follow_up_turn",
        attempt: number,
      ): Promise<GraphWorkflowIterationResult | null> {
        const result = await parkContextIfQuestionPending();
        if (result === null || result.execution.pendingHaltReason === null) {
          return result;
        }
        const pendingHaltReason = result.execution.pendingHaltReason;

        execLogger?.iteration(
          input.contextId,
          "iteration.question_parked_during_halt_drain",
          {
            haltReasonType: pendingHaltReason.type,
            turnLabel,
            attempt,
          },
        );
        logger.info(
          "graph-workflow.iteration.question_parked_during_halt_drain",
          {
            executionId: result.execution.id,
            contextId: input.contextId,
            haltReasonType: pendingHaltReason.type,
            turnLabel,
            attempt,
          },
        );
        return result;
      }

      async function hasPendingCollaboration(
        turnLabel: "initial_turn" | "follow_up_turn",
        attempt: number,
      ): Promise<boolean> {
        const latest = await requireCurrentExecution(
          deps.executionRepository,
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
        // A configured window size does not make cumulative processed tokens
        // an occupancy measurement; the backend declares measurement semantics.
        occupancyMeasurable:
          getBackendDescriptor(context.implementer.agent.backend).conversation
            ?.capabilities.contextWindowMetrics === true &&
          agentResult.contextTokens !== null &&
          agentResult.contextWindowMax !== null,
        backend: context.implementer.agent.backend,
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

      // Preserve a registered question before enforcing a halt written by a
      // sibling during this turn. The parked record survives the outer loop's
      // drain-and-halt transition, while the pending halt still prevents any
      // follow-up turn from being dispatched.
      parkedResult = await parkQuestionBeforePendingHalt("initial_turn", 0);
      if (parkedResult === null) {
        await checkPendingHaltOrThrow("initial_turn", 0);
        stoppedForCollaboration = await hasPendingCollaboration(
          "initial_turn",
          0,
        );
      }

      // Follow-up loop: re-message if there are still incomplete tasks
      for (
        let attempt = 1;
        parkedResult === null &&
        !stoppedForCollaboration &&
        attempt <= MAX_FOLLOW_UPS;
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

        const midExecution = await requireCurrentExecution(
          deps.executionRepository,
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

        const baseFollowUpPrompt = buildFollowUpPrompt({
          remainingTasks: remaining,
          taskStates: midExecution.taskStates,
          attemptNumber: attempt,
          maxAttempts: MAX_FOLLOW_UPS,
          latestContextValidationFailure:
            await resolveLatestContextValidationFailureFeedback(
              deps,
              input.projectPath,
              input.sessionName,
              midExecution,
              input.contextId,
            ),
          collaborationContinuations: [],
          allowAgentCollaboration,
          charter: scopedCharter,
          charterAmendments: midExecution.charterAmendments,
          askUserQuestionsEnabled: context.askUserQuestions.enabled,
        });
        const followUpPrompt = await composeGraphRolePrompt({
          execution: midExecution,
          executionContract,
          prompt: baseFollowUpPrompt,
          role: "implementer",
          contextId: input.contextId,
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
            occupancyMeasurable:
              getBackendDescriptor(context.implementer.agent.backend)
                .conversation?.capabilities.contextWindowMetrics === true &&
              agentResult.contextTokens !== null &&
              agentResult.contextWindowMax !== null,
            backend: context.implementer.agent.backend,
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

        parkedResult = await parkQuestionBeforePendingHalt(
          "follow_up_turn",
          attempt,
        );
        if (parkedResult !== null) {
          break;
        }

        await checkPendingHaltOrThrow("follow_up_turn", attempt);
        stoppedForCollaboration = await hasPendingCollaboration(
          "follow_up_turn",
          attempt,
        );
      }

      if (!stoppedForCollaboration && parkedResult === null) {
        const validation = await contextValidation.evaluateExit({
          ...input,
          conversationId: conversation.id,
          laneConversationId: conversation.id,
        });
        parkedResult =
          validation.decision.kind === "certified"
            ? null
            : { ...validation, decision: validation.decision };
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
        await settleOrdinaryIterationTermination(input);
      }
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
    });
  }

  return { runIteration };
}
