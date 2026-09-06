import { randomUUID } from "node:crypto";
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
  type GraphWorkflowTaskValidationFailure,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowCollaborationContinuation } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  ContextPlacement,
  GraphWorkflowResolvedContext,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
  GraphWorkflowValidationIssue,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowContextOutputCaptureOutcome } from "@/lib/workflow-graph/context-output-capture";
import {
  COHORT_SPECIALIST_ATTEMPTS,
  type CohortCarriedProgress,
  type CohortLaneProgress,
  type RetainedCohortLane,
} from "@/lib/workflow-graph/validation-cohort";
import {
  CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET,
  resolveConsecutiveFailureThreshold,
} from "./constants";
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
import {
  createGraphWorkflowValidationService,
  type CohortSpecialistVerdict,
  type GraphWorkflowValidationService,
  type ValidationRoundDispatch,
} from "@/lib/workflow-graph/execution-validation";
import { selectRunnableCohortAssignments } from "@/lib/workflow-graph/config-schemas";
import {
  admitSpecialists,
  candidateIdentityMatches,
  concludeValidationRound,
  describeCandidateDrift,
  freezeValidationCandidate,
  isValidationRoundOpen,
  openValidationRound,
  reconcileValidationRoster,
  selectRecertificationAssignments,
  type ValidationCandidateTreeResolution,
  type ValidationRoundOutcome,
} from "@/lib/workflow-graph/validation-round";
import { candidateScopeForPlacement } from "@/lib/workflow-graph/validation-diff-scope";
import type { CandidateScope } from "@/lib/git/diff";
import type {
  GraphWorkflowAdvisoryResponsePhase,
  GraphWorkflowContextOutput,
  GraphWorkflowExecutionContextState,
  GraphWorkflowValidationAdvisory,
  GraphWorkflowValidationCandidate,
  GraphWorkflowValidationIncidentStage,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";
import {
  advisoryIdentityKey,
  buildAdvisoryFailureAppendix,
  collectFreshAdvisories,
  stampAdvisoryIdentities,
  type RecordedAdvisoryDisposition,
} from "@/lib/workflow-graph/advisory-delivery";
import { indexAdvisoriesForSeat } from "@/lib/workflow-graph/advisory-index";
import type {
  GraphWorkflowAdvisoryResponseInput,
  GraphWorkflowAdvisoryResponseOutcome,
} from "@/lib/workflow-graph/advisory-response-runner";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
} from "@/lib/workflow-graph/execution-events";
import {
  deriveGraphWorkflowValidationSpecialistUsage,
  type GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
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
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import {
  loadValidationPromptRegistry,
  resolveValidationPromptSelections,
} from "./validation-prompt-section";
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
import {
  assignmentFingerprint,
  laneStateKey,
} from "@/lib/workflow-graph/lane-identity";
import { answeredPendingUserInputs } from "@/lib/workflow-graph/pending-user-input";
import {
  createRegisteredGraphExecutionContract,
  type GraphExecutionContract,
} from "./execution-contract-port";
import { composeGraphRolePrompt } from "./prompt-composer";

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
  modelSelection: BackendModelSelection;
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
  signal?: AbortSignal;
}

interface IterationOrchestratorScriptValidatorService {
  runScriptValidator(
    input: IterationOrchestratorScriptValidatorInput,
  ): Promise<ScriptValidatorOutcome>;
}

export interface IterationOrchestratorValidationRoundService {
  /**
   * Resolve the git identity of the candidate this context's validators will
   * inspect, under `candidateScope`. Reports unavailability as its own result
   * rather than throwing or fabricating an identity: the engine treats an
   * unreadable candidate as an infrastructure outcome, because a round that
   * cannot say what it reviewed cannot be the deterministic thing a round is for.
   *
   * The scope is supplied per call rather than resolved inside, so the freeze and
   * every later re-read of one context provably ask the same question.
   */
  resolveCandidateTree(input: {
    projectPath: string;
    sessionName: string;
    contextId: string;
    candidateScope: CandidateScope;
    executionTarget?: ExecutionTarget;
  }): Promise<ValidationCandidateTreeResolution>;
}

/**
 * How many times the freeze re-probes an unreadable candidate before halting.
 * Above one so a transient git blip does not end a workflow; small, because
 * every attempt after the first is evidence the failure is not transient.
 */
const CANDIDATE_RESOLVE_ATTEMPTS = 2;

export interface GraphWorkflowContextOutputCaptureInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  /** The context's lane conversation — the format turn rides it so the payload
   *  is restated from the work context rather than re-derived. */
  conversationId: string;
  outputSchema: Record<string, unknown>;
  executionTarget?: ExecutionTarget;
  /** The rejection recorded for this context's previous capture attempt, when
   *  one exists, so the retry turn sees what the gate refused. */
  previousRejection?: {
    summary: string;
    issues: readonly GraphWorkflowValidationIssue[];
  };
}

interface IterationOrchestratorOutputCaptureService {
  captureContextOutput(
    input: GraphWorkflowContextOutputCaptureInput,
  ): Promise<GraphWorkflowContextOutputCaptureOutcome>;
}

interface IterationOrchestratorAdvisoryResponseService {
  runAdvisoryResponse(
    input: GraphWorkflowAdvisoryResponseInput,
  ): Promise<GraphWorkflowAdvisoryResponseOutcome>;
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
  createToolServer(
    input: GraphWorkflowIterationToolServerInput,
  ): GraphWorkflowIterationToolServer;
  runAgentIteration(
    input: GraphWorkflowRunAgentIterationInput,
  ): Promise<GraphWorkflowAgentIterationResult>;
  executionContract?: GraphExecutionContract;
  signalHalt?(
    input: GraphWorkflowSignalHaltInput,
  ): Promise<GraphWorkflowExecution>;
  continuityService?: IterationOrchestratorContinuityService;
  validationService?: GraphWorkflowValidationService;
  scriptValidatorService?: IterationOrchestratorScriptValidatorService;
  /**
   * Resolves the git half of a validation round's candidate identity. Absent
   * leaves rounds with a task-state-only identity: honest for a context with no
   * resolvable worktree, and the reason the round machinery never depends on
   * git being reachable.
   */
  validationRoundService?: IterationOrchestratorValidationRoundService;
  /**
   * Dispatches the D2 format turn for a context that declares an
   * `outputSchema`. Absent (or a context without a schema) leaves the exit
   * evaluator exactly as it was — the context finalizes on validator pass.
   */
  outputCaptureService?: IterationOrchestratorOutputCaptureService;
  /**
   * Dispatches the advisory-response turn a passing round with fresh advisories
   * owes the implementer (D6). Absent leaves a passing round's advisories
   * undelivered rather than marking them delivered to a turn nobody ran; the
   * failing path is unaffected, since it rides messages the engine already sends.
   */
  advisoryResponseService?: IterationOrchestratorAdvisoryResponseService;
  approvalGateService?: ApprovalGateService;
  /**
   * Gate that owns the `pendingUserInputs` lifecycle. The orchestrator calls
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
  /**
   * Reads `CommandCenter.json` so the seed prompt can list the context's
   * effective command selections with costs (validation-concurrency §8).
   * Degraded-not-fatal: a read failure renders explicit empty selections.
   */
  readRepoConfig?: typeof defaultReadRepoConfig;
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
   * Set when the loop resumes a context after its parked questions were
   * answered. Each entry names the lane that asked: the asking conversation is
   * pinned (rotation still outranks) and the answers block is embedded in that
   * lane's resumed prompt — the follow-up (pinned) or seed (rotated)
   * implementer prompt, or the asking validator's prompt (5.1, 5.3, 5.5).
   *
   * A list because a cohort's validators park independently and may be answered
   * together; each lane sees only its own answers.
   */
  resumeUserInputs?: readonly ResumeUserInputContext[];
  signal?: AbortSignal;
}

/** The implementer's answers, if this resume carries any. One lane per context. */
function implementerResumeEntry(
  input: GraphWorkflowIterationInput,
): ResumeUserInputContext | undefined {
  return input.resumeUserInputs?.find((entry) => entry.lane === "implementer");
}

/** The validator lanes' answers, in the order the gate consumed them. */
function validatorResumeEntries(
  input: GraphWorkflowIterationInput,
): ResumeUserInputContext[] {
  return (input.resumeUserInputs ?? []).filter(
    (entry) => entry.lane === "context_validator",
  );
}

export interface GraphWorkflowIterationResult {
  conversationId: string;
  execution: GraphWorkflowExecution;
  shouldContinueInContext: boolean;
}

export class IterationHaltedError extends Error {
  readonly haltReason: GraphWorkflowHaltReason;
  readonly syntheticToolResults?: readonly ToolResultBlock[];
  /**
   * Set when the thrower has completed failure accounting for this halt.
   * This includes failures already written to `consecutiveFailureCount` and
   * infrastructure/configuration halts that must not count as failures. Both
   * iteration loops swallow this error and finalize; the finalizer otherwise
   * counts a swallowed halt as a fresh failure.
   */
  readonly failureAlreadyCounted: boolean;

  constructor(
    haltReason: GraphWorkflowHaltReason,
    syntheticToolResults?: readonly ToolResultBlock[],
    options: { failureAlreadyCounted?: boolean } = {},
  ) {
    super(`Iteration halted: ${haltReason.type}`);
    this.name = "IterationHaltedError";
    this.haltReason = haltReason;
    this.failureAlreadyCounted = options.failureAlreadyCounted === true;
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

/**
 * The per-task remediation messages a rejected round sends back, plus the
 * round's fresh advisories.
 *
 * The advisories ride the FIRST reopened task's message rather than every one of
 * them: the seed prompt renders each reopened task's failure message in the same
 * turn, so repeating a context-level, non-binding list once per task would
 * restate it N times in one prompt. Which task carries it is arbitrary and the
 * heading says so — `reopenTaskIds` is deterministic (cohort order, deduped), so
 * the choice at least never varies between two runs of the same round.
 */
function buildTaskFailureMessages(input: {
  summary: string;
  issues: readonly GraphWorkflowValidationIssue[];
  reopenTaskIds: string[];
  advisories?: readonly GraphWorkflowValidationAdvisory[];
}): Record<string, string> {
  const scopedIssuesByTaskId = new Map<
    string,
    GraphWorkflowValidationIssue[]
  >();
  for (const issue of input.issues) {
    if (!issue.taskId) {
      continue;
    }

    const issues = scopedIssuesByTaskId.get(issue.taskId) ?? [];
    issues.push(issue);
    scopedIssuesByTaskId.set(issue.taskId, issues);
  }

  // Several reviewers can raise indistinguishable findings, so a remediation
  // list that named none of them would read as one reviewer repeating itself
  // and give the implementer no way to weigh two objections separately. A round
  // with a single reviewer needs no such disambiguation and keeps the message
  // it has always had.
  const attributed =
    new Set(input.issues.map((issue) => issue.assignmentId)).size > 1;
  const renderIssue = (issue: GraphWorkflowValidationIssue): string =>
    attributed && issue.assignmentId
      ? `- [${issue.assignmentId}] ${issue.title}: ${issue.description}`
      : `- ${issue.title}: ${issue.description}`;

  const advisories = input.advisories ?? [];
  const advisoryCarrier = advisories.length > 0 ? input.reopenTaskIds[0] : null;

  return Object.fromEntries(
    input.reopenTaskIds.map((taskId) => {
      const scopedIssues = scopedIssuesByTaskId.get(taskId) ?? [];
      const appendix =
        taskId === advisoryCarrier
          ? [buildAdvisoryFailureAppendix(advisories)]
          : [];
      return [
        taskId,
        [input.summary, ...scopedIssues.map(renderIssue), ...appendix].join(
          "\n",
        ),
      ];
    }),
  );
}

/**
 * Stamp the named advisories delivered, in place, on an open round record.
 *
 * Keyed by identity rather than by position because the caller holds identities
 * read before the mutation, and the record it writes into is the one loaded
 * inside it. An identity the round does not carry is skipped in silence: it
 * belongs to a round this one superseded, and the enclosing mutation's own
 * supersession guard is what decides whether the write survives at all.
 */
function markAdvisoriesDelivered(
  round: GraphWorkflowValidationRound | null,
  identities: readonly WorkflowAdvisoryIdentity[],
  deliveredAt: string,
): void {
  if (round === null || identities.length === 0) return;
  const keys = new Set(identities.map(advisoryIdentityKey));
  for (const specialist of Object.values(round.specialists)) {
    for (const advisory of specialist.advisories) {
      if (!keys.has(advisoryIdentityKey(advisory.identity))) continue;
      advisory.deliveredAt = deliveredAt;
    }
  }
}

/**
 * Write the implementer's answers onto the advisories they answer, in place.
 *
 * On the advisory itself rather than in a ledger beside it: a disposition is a
 * fact about one advisory, and the pair can then only be read together (R7).
 */
function recordAdvisoryDispositions(
  round: GraphWorkflowValidationRound,
  dispositions: readonly RecordedAdvisoryDisposition[],
  recordedAt: string,
): void {
  const byIdentity = new Map(
    dispositions.map((entry) => [advisoryIdentityKey(entry.identity), entry]),
  );
  for (const specialist of Object.values(round.specialists)) {
    for (const advisory of specialist.advisories) {
      const entry = byIdentity.get(advisoryIdentityKey(advisory.identity));
      if (entry === undefined) continue;
      advisory.disposition = {
        outcome: entry.disposition,
        reason: entry.reason,
        recordedAt,
      };
    }
  }
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
  const executionContract =
    deps.executionContract ?? createRegisteredGraphExecutionContract();
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
    return resolveConsecutiveFailureThreshold(contextDef?.circuitBreaker);
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
    /**
     * Advisories this rejection's messages carry. Stamped delivered in the same
     * mutation that writes those messages, because the two are one act: a
     * separate write could leave a round whose advisories are marked delivered
     * on a reopen that was refused, and the implementer would never see them.
     */
    deliveredAdvisories?: readonly WorkflowAdvisoryIdentity[];
    publishValidationEvent?: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowEventDelivery;
    /**
     * Refuses the whole write when the round this rejection belongs to is no
     * longer the round the context is on, publishing the given incident in its
     * place. Inside the mutation because that is the only place where "is it
     * still current" and "reopen the tasks" cannot be separated by a race.
     */
    refuseIfSuperseded?: (
      execution: GraphWorkflowExecution,
    ) => GraphWorkflowEventDelivery | null;
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

        const refusal = input.refuseIfSuperseded?.(nextExecution) ?? null;
        if (refusal !== null) {
          return {
            execution: latest,
            events: refusal.events,
            pushes: refusal.pushes,
          };
        }

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
          markAdvisoriesDelivered(
            contextState.validationRound ?? null,
            input.deliveredAdvisories ?? [],
            failureTimestamp,
          );
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
      "Pre-merge validation failed. The script validator runs the context's selected registered commands to catch deterministic problems (tests, type errors, lint, build, etc.).",
      "",
      `Summary: ${summary}`,
      "",
      `Read the full output at \`${logRelativePath}\` (relative to the worktree root) and address the issues.`,
      "",
      "When you believe the issues are resolved, mark this task complete. The selected validation commands will run again to confirm.",
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
    /**
     * Where this stage records that the round ended on a deterministic script
     * failure. Written here rather than by the caller because this stage can
     * exit by halting — a failure that trips the breaker never returns — and a
     * round released by the halt still has to say why it ended.
     */
    journal: RoundJournal;
  }): Promise<"pass" | "skip" | "fail"> {
    const { input, execLogger, execution, onHalt, journal } = params;
    const contextDef = getContextDefinition(execution, input.contextId);
    const configuredCommands = contextDef.scriptValidator.commands;
    if (configuredCommands.length === 0) {
      return "skip";
    }
    if (contextDef.placement.mode !== "full") {
      execLogger?.validation(
        input.contextId,
        "script_validation.deferred_to_lane_merge",
        { commandCount: configuredCommands.length },
      );
      logger.info("graph-workflow.script_validation.deferred_to_lane_merge", {
        executionId: execution.id,
        contextId: input.contextId,
        placementMode: contextDef.placement.mode,
        commandCount: configuredCommands.length,
      });
      return "skip";
    }

    if (!deps.scriptValidatorService) {
      throw new Error(
        "Script validator commands are selected for this context but no scriptValidatorService is configured",
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
      signal: input.signal,
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
      if (outcome.readinessBlock) {
        const haltReason: GraphWorkflowHaltReason = {
          type: "infrastructure_blocked",
          contextId: input.contextId,
          ...outcome.readinessBlock,
          message: outcome.message,
        };
        journal.leaveOpen = true;
        execLogger?.validation(
          input.contextId,
          "script_validation.infrastructure_blocked",
          { ...outcome.readinessBlock, message: outcome.message },
        );
        logger.warn("graph-workflow.script_validation.infrastructure_blocked", {
          executionId: execution.id,
          contextId: input.contextId,
          ...outcome.readinessBlock,
          detail: outcome.message,
        });
        await onHalt(haltReason);
        throw new IterationHaltedError(haltReason, undefined, {
          failureAlreadyCounted: true,
        });
      }
      if (outcome.reason === "unknown_command") {
        execLogger?.validation(
          input.contextId,
          "script_validation.unknown_command",
          { command: outcome.commandName, message: gate.reason },
        );
        logger.warn("graph-workflow.script_validation.unknown_command", {
          executionId: execution.id,
          contextId: input.contextId,
          command: outcome.commandName,
          failureClass,
        });
        const haltReason: GraphWorkflowHaltReason = {
          type: "script_validator_unknown_command",
          contextId: input.contextId,
          commandName: outcome.commandName,
          message: gate.reason,
        };
        await onHalt(haltReason);
        throw new IterationHaltedError(haltReason, undefined, {
          failureAlreadyCounted: true,
        });
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
      throw new IterationHaltedError(recoveryReason, undefined, {
        failureAlreadyCounted: true,
      });
    }

    // Neither a pass nor an infrastructure error: the script deterministically
    // rejected the candidate. The round's fate is settled here, before any of
    // the accounting below can halt out of this function.
    journal.outcome = "script_failed";

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
      throw new IterationHaltedError(haltReason, undefined, {
        failureAlreadyCounted: true,
      });
    }

    return "fail";
  }

  /**
   * Shared awaiting-user-input park for both the implementer and context-
   * validator lanes (design "Park detection"; Req 3.2, 3.3). Hands every asking
   * lane's batch to the user-input gate, one park per lane: a cohort can have
   * several validators waiting at once, and a park that named only the first
   * would strand the rest with questions nobody could answer.
   *
   * Returns null when NO lane parked — every batch already had answers recorded
   * (fast answer), so the caller proceeds. Otherwise it commits the park
   * mutation — dropping the context from `activeContextIds`, rebuilding the
   * machine snapshot, and (for the implementer seed increment only) restoring
   * the pre-seed iteration count so parking consumes no iteration — then
   * re-reads and returns the parked iteration result. It never touches
   * `consecutiveFailureCount` or reopens tasks.
   */
  async function parkContextForUserInput(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    /** The asking lanes, in cohort order. */
    lanes: ReadonlyArray<{
      laneKey: string;
      conversationId: string;
      questionBatchId: string;
      questions: AskQuestionItem[];
    }>;
    /** The round the asking validators are reviewing in; null for the implementer. */
    roundSeq?: number | null;
    /** The conversation the parked iteration result reports. */
    conversationId: string;
    /** When set, the context's iterationCount is restored to this value. */
    restoreIterationCount?: number;
  }): Promise<GraphWorkflowIterationResult | null> {
    const {
      input,
      execLogger,
      lanes,
      roundSeq,
      conversationId,
      restoreIterationCount,
    } = params;

    let parkedCount = 0;
    for (const lane of lanes) {
      const outcome = await userInputGateService.enterAwaitingUserInput({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        contextId: input.contextId,
        laneKey: lane.laneKey,
        conversationId: lane.conversationId,
        questionBatchId: lane.questionBatchId,
        questions: lane.questions,
        roundSeq: roundSeq ?? null,
      });

      if (outcome === "answers_ready") {
        execLogger?.iteration(
          input.contextId,
          "iteration.user_input_fast_answer",
          {
            laneKey: lane.laneKey,
            conversationId: lane.conversationId,
            questionBatchId: lane.questionBatchId,
          },
        );
        logger.info("graph-workflow.iteration.user_input_fast_answer", {
          contextId: input.contextId,
          laneKey: lane.laneKey,
          questionBatchId: lane.questionBatchId,
        });
        continue;
      }
      parkedCount += 1;
    }

    if (parkedCount === 0) {
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
        laneKeys: lanes.map((lane) => lane.laneKey),
        parkedCount,
        roundSeq: roundSeq ?? null,
      },
    );
    logger.info("graph-workflow.iteration.parked_awaiting_user_input", {
      executionId: parkedExecution.id,
      contextId: input.contextId,
      laneKeys: lanes.map((lane) => lane.laneKey),
      parkedCount,
    });

    return {
      conversationId,
      execution: parkedExecution,
      shouldContinueInContext: false,
    };
  }

  /**
   * Resolve the candidate identity as it is RIGHT NOW: the git identity the
   * validators would inspect, plus the context's current task-state generation.
   * Called at the freeze and again at each re-verification point, so the two
   * observations are produced by identical means and a difference between them
   * is a real move rather than an artefact of how each was computed.
   *
   * The scope comes from the context's own placement (R15), which is what makes
   * this identity stable for a context sharing a lane worktree: an enveloped
   * context is identified by its owned subset, so a sibling's writes and landed
   * commits are not its drift.
   */
  async function observeCandidate(
    input: GraphWorkflowIterationInput,
    execution: GraphWorkflowExecution,
    outputCandidate?: GraphWorkflowContextOutput,
  ): Promise<
    | { kind: "resolved"; candidate: GraphWorkflowValidationCandidate }
    | { kind: "unavailable"; reason: string }
  > {
    // Looked up without throwing: an observation reports unavailability as its
    // own result, and a context that has left the working definition is exactly
    // the infrastructure outcome the caller is equipped to conclude on.
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    if (context === undefined) {
      return {
        kind: "unavailable",
        reason: `execution context "${input.contextId}" is not in the working definition`,
      };
    }

    const tree: ValidationCandidateTreeResolution =
      (await deps.validationRoundService?.resolveCandidateTree({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        contextId: input.contextId,
        candidateScope: candidateScopeForPlacement(context.placement, {
          stableRead: context.outputSchema !== undefined,
        }),
        ...(input.executionTarget
          ? { executionTarget: input.executionTarget }
          : {}),
      })) ?? {
        kind: "unavailable",
        reason: "no candidate-tree resolver is configured",
      };

    if (tree.kind === "unavailable") return tree;

    return {
      kind: "resolved",
      candidate: freezeValidationCandidate({
        tree,
        taskStates: execution.taskStates,
        contextId: input.contextId,
        outputSchema: context.outputSchema,
        outputValue: (
          outputCandidate ??
          execution.contextStates[input.contextId]?.validationRound
            ?.outputCandidate ??
          execution.contextOutputs[input.contextId]
        )?.value,
      }),
    };
  }

  /**
   * The durable reference an ENVELOPED context's human approval gate parks on
   * (R15.2): the owned subset it declares, plus the identity that subset had the
   * moment the gate opened.
   *
   * Frozen through `observeCandidate`, the same reader a validation round
   * freezes through, so the bytes the human is shown and the bytes the cohort
   * certified are read under one definition of this context's change set.
   *
   * Null for a full-access member — it keeps the whole-tree approval view — and
   * null when the candidate cannot be read. A gate must still open in that case
   * (the human decision is not the engine's to skip), and the approval surface
   * reports the missing artifact rather than silently widening to the shared
   * lane worktree's whole-tree delta.
   */
  async function freezeApprovalScope(
    input: GraphWorkflowIterationInput,
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowApprovalScope> {
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    if (context === undefined) return { kind: "whole_tree" };
    if (!context.humanApprovalGate.enabled) return { kind: "whole_tree" };
    const scope = candidateScopeForPlacement(context.placement, {
      stableRead: context.outputSchema !== undefined,
    });
    if (scope.mode !== "owned") return { kind: "whole_tree" };

    // Past this point the context IS enveloped, so every remaining path fails
    // CLOSED. Returning the whole-tree scope for an enveloped member would let
    // a gate that opens anyway inherit a view that is partly a sibling's work.
    //
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

    const observed = await observeCandidate(input, execution);
    if (observed.kind !== "resolved") {
      logger.warn("graph-workflow.approval.scoped_snapshot_unresolved", {
        executionId: execution.id,
        contextId: input.contextId,
        reason: observed.reason,
      });
      return { kind: "unreadable", reason: observed.reason };
    }
    return {
      kind: "scoped",
      ownedPaths: [...scope.ownedPaths],
      treeHash: observed.candidate.candidateTreeHash,
      headSha: observed.candidate.headSha,
    };
  }

  /**
   * Freeze-time observation, re-probed before giving up. A round cannot open on
   * an unreadable tree, so this is the one place that retries; every later
   * observation compares against an identity that already exists, where an
   * unreadable tree is simply drift.
   */
  async function observeCandidateForFreeze(
    input: GraphWorkflowIterationInput,
    execution: GraphWorkflowExecution,
    outputCandidate?: GraphWorkflowContextOutput,
  ): Promise<
    | { kind: "resolved"; candidate: GraphWorkflowValidationCandidate }
    | { kind: "unavailable"; reason: string; attempts: number }
  > {
    let last = "";
    for (let attempt = 1; attempt <= CANDIDATE_RESOLVE_ATTEMPTS; attempt += 1) {
      const observed = await observeCandidate(
        input,
        execution,
        outputCandidate,
      );
      if (observed.kind === "resolved") return observed;
      last = observed.reason;
    }
    return {
      kind: "unavailable",
      reason: last,
      attempts: CANDIDATE_RESOLVE_ATTEMPTS,
    };
  }

  async function writeValidationRound(
    input: GraphWorkflowIterationInput,
    round: GraphWorkflowValidationRound | null,
    options: {
      /**
       * Retires the advisory-response phase in the same write that opens the
       * round it asked for. One mutation rather than two because the pair is one
       * act: a clear that landed without the round would let the next pass open
       * an ordinary round with the advisory lanes back in it, and a round opened
       * without the clear would be re-opened as a re-certification forever.
       */
      clearAdvisoryResponse?: boolean;
      /**
       * Charges this write's round outcome against the consecutive-mismatch
       * budget. Opt-in because the same helper writes an OPENING round: settling
       * the budget there would clear the very run of mismatches the next round
       * is about to add to.
       */
      settleCandidateMismatchBudget?: boolean;
    } = {},
  ): Promise<void> {
    await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const contextState = next.contextStates[input.contextId];
        if (contextState) {
          contextState.validationRound = round;
          if (options.clearAdvisoryResponse) {
            contextState.advisoryResponse = null;
          }
          if (options.settleCandidateMismatchBudget) {
            settleCandidateMismatchBudget(contextState, round?.outcome ?? null);
          }
        }
        return next;
      },
    );
  }

  /**
   * Move the context into, or out of, the advisory-response phase (D8).
   *
   * Its own write rather than a field folded into a neighbouring mutation: the
   * phase is entered after the round's verdict is already published and left
   * after a turn that may have failed, so there is no other write it reliably
   * shares a moment with.
   */
  async function writeAdvisoryResponsePhase(
    input: GraphWorkflowIterationInput,
    phase: GraphWorkflowAdvisoryResponsePhase | null,
  ): Promise<GraphWorkflowExecution> {
    return await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const contextState = next.contextStates[input.contextId];
        if (contextState) {
          contextState.advisoryResponse = phase;
        }
        return next;
      },
    );
  }

  /**
   * This round as the DURABLE record holds it, or null if the context has since
   * moved to another round.
   *
   * The record rather than the in-memory round the pass has been carrying: every
   * lane wrote its verdict and its identity-stamped advisories there, including
   * the lanes a resumed round carried forward without re-running them, so the
   * in-memory copy knows nothing about either.
   */
  async function loadCurrentRoundRecord(
    input: GraphWorkflowIterationInput,
    round: GraphWorkflowValidationRound | null,
  ): Promise<GraphWorkflowValidationRound | null> {
    if (round === null) return null;
    const current = (
      await loadCurrentExecution(input.projectPath, input.sessionName)
    ).contextStates[input.contextId]?.validationRound;
    if (current === null || current === undefined) return null;
    if (current.seq !== round.seq) return null;
    return current;
  }

  /**
   * Fold one lane's state change into the round record.
   *
   * Written per change rather than per round because the two things that read
   * these fields — the halt an exhausted lane raises, and the resume that
   * decides who reruns — both need them to have survived the process that
   * produced them.
   */
  async function recordSpecialistProgress(
    input: GraphWorkflowIterationInput,
    /** The round this lane started in. A write is fenced to it. */
    dispatchRoundSeq: number,
    update: CohortLaneProgress,
  ): Promise<void> {
    await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const round = next.contextStates[input.contextId]?.validationRound;
        if (!round) return next;

        // The round a lane started in is the only round its answer describes.
        // A late write landing on a NEWER round would credit a stranger's
        // candidate with a verdict rendered against a tree it never had.
        if (round.seq !== dispatchRoundSeq) {
          const delivery = eventPublisher.publishValidationIncident({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: next,
            contextId: input.contextId,
            incident: "round_superseded",
            roundSeq: dispatchRoundSeq,
            stage: "specialist_result",
            assignmentId: update.assignmentId,
            attempts: update.attempts,
            driftedComponents: `roundSeq (${dispatchRoundSeq} -> ${round.seq})`,
            message: `${update.assignmentId} answered into validation round ${dispatchRoundSeq}, which round ${round.seq} has already superseded; the write was dropped.`,
          });
          return { execution: next, ...delivery };
        }

        const specialist = round.specialists[update.assignmentId];
        if (!specialist) return next;
        specialist.state = update.state;
        specialist.attempts = update.attempts;
        if (update.summary !== undefined) specialist.summary = update.summary;
        if (update.issues !== undefined) specialist.issues = [...update.issues];
        // Written with the verdict that raised them, not derived later from the
        // round's outcome: the halt an operator resumes and the plan-repair
        // round that answers it both read the finding itself, and a round
        // reloaded after a crash would otherwise say a seat refused the
        // contract without saying what it refused.
        if (update.planDefects !== undefined) {
          specialist.planDefects = [...update.planDefects];
        }
        // Identity is stamped HERE, at the only write that knows all three of
        // its components: the round this lane answered into (fenced above), the
        // seat that answered, and the position of each advisory in that seat's
        // own report. A validator never names its own advisories.
        if (update.advisories !== undefined) {
          specialist.advisories = stampAdvisoryIdentities({
            roundSeq: round.seq,
            assignmentId: update.assignmentId,
            advisories: update.advisories,
          });
          // Projected in the same write that stamps them, so the long-lived
          // kinds are readable from the execution however the round ends — a
          // plan or out-of-scope observation is no less true for the round that
          // raised it having failed (D9).
          next.advisoryIndex = indexAdvisoriesForSeat({
            index: next.advisoryIndex,
            contextId: input.contextId,
            roundSeq: round.seq,
            assignmentId: update.assignmentId,
            advisories: specialist.advisories,
          });
        }
        if (update.questionToken !== undefined) {
          specialist.questionToken = update.questionToken;
        }
        // Each fact is recorded and published in the same breath, from THIS
        // mutation — the one that accepts the change — so no event can describe
        // round state that was never committed (D12).
        if (update.verdict !== undefined) {
          // Provenance belongs to the verdict, so a round rebuilt after a crash
          // can still say WHERE each retained verdict was rendered and what it
          // cost.
          specialist.sessionRef = update.verdict.sessionRef;
          specialist.reviewArtifact = update.verdict.reviewArtifact;
          const entry = buildSpecialistEntry(round, {
            assignmentId: update.assignmentId,
            pass: update.verdict.pass,
            summary: update.summary ?? "",
            issues: [...(update.issues ?? [])],
            sessionRef: update.verdict.sessionRef,
            reviewArtifact: update.verdict.reviewArtifact,
          });
          if (entry !== null) {
            const delivery = eventPublisher.publishValidationSpecialistResult({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: next,
              contextId: input.contextId,
              roundSeq: round.seq,
              specialist: entry,
            });
            return { execution: next, ...delivery };
          }
        }

        if (update.infraFailure !== undefined) {
          // Written with the count it explains: `attempts` alone cannot tell a
          // lane recovered after a crash why its budget is gone.
          specialist.lastInfraFailure = { ...update.infraFailure };
          const delivery = eventPublisher.publishValidationIncident({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: next,
            contextId: input.contextId,
            incident: "infra_failure",
            roundSeq: round.seq,
            stage: "specialist_result",
            assignmentId: update.assignmentId,
            attempts: update.attempts,
            driftedComponents: "",
            message: `${update.assignmentId} spent attempt ${update.attempts} of ${COHORT_SPECIALIST_ATTEMPTS} on an infrastructure failure (${update.infraFailure.reason}): ${update.infraFailure.message}`,
          });
          return { execution: next, ...delivery };
        }

        return next;
      },
    );
  }

  /**
   * Whether the context is still on the round this pass has been reviewing.
   *
   * The check is what makes a conclusion safe to write: everything the round
   * collected describes ONE candidate, and a context that has moved to another
   * round no longer owns that candidate. Publishing anyway would reopen tasks —
   * or clear a failure counter — on the authority of a review of a tree the
   * context has already left behind.
   */
  function roundStillCurrent(
    execution: GraphWorkflowExecution,
    contextId: string,
    round: GraphWorkflowValidationRound | null,
  ): boolean {
    if (round === null) return true;
    return (
      (execution.contextStates[contextId]?.validationRound?.seq ?? null) ===
      round.seq
    );
  }

  /**
   * The incident a superseded conclusion publishes INSTEAD of its aggregate.
   * Same mutation, so the record of the refusal is as atomic as the write it
   * replaced (D12).
   */
  function publishRoundSuperseded(params: {
    input: GraphWorkflowIterationInput;
    execution: GraphWorkflowExecution;
    round: GraphWorkflowValidationRound;
  }): GraphWorkflowEventDelivery {
    const observed =
      params.execution.contextStates[params.input.contextId]?.validationRound
        ?.seq ?? null;
    return eventPublisher.publishValidationIncident({
      projectPath: params.input.projectPath,
      sessionName: params.input.sessionName,
      execution: params.execution,
      contextId: params.input.contextId,
      incident: "round_superseded",
      roundSeq: params.round.seq,
      stage: "aggregate",
      assignmentId: null,
      driftedComponents: `roundSeq (${params.round.seq} -> ${observed ?? "none"})`,
      message: `Validation round ${params.round.seq} concluded into a context that has already moved to round ${observed ?? "none"}; nothing was recorded and no verdict was published.`,
    });
  }

  /**
   * Log a conclusion that was refused because its round was superseded, and
   * leave the round record alone: the open round belongs to whoever superseded
   * this one, and concluding it here would end a round this pass never ran.
   */
  function abandonSupersededConclusion(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    round: GraphWorkflowValidationRound;
    journal: RoundJournal;
  }): null {
    params.journal.leaveOpen = true;
    params.execLogger?.validation(
      params.input.contextId,
      "validation_round.round_superseded",
      { roundSeq: params.round.seq, stage: "aggregate" },
    );
    logger.warn("graph-workflow.validation_round.round_superseded", {
      contextId: params.input.contextId,
      roundSeq: params.round.seq,
      stage: "aggregate",
    });
    return null;
  }

  /**
   * One publishable specialist entry: the verdict joined to the identity the
   * round FROZE for that seat.
   *
   * Identity comes from the roster and never from the live definition — the
   * roster records which profile bytes this reviewer actually received, so the
   * entry stays truthful after the profile is edited. A verdict from a seat the
   * roster does not know is not publishable at all: attributing it to no
   * profile would be worse than omitting it.
   */
  function buildSpecialistEntry(
    round: GraphWorkflowValidationRound,
    verdict: Pick<
      GraphWorkflowValidationSpecialistEntry,
      | "assignmentId"
      | "pass"
      | "summary"
      | "issues"
      | "sessionRef"
      | "reviewArtifact"
    >,
  ): GraphWorkflowValidationSpecialistEntry | null {
    const seat = round.roster.find(
      (entry) => entry.assignmentId === verdict.assignmentId,
    );
    if (seat === undefined) return null;
    return {
      assignmentId: verdict.assignmentId,
      profile: {
        tier: seat.profileRef.tier,
        id: seat.profileRef.id,
        revision: seat.revision,
      },
      resolvedInstructionHash: seat.resolvedInstructionHash,
      pass: verdict.pass,
      summary: verdict.summary,
      issues: verdict.issues,
      // From the round RECORD, not from the verdict: the record is where the
      // engine stamped each advisory's identity, and it is the only place a
      // resumed round's carried-forward lane has any (R9).
      advisories: [
        ...(round.specialists[verdict.assignmentId]?.advisories ?? []),
      ],
      sessionRef: verdict.sessionRef,
      reviewArtifact: verdict.reviewArtifact,
      usage: deriveGraphWorkflowValidationSpecialistUsage(
        verdict.reviewArtifact,
      ),
    };
  }

  /**
   * The cohort's verdicts as aggregate-event entries, in cohort order.
   *
   * Empty outside a round: with no frozen roster there is no identity to
   * attribute a verdict to, and the pre-cohort single-reviewer shape — top-level
   * verdict, top-level refs — is exactly what such a result should keep.
   */
  function buildSpecialistEntries(
    round: GraphWorkflowValidationRound | null,
    verdicts: readonly CohortSpecialistVerdict[] | undefined,
  ): GraphWorkflowValidationSpecialistEntry[] {
    if (round === null || verdicts === undefined) return [];
    const entries: GraphWorkflowValidationSpecialistEntry[] = [];
    for (const verdict of verdicts) {
      const entry = buildSpecialistEntry(round, verdict);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  /**
   * The lanes a resumed round does NOT dispatch again, rebuilt from what the
   * round record and the parked questions persisted.
   *
   * Two kinds, for one reason: re-running either would undo something that has
   * already happened. A settled lane rendered a verdict on exactly this
   * candidate. A lane still parked is holding a question the human is looking at
   * right now, and dispatching it would replace that question with a new batch —
   * so a cohort where one answer arrives before another would silently throw the
   * later question away, which is precisely the serialization R9.1 forbids.
   *
   * Everything else owes this candidate a review: an infra-failed lane, a lane
   * that was still running when the process died, and the lane whose answers
   * this very iteration is carrying.
   */
  function carriedForwardCohortLanes(
    round: GraphWorkflowValidationRound,
    contextState: GraphWorkflowExecutionContextState | undefined,
    input: GraphWorkflowIterationInput,
  ): Record<string, RetainedCohortLane> {
    const retained: Record<string, RetainedCohortLane> = {};
    for (const seat of round.roster) {
      const specialist = round.specialists[seat.assignmentId];
      if (!specialist) continue;
      if (
        specialist.state !== "verdict_pass" &&
        specialist.state !== "verdict_fail"
      ) {
        const parked = carriedParkedLane(
          seat.assignmentId,
          contextState,
          input,
        );
        if (parked !== null) retained[seat.assignmentId] = parked;
        continue;
      }
      const summary = specialist.summary ?? "";
      // Re-stamped from the seat: the round record groups findings BY
      // assignment, so the key is where the attribution lives and the issues
      // themselves are stored without it. Rebuilding it here keeps a resumed
      // round's aggregate as attributable as a fresh one's (R5.4).
      const issues = specialist.issues.map((issue) => ({
        ...issue,
        assignmentId: seat.assignmentId,
      }));
      // The refs come back from the record too. A verdict rendered before a
      // crash was rendered by a real session at a real cost; reconstructing it
      // without them would make a resumed round's aggregate less attributable
      // than an uninterrupted one's, and silently unprice its retained lanes.
      const sessionRef = specialist.sessionRef;
      const reviewArtifact = specialist.reviewArtifact;
      // A defect-carrying record is a rejection of the CONTRACT, and it is the
      // stored defects — not the lane state, which a plan defect shares with an
      // ordinary rejection — that say so. Rebuilding it as a plain `fail` would
      // hand the resumed round a reopen list derived from evidence, which is
      // the one reaction the response exists to prevent.
      const planDefects = specialist.planDefects ?? [];
      if (planDefects.length > 0) {
        retained[seat.assignmentId] = {
          assignmentId: seat.assignmentId,
          attempts: specialist.attempts,
          settlement: {
            kind: "plan_defect",
            summary,
            feedback: `Context validation reported a plan defect.\n${summary}`,
            // Re-stamped from the seat for the same reason the issues are: the
            // record groups findings by assignment, so the key is where the
            // attribution lives.
            planDefects: planDefects.map((defect) => ({
              ...defect,
              assignmentId: seat.assignmentId,
            })),
            issues,
            sessionRef,
            reviewArtifact,
          },
        };
        continue;
      }
      retained[seat.assignmentId] =
        specialist.state === "verdict_pass"
          ? {
              assignmentId: seat.assignmentId,
              attempts: specialist.attempts,
              settlement: {
                kind: "pass",
                summary,
                feedback: `Context validation passed.\n${summary}`,
                issues: [],
                reopenTaskIds: [],
                sessionRef,
                reviewArtifact,
              },
            }
          : {
              assignmentId: seat.assignmentId,
              attempts: specialist.attempts,
              settlement: {
                kind: "fail",
                summary,
                feedback: `Context validation blocked completion.\n${summary}`,
                issues,
                reopenTaskIds: [
                  ...new Set(issues.map((issue) => issue.taskId)),
                ],
                sessionRef,
                reviewArtifact,
              },
            };
    }
    return retained;
  }

  /**
   * A seat's standing question, as the lane settlement that carries it through
   * a resume without re-asking it — or null when this seat is not waiting.
   *
   * The PARKED RECORD is the source, not the round's specialist state: the
   * record is what the human can actually answer, and it names the conversation
   * and the batch that answer will arrive on. Scoped to the round it was asked
   * in, so a question left behind by a round the context has since left cannot
   * hold a new one open.
   */
  function carriedParkedLane(
    assignmentId: string,
    contextState: GraphWorkflowExecutionContextState | undefined,
    input: GraphWorkflowIterationInput,
  ): RetainedCohortLane | null {
    const round = contextState?.validationRound;
    if (!contextState || !round) return null;
    const laneKey = laneStateKey("context_validator", assignmentId);
    const record = contextState.pendingUserInputs[laneKey];
    if (!record || record.roundSeq !== round.seq) return null;
    // The answers this iteration carries were consumed FROM this lane's record;
    // a record still standing for it means the answer has not been delivered, so
    // delivering it wins over holding the lane.
    if (input.resumeUserInputs?.some((resume) => resume.laneKey === laneKey)) {
      return null;
    }
    return {
      assignmentId,
      attempts: round.specialists[assignmentId]?.attempts ?? 0,
      settlement: {
        kind: "asked_user",
        conversationId: record.conversationId,
        questionBatchId: record.questionBatchId,
        questions: record.questions,
      },
    };
  }

  /**
   * What each UNSETTLED lane already spent in this round.
   *
   * Read back rather than restarted at zero: the attempt bound is three per
   * specialist per round, and a round survives the process that opened it. A
   * pass that began every lane at zero would hand a failing provider three more
   * dispatches after every crash, which is the same as having no bound (D5).
   *
   * A count with no recorded failure is skipped: it predates the field, and a
   * lane cannot be settled against a reason nobody wrote down.
   */
  function carriedCohortProgress(
    round: GraphWorkflowValidationRound,
  ): Record<string, CohortCarriedProgress> {
    const carried: Record<string, CohortCarriedProgress> = {};
    for (const seat of round.roster) {
      const specialist = round.specialists[seat.assignmentId];
      if (!specialist || specialist.attempts <= 0) continue;
      if (specialist.lastInfraFailure === null) continue;
      carried[seat.assignmentId] = {
        attempts: specialist.attempts,
        lastFailure: specialist.lastInfraFailure,
      };
    }
    return carried;
  }

  /**
   * The consecutive candidate-mismatch budget, settled against one round
   * conclusion. Returns the count the conclusion leaves behind.
   *
   * A mismatch is the one outcome that charges nothing — not an iteration, not a
   * consecutive failure — and returns the context to `ready`, so the engine
   * re-opens a round at once. Correct for drift that settles; an unbounded loop
   * when it cannot, which is why the run of them needs a count of its own. Any
   * other conclusion clears it: the candidate held still long enough to be
   * judged, so whatever was moving it is no longer moving it.
   *
   * Keyed on the round OUTCOME, so a rejected stale token counts with a moved
   * tree: the two publish different incidents but leave the round in the same
   * state — concluded on nothing, reopened at once, charged nowhere else.
   */
  function settleCandidateMismatchBudget(
    contextState: GraphWorkflowExecutionContextState,
    outcome: ValidationRoundOutcome | null,
  ): number {
    const next =
      outcome === "candidate_mismatch"
        ? (contextState.consecutiveCandidateMismatchCount ?? 0) + 1
        : 0;
    contextState.consecutiveCandidateMismatchCount = next;
    return next;
  }

  /**
   * Close the round out and publish the incident that explains why, for the two
   * outcomes where nobody judged the work. Neither charges an iteration nor a
   * consecutive failure: an infrastructure outcome that fed the circuit breaker
   * would eventually halt a workflow for a reason no reviewer ever raised.
   *
   * A mismatch does charge the consecutive-mismatch budget, which is not the
   * same claim: it counts rounds that reached no verdict at all, and only to
   * bound a loop that nothing else can see.
   */
  async function concludeRoundOnIncident(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
    round: GraphWorkflowValidationRound;
    incident: "candidate_mismatch" | "roster_drift" | "stale_result_rejected";
    stage: GraphWorkflowValidationIncidentStage;
    assignmentId: string | null;
    /** What diverged: the moved candidate components, or the drifted seats. */
    drifted: string;
    message: string;
    journal: RoundJournal;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<GraphWorkflowIterationResult> {
    const {
      input,
      execLogger,
      round,
      incident,
      stage,
      assignmentId,
      drifted,
      message,
      journal,
      onHalt,
    } = params;

    execLogger?.validation(input.contextId, `validation_round.${incident}`, {
      roundSeq: round.seq,
      stage,
      assignmentId,
      driftedComponents: drifted,
    });
    logger.warn(`graph-workflow.validation_round.${incident}`, {
      contextId: input.contextId,
      roundSeq: round.seq,
      stage,
      assignmentId,
      driftedComponents: drifted,
    });

    journal.outcome =
      incident === "roster_drift" ? "roster_drift" : "candidate_mismatch";

    let mismatchCount = 0;
    const concluded = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const contextState = next.contextStates[input.contextId];
        if (contextState) {
          contextState.validationRound = concludeValidationRound(
            round,
            journal.outcome,
          );
          mismatchCount = settleCandidateMismatchBudget(
            contextState,
            journal.outcome,
          );
        }
        // Back to ready, and out of the active set: the context is neither done
        // nor failed, it simply has no reviewed candidate. The scheduler picks
        // it up again and the next pass freezes a fresh one.
        next.activeContextIds = next.activeContextIds.filter(
          (id) => id !== input.contextId,
        );
        transitionContextStatus(next, input.contextId, "ready", {
          reason: `validation_round.${incident}`,
        });
        next.machineSnapshot = buildLifecycleSnapshot(next, {
          hasLiveIteration: false,
        });
        const delivery = eventPublisher.publishValidationIncident({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: next,
          contextId: input.contextId,
          incident,
          roundSeq: round.seq,
          stage,
          assignmentId,
          driftedComponents: drifted,
          message,
        });
        return { execution: next, ...delivery };
      },
    );

    logRoundConcluded(input, execLogger, round, journal.outcome);

    if (mismatchCount >= CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET) {
      // The context is already back at `ready` above, exactly as it would be for
      // a mismatch inside the budget — the halt is what stops the scheduler from
      // handing it another round, so nothing about the reviewed work is undone.
      const lastIncident =
        incident === "stale_result_rejected"
          ? "stale_result_rejected"
          : "candidate_mismatch";
      const haltReason: GraphWorkflowHaltReason = {
        type: "candidate_unstable",
        contextId: input.contextId,
        stage,
        driftedComponents: drifted,
        lastIncident,
        consecutiveCount: mismatchCount,
        // Two causes, one count, and only one of them is about the worktree.
        // Claiming movement for a rejection that observed none would send the
        // operator hunting a writer that does not exist.
        message:
          drifted === ""
            ? `Validation of execution context "${input.contextId}" concluded without a verdict ${mismatchCount} times in a row, and no candidate movement was observed (last incident at ${stage}: ${
                lastIncident === "stale_result_rejected"
                  ? "a validator answered for a round that was already over — a stale round token"
                  : "the candidate read back unchanged, so nothing could be named as having moved"
              }). Rounds that reach no verdict charge nothing, so the run would repeat indefinitely.`
            : `Validation of execution context "${input.contextId}" concluded without a verdict ${mismatchCount} times in a row because the reviewed candidate kept moving (drifted components at ${stage}: ${drifted}). Rounds that cannot certify a candidate charge nothing, so the run would repeat indefinitely.`,
        summary: null,
      };
      execLogger?.validation(
        input.contextId,
        "validation_round.candidate_unstable",
        {
          roundSeq: round.seq,
          stage,
          consecutiveCount: mismatchCount,
          driftedComponents: drifted,
          lastIncident,
        },
      );
      logger.error("graph-workflow.validation_round.candidate_unstable", {
        contextId: input.contextId,
        roundSeq: round.seq,
        stage,
        consecutiveCount: mismatchCount,
        driftedComponents: drifted,
        lastIncident,
      });
      await onHalt(haltReason);
      return {
        conversationId: params.conversationId,
        execution: await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        ),
        shouldContinueInContext: false,
      };
    }

    return {
      conversationId: params.conversationId,
      execution: concluded,
      shouldContinueInContext: false,
    };
  }

  /** The candidate moved (or stopped being readable) under an open round. */
  async function concludeRoundOnCandidateMismatch(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
    round: GraphWorkflowValidationRound;
    /** The new observation, or the reason there could not be one. */
    observed:
      | { kind: "resolved"; candidate: GraphWorkflowValidationCandidate }
      | { kind: "unavailable"; reason: string };
    stage: GraphWorkflowValidationIncidentStage;
    assignmentId: string | null;
    /**
     * What diverged, when the caller knows something a re-observation cannot
     * recover — the shared inputs having been rendered from another tree, which
     * leaves no trace in the worktree once the render is over.
     */
    driftOverride?: string;
    /** The narrower incident, when the caller knows nothing actually moved. */
    incidentOverride?: "stale_result_rejected";
    journal: RoundJournal;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<GraphWorkflowIterationResult> {
    const drifted =
      params.driftOverride ??
      (params.observed.kind === "resolved"
        ? describeCandidateDrift(
            params.round.candidate,
            params.observed.candidate,
          )
        : `tree unreadable (${params.observed.reason})`);

    const incident = params.incidentOverride ?? "candidate_mismatch";
    return concludeRoundOnIncident({
      ...params,
      incident,
      drifted,
      message:
        incident === "stale_result_rejected"
          ? `A validator result arrived for a round other than validation round ${params.round.seq}; it was rejected and the round concluded without a verdict.`
          : `The reviewed candidate moved during validation round ${params.round.seq} (${drifted}); the round concluded without a verdict.`,
    });
  }

  function contextReviewPlan(
    execution: GraphWorkflowExecution,
    contextId: string,
  ) {
    const context = getContextDefinition(execution, contextId);
    const recertification =
      execution.contextStates[contextId]?.advisoryResponse?.phase ===
      "recertifying";
    const runnable = selectRunnableCohortAssignments(context.contextValidator);
    const cohortAssignments = recertification
      ? selectRecertificationAssignments(runnable)
      : runnable;
    return {
      recertification,
      cohortAssignments,
      roundApplies:
        context.scriptValidator.commands.length > 0 ||
        cohortAssignments.length > 0,
    };
  }

  async function processContextCompletionValidation(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    /** Bookkeeping id for an iteration result this stage may short-circuit. */
    conversationId: string;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
    outputCandidate?: GraphWorkflowContextOutput;
  }): Promise<GraphWorkflowIterationResult | null> {
    const { input, execLogger, conversationId, onHalt } = params;
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

    // The advisory-response phase owns the context between a certification and
    // the turn that answers for it. Opening a round here would re-review a
    // candidate this context has already certified — the one thing R8 exists to
    // prevent — so the round machinery stands down and `processAdvisoryResponse`
    // takes the context from here.
    const advisoryPhase =
      preContextValidationExecution.contextStates[input.contextId]
        ?.advisoryResponse ?? null;
    if (advisoryPhase?.phase === "awaiting_response") {
      return null;
    }
    // A re-certification asks only whether the changed candidate is still
    // certified, so it runs the script gate and the blocking lanes; the advisory
    // lanes are filtered out of the cohort BEFORE the roster is frozen, which is
    // what makes them structurally absent from the round rather than merely
    // ignored inside it (R8.2).
    const { recertification, cohortAssignments, roundApplies } =
      contextReviewPlan(preContextValidationExecution, input.contextId);

    if (!roundApplies) {
      // Nothing can re-certify an advisory-only cohort with no script gate, so
      // the phase is retired here rather than left standing over a context that
      // is about to finish.
      if (recertification) {
        await writeAdvisoryResponsePhase(input, null);
        return null;
      }
      return runContextValidationStages({
        input,
        execLogger,
        conversationId,
        onHalt,
        preContextValidationExecution,
        round: null,
        journal: { outcome: null },
        recertification,
      });
    }

    // Nothing may review a tree the engine cannot identify. Terminal rather
    // than a retry-forever incident: returning the context to ready would spin
    // against the same broken git for as long as the workflow ran.
    const frozenTree = await observeCandidateForFreeze(
      input,
      preContextValidationExecution,
      params.outputCandidate,
    );
    if (frozenTree.kind === "unavailable") {
      const message = `Could not read the candidate tree for execution context "${input.contextId}" after ${frozenTree.attempts} attempts: ${frozenTree.reason}`;
      execLogger?.validation(
        input.contextId,
        "validation_round.candidate_unavailable",
        { attempts: frozenTree.attempts, reason: frozenTree.reason },
      );
      logger.error("graph-workflow.validation_round.candidate_unavailable", {
        contextId: input.contextId,
        attempts: frozenTree.attempts,
        reason: frozenTree.reason,
      });
      const haltReason: GraphWorkflowHaltReason = {
        type: "validation_candidate_unavailable",
        contextId: input.contextId,
        attempts: frozenTree.attempts,
        message,
      };
      await onHalt(haltReason);
      throw new IterationHaltedError(haltReason);
    }

    const previousRound =
      preContextValidationExecution.contextStates[input.contextId]
        ?.validationRound ?? null;

    // A round left open by an infrastructure halt is RESUMED, not replaced, as
    // long as the candidate it froze is still the candidate. Freezing a fresh
    // one would discard the verdicts its settled specialists already rendered on
    // exactly this tree and re-review work that was already reviewed (D5). The
    // attempt counters come back with it: only an operator's resume clears them
    // (`resetValidationRoundAttempts`), so a crash cannot buy a fresh budget.
    const resumable =
      previousRound !== null &&
      isValidationRoundOpen(previousRound) &&
      candidateIdentityMatches(previousRound.candidate, frozenTree.candidate);

    // A round being REPLACED takes its parked questions with it. They were
    // asked about a candidate this context has left behind, so nobody can act
    // on an answer to them: leaving one standing would keep the context parked
    // on a question its own next round would never resume, and hand the
    // operator a question about work that no longer exists (R9.1's
    // residue-free rule, applied to the candidate-change case rather than to
    // pause-to-edit).
    if (
      !resumable &&
      previousRound !== null &&
      isValidationRoundOpen(previousRound)
    ) {
      await userInputGateService.withdrawRoundQuestions({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        executionId: preContextValidationExecution.id,
        contextId: input.contextId,
        // An iteration is driving this context right now; `ready` would offer
        // it to the scheduler while this runner is still inside it.
        releaseTo: "running",
      });
    }

    // Freeze the candidate AND the roster before anything runs. Both freezes are
    // one write: a roster frozen after the script phase would not be the roster
    // that owned the candidate while the script ran.
    const round = resumable
      ? previousRound
      : openValidationRound({
          previousRound,
          candidate: frozenTree.candidate,
          assignments: cohortAssignments,
          startedAt: getNow(deps),
          outputCandidate: params.outputCandidate,
        });
    const retained = resumable
      ? carriedForwardCohortLanes(
          previousRound,
          preContextValidationExecution.contextStates[input.contextId],
          input,
        )
      : undefined;
    if (!resumable) {
      await writeValidationRound(input, round, {
        clearAdvisoryResponse: recertification,
      });
    } else if (recertification) {
      // A resumable round and a pending re-certification cannot both be true —
      // the phase is only ever entered over a concluded round — but the phase is
      // durable, so it is retired on every path that answers it rather than only
      // on the one expected to.
      await writeAdvisoryResponsePhase(input, null);
    }
    const journal: RoundJournal = { outcome: null };

    execLogger?.validation(
      input.contextId,
      resumable ? "validation_round.resumed" : "validation_round.opened",
      {
        roundSeq: round.seq,
        rosterSize: round.roster.length,
        ...(recertification ? { recertification: true } : {}),
        candidateTreeHash: round.candidate.candidateTreeHash,
        headSha: round.candidate.headSha,
        taskStateHash: round.candidate.taskStateHash,
        // Lanes this resume does not dispatch: settled verdicts plus any lane
        // still holding a standing question.
        ...(retained
          ? { carriedForwardLanes: Object.keys(retained).length }
          : {}),
      },
    );

    try {
      return await runContextValidationStages({
        input,
        execLogger,
        conversationId,
        onHalt,
        preContextValidationExecution,
        round,
        journal,
        recertification,
        ...(retained ? { retained } : {}),
      });
    } finally {
      // The cohort owns the candidate only for the duration of this call, so the
      // round is released on every exit — verdict, incident, halt, or thrown
      // error alike. A round that outlived its own conclusion would keep the
      // implementer locked out of a context nobody is reviewing.
      //
      // Released by CONCLUDING it, not by erasing it: `seq` has to survive so
      // the next round can be told apart from this one.
      //
      // Guarded: this runs on the error path too, and a failing release must
      // never replace the error that caused it with a less informative one.
      try {
        const stillOpen =
          (await loadCurrentExecution(input.projectPath, input.sessionName))
            .contextStates[input.contextId]?.validationRound ?? null;
        if (
          !journal.leaveOpen &&
          stillOpen !== null &&
          isValidationRoundOpen(stillOpen)
        ) {
          await writeValidationRound(
            input,
            concludeValidationRound(stillOpen, journal.outcome),
            // Every conclusion that is NOT a mismatch passes through here — a
            // verdict, a failed script gate, or a round the caller threw out of
            // — because the mismatch path concludes its own round before
            // returning. That makes this the one place the budget has to be
            // cleared from, and it is cleared even on the thrown-error exit: a
            // round that died mid-flight is not evidence that the candidate is
            // moving.
            { settleCandidateMismatchBudget: true },
          );
        }
      } catch (releaseError) {
        logger.warn("graph-workflow.validation_round.release_failed", {
          contextId: input.contextId,
          roundSeq: round.seq,
          error: getErrorMessage(releaseError),
        });
      }
    }
  }

  async function runContextValidationStages(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
    preContextValidationExecution: GraphWorkflowExecution;
    round: GraphWorkflowValidationRound | null;
    journal: RoundJournal;
    /**
     * Whether this round is the blocking-only re-certification of a candidate
     * the advisory-response turn moved. Carried down rather than re-read from
     * the context state, which the round's own opening write has already
     * retired.
     */
    recertification?: boolean;
    /** Verdicts a resumed round carries forward; absent on a fresh round. */
    retained?: Record<string, RetainedCohortLane>;
  }): Promise<GraphWorkflowIterationResult | null> {
    const {
      input,
      execLogger,
      conversationId,
      onHalt,
      preContextValidationExecution,
      round,
      journal,
      recertification = false,
      retained,
    } = params;

    const scriptStageResult = await processScriptValidation({
      input,
      execLogger,
      execution: preContextValidationExecution,
      onHalt,
      journal,
    });

    if (scriptStageResult === "fail") {
      // A deterministic failure short-circuits the round with zero specialists
      // launched; the script validator's own remediation accounting already ran.
      logRoundConcluded(input, execLogger, round, "script_failed");
      return null;
    }

    const executionForAgentValidation = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );

    if (executionForAgentValidation.status !== "running") {
      return null;
    }

    // The script phase ran commands in the worktree. Re-verify before admitting
    // anyone: if the candidate moved, no specialist may be launched against it,
    // and the round ends as an infrastructure outcome rather than a verdict.
    let roundDispatch: ValidationRoundDispatch | undefined;
    if (round !== null) {
      const afterScript = await observeCandidate(
        input,
        executionForAgentValidation,
      );
      if (
        afterScript.kind === "unavailable" ||
        !candidateIdentityMatches(round.candidate, afterScript.candidate)
      ) {
        return await concludeRoundOnCandidateMismatch({
          input,
          execLogger,
          conversationId,
          round,
          observed: afterScript,
          stage: "post_script",
          assignmentId: null,
          journal,
          onHalt,
        });
      }

      // Resolve the FROZEN roster against the cohort the definition declares
      // now. A live edit between freeze and dispatch is legal — it belongs to
      // the next round — but running it here would mean the cohort that
      // reviewed the candidate is not the one recorded as owning it.
      const configuredNow = selectRunnableCohortAssignments(
        getContextDefinition(executionForAgentValidation, input.contextId)
          .contextValidator,
      );
      const reconciled = reconcileValidationRoster(
        round.roster,
        // The same filter the freeze applied. Reconciling a re-certification
        // against the WHOLE cohort would read its own deliberately-absent
        // advisory lanes as seats added since the freeze, and every
        // re-certification of a mixed cohort would die of roster drift.
        recertification
          ? selectRecertificationAssignments(configuredNow)
          : configuredNow,
      );
      if (reconciled.kind === "drift") {
        return await concludeRoundOnIncident({
          input,
          execLogger,
          conversationId,
          round,
          incident: "roster_drift",
          stage: "post_script",
          assignmentId: null,
          drifted: reconciled.detail,
          message: `The cohort configured for execution context "${input.contextId}" is no longer the roster validation round ${round.seq} froze (${reconciled.detail}); the round concluded without a verdict.`,
          journal,
          onHalt,
        });
      }

      const carried = carriedCohortProgress(round);
      roundDispatch = {
        seq: round.seq,
        candidate: round.candidate,
        assignments: reconciled.assignments,
        ...(retained ? { retained } : {}),
        ...(Object.keys(carried).length > 0 ? { carried } : {}),
      };
      await writeValidationRound(input, admitSpecialists(round));
    }

    // Lane progress writes are serialized behind one chain: several lanes settle
    // concurrently, and each write is a read-modify-write of the same round
    // record, so letting them race would lose whichever specialist lost.
    let specialistWrites: Promise<void> = Promise.resolve();

    // Only validator resumes deliver an answers block into the validation
    // prompt and pin a validator conversation. An implementer resume reaches
    // this inline completion check on the same turn; its answers belong in the
    // implementer prompt, never a validator's, so it is excluded here.
    const validatorResumes = validatorResumeEntries(input);

    const validation = await validationService.validateContextCompletion({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: executionForAgentValidation,
      contextId: input.contextId,
      executionTarget: input.executionTarget,
      resumeUserInputs: validatorResumes,
      ...(round !== null && roundDispatch !== undefined
        ? {
            round: roundDispatch,
            // Each lane's attempt count and state is written as it changes, not
            // once at the end: the halt an exhausted lane triggers publishes the
            // count, and a resume reads the states back to decide who reruns.
            onSpecialistProgress: (update) => {
              specialistWrites = specialistWrites
                .then(() => recordSpecialistProgress(input, round.seq, update))
                .catch((error: unknown) => {
                  logger.warn(
                    "graph-workflow.validation_round.specialist_write_failed",
                    {
                      contextId: input.contextId,
                      assignmentId: update.assignmentId,
                      error: getErrorMessage(error),
                    },
                  );
                });
            },
            verifyCandidate: async () => {
              const observed = await observeCandidate(
                input,
                await loadCurrentExecution(
                  input.projectPath,
                  input.sessionName,
                ),
              );
              return (
                observed.kind === "resolved" &&
                candidateIdentityMatches(round.candidate, observed.candidate)
              );
            },
          }
        : {}),
    });

    // Every lane's state is durable before anything acts on the round: the halt
    // an exhausted lane triggers publishes its attempt count, and a resume reads
    // these states back to decide who reruns.
    await specialistWrites;

    // The round could not be certified against what it froze — the shared diff
    // came from another tree, or a specialist judged a candidate that had
    // already moved. Either way the verdict is discarded rather than recorded:
    // publishing it would attribute a judgement to a tree nobody reviewed, and
    // nothing is charged.
    if (validation.kind === "candidate_mismatch") {
      if (round === null) return null;
      return await concludeRoundOnCandidateMismatch({
        input,
        execLogger,
        conversationId,
        round,
        observed: await observeCandidate(
          input,
          await loadCurrentExecution(input.projectPath, input.sessionName),
        ),
        stage: validation.stage,
        assignmentId: validation.assignmentId,
        // Nothing moved when a token is stale: the answer belongs to a round
        // that is over. The round's fate is identical, but a reader diagnosing
        // a stuck context needs to know which of the two it is looking at.
        ...(validation.reason === "stale_round_token"
          ? { incidentOverride: "stale_result_rejected" as const }
          : {}),
        ...(validation.stage === "diff_render"
          ? {
              driftOverride: `candidateTreeHash (the cohort's shared inputs were rendered from ${validation.observedTreeHash ?? "an unreadable tree"})`,
            }
          : {}),
        journal,
        onHalt,
      });
    }

    // A specialist spent every admitted attempt on infrastructure failures, and
    // no sibling rejected the work. All-of semantics make an unheard required
    // validator an UNCONCLUDABLE round: the passing siblings cannot vouch for
    // what it would have said, so the round does not end at all.
    //
    // Nothing is charged, and — deliberately, replacing the pre-cohort behaviour
    // — no aggregate validation result is published. A `pass: false` aggregate
    // here would tell every consumer that counts verdicts that a reviewer
    // rejected the work, when in fact no reviewer spoke (D5).
    if (validation.kind === "infra_exhausted") {
      execLogger?.validation(
        input.contextId,
        "context.validation_infra_error",
        {
          engine: validation.engine,
          reason: validation.reason,
          message: validation.message,
          assignmentId: validation.assignmentId,
          attempts: validation.attempts,
          roundSeq: round?.seq ?? null,
        },
      );
      logger.warn("graph-workflow.context_validation.infra_error", {
        executionId: preContextValidationExecution.id,
        contextId: input.contextId,
        engine: validation.engine,
        reason: validation.reason,
        assignmentId: validation.assignmentId,
        attempts: validation.attempts,
      });
      // The record of what happened is an INCIDENT, never a validation result.
      // A `pass: false` aggregate here — what the pre-cohort path published —
      // would tell every consumer that counts verdicts that a reviewer rejected
      // the work, when in fact no reviewer spoke (D5).
      if (round !== null) {
        await deps.executionRepository.mutateActive(
          input.projectPath,
          input.sessionName,
          (latest) => {
            const delivery = eventPublisher.publishValidationIncident({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: latest,
              contextId: input.contextId,
              incident: "infra_exhausted",
              roundSeq: round.seq,
              stage: "specialist_result",
              assignmentId: validation.assignmentId,
              attempts: validation.attempts,
              driftedComponents: "",
              message: `Validation round ${round.seq} could not conclude: ${validation.assignmentId} spent ${validation.attempts} attempts on infrastructure failures (${validation.reason}) and rendered no verdict.`,
            });
            return { execution: latest, ...delivery };
          },
        );
      }

      // The round stays OPEN with its settled verdicts intact, so a resume can
      // re-verify the candidate and rerun only the lanes that never settled.
      journal.leaveOpen = round !== null;
      const haltReason: GraphWorkflowHaltReason = {
        type: "validator_infra_error",
        contextId: input.contextId,
        engine: validation.engine,
        infraReason: validation.reason,
        message: validation.message,
        summary: null,
        assignmentId: validation.assignmentId,
        attempts: validation.attempts,
        roundSeq: round?.seq ?? null,
      };
      await onHalt(haltReason);
      throw new IterationHaltedError(haltReason, undefined, {
        failureAlreadyCounted: true,
      });
    }

    // At least one validator lane ended its turn with a pending question and no
    // verdict (Req 3.2). Park every asking lane — never reopen tasks, never
    // increment consecutiveFailureCount, never record a validation-failure event
    // (Req 3.3). Either way this iteration ends here: a lane that is waiting on
    // the human, or that has an answer nobody has handed it yet, has not
    // reported, so the round stays open and the context does not finalize.
    if (validation.kind === "asked_user") {
      const askingLaneKeys = new Set(
        validation.parked.map((lane) =>
          laneStateKey("context_validator", lane.assignmentId),
        ),
      );
      const parked = await parkContextForUserInput({
        input,
        execLogger,
        lanes: validation.parked.map((lane) => ({
          laneKey: laneStateKey("context_validator", lane.assignmentId),
          conversationId: lane.conversationId,
          questionBatchId: lane.questionBatchId,
          questions: lane.questions,
        })),
        roundSeq: round?.seq ?? null,
        // The parked iteration result names one conversation; the first asking
        // lane in cohort order is the deterministic choice, and every lane's
        // own conversation is recorded on its parked record.
        conversationId: validation.parked[0].conversationId,
      });

      if (parked !== null) {
        // A lane waiting on the human has not reported, so the round cannot
        // conclude. It stays OPEN with its settled verdicts intact: concluding
        // it here would discard the siblings' verdicts on this candidate, and
        // the answer would come back to a fresh round that re-reviewed work its
        // reviewers had already judged (R9, D8).
        journal.leaveOpen = round !== null;
        execLogger?.validation(input.contextId, "validation_round.parked", {
          roundSeq: round?.seq ?? null,
          parkedAssignmentIds: validation.parked.map(
            (lane) => lane.assignmentId,
          ),
        });
        return parked;
      }

      // No lane parked, because an answer had already landed for it. The two
      // windows that produce this are the same fact seen twice: the cohort's
      // park write happens only once every lane settles, so a lane whose turn
      // ended early can be answered while a sibling is still reviewing — and on
      // a partial resume the answered lane may be one this pass carried forward
      // as parked and never dispatched.
      //
      // Either way the answer is HERE and undelivered, and the lane it belongs
      // to still owes this candidate a verdict. So the round stays open and the
      // iteration ends without finalizing, which sends the loop back to its
      // user-input wait to consume the answers and re-dispatch the asking lane.
      // Falling through would conclude the round over a live record — discarding
      // the siblings' verdicts on this candidate — and then complete the context
      // on a lane that never reported, or drive finalize at an illegal
      // `awaiting_user_input -> completed` transition when a sibling's park is
      // still standing (R9: the round concludes only after every lane settles;
      // R9.1: every answer delivered to its own lane exactly once).
      const afterFastAnswer = await loadCurrentExecution(
        input.projectPath,
        input.sessionName,
      );
      const undelivered = answeredPendingUserInputs(
        afterFastAnswer.contextStates[input.contextId] ?? {
          pendingUserInputs: {},
        },
      ).filter((entry) => askingLaneKeys.has(entry.laneKey));
      if (undelivered.length > 0) {
        journal.leaveOpen = round !== null;
        execLogger?.validation(
          input.contextId,
          "validation_round.answers_pending_delivery",
          {
            roundSeq: round?.seq ?? null,
            laneKeys: undelivered.map((entry) => entry.laneKey),
          },
        );
        logger.info(
          "graph-workflow.validation_round.answers_pending_delivery",
          {
            executionId: afterFastAnswer.id,
            contextId: input.contextId,
            roundSeq: round?.seq ?? null,
            laneKeys: undelivered.map((entry) => entry.laneKey),
          },
        );
        return {
          conversationId: validation.parked[0].conversationId,
          execution: afterFastAnswer,
          shouldContinueInContext: false,
        };
      }

      // Nothing parked and nothing owed: the question was withdrawn under this
      // pass. The caller falls through to the normal finalize path.
      return null;
    }

    // A blocking seat refused the CONTRACT rather than the work. The round
    // concluded — every seat reported — but on a finding no task here can
    // answer, so neither of the two conclusions below applies: reopening tasks
    // would hand an implementer a contract it has no authority over, and
    // falling through to the pass path would clear the failure counter and
    // finish a context a reviewer just called unsatisfiable.
    //
    // The whole reaction is a durable, resumable halt: nothing is reopened and
    // nothing is charged (the reopen loop is what this response exists to
    // escape), and the round is left OPEN so the frozen candidate and every
    // seat's verdict stay readable to the recovery that answers it. The halt
    // carries the aggregated findings themselves, because plan repair and the
    // operator both act on the finding rather than on a count of findings.
    //
    // It is recorded and then RETURNED, not thrown. Both loops treat a returned
    // result as a park — no finalize, no failure accounting — where a thrown
    // `IterationHaltedError` is swallowed and still finalizes; production
    // signal-halt records a PENDING reason and leaves the execution running, so
    // that finalize would find no remaining tasks and write `completed` over
    // the context this halt just stopped. `completed` is terminal.
    if (validation.kind === "plan_defect") {
      journal.leaveOpen = round !== null;
      const haltReason: GraphWorkflowHaltReason = {
        type: "plan_defect",
        contextId: input.contextId,
        planDefects: validation.planDefects.map((defect) => ({ ...defect })),
        roundSeq: round?.seq ?? null,
        summary: null,
      };
      execLogger?.validation(input.contextId, "validation_round.plan_defect", {
        roundSeq: round?.seq ?? null,
        planDefectCount: validation.planDefects.length,
        assignmentIds: validation.planDefects.map(
          (defect) => defect.assignmentId,
        ),
      });
      logger.warn("graph-workflow.context_validation.plan_defect", {
        executionId: preContextValidationExecution.id,
        contextId: input.contextId,
        roundSeq: round?.seq ?? null,
        planDefectCount: validation.planDefects.length,
      });
      await onHalt(haltReason);
      return {
        conversationId,
        execution: await loadCurrentExecution(
          input.projectPath,
          input.sessionName,
        ),
        shouldContinueInContext: false,
      };
    }

    // The last identity check, immediately before anything about this round
    // becomes durable. It runs BEFORE the reopen/reset mutations, which
    // themselves move the task-state generation — checking after them would
    // compare the candidate against a tree this very write had just changed.
    if (
      round !== null &&
      (validation.kind === "pass" || validation.kind === "fail")
    ) {
      const beforePublish = await observeCandidate(
        input,
        await loadCurrentExecution(input.projectPath, input.sessionName),
      );
      if (
        beforePublish.kind === "unavailable" ||
        !candidateIdentityMatches(round.candidate, beforePublish.candidate)
      ) {
        return await concludeRoundOnCandidateMismatch({
          input,
          execLogger,
          conversationId,
          round,
          observed: beforePublish,
          stage: "aggregate",
          assignmentId: null,
          journal,
          onHalt,
        });
      }
    }

    // The cohort's per-member detail, joined to the identity the round froze.
    // The top-level single-reviewer refs survive only for a cohort of one: with
    // several reviewers, naming one at the top would attribute the round to an
    // arbitrary member (D12).
    const verdict =
      validation.kind === "pass" || validation.kind === "fail"
        ? validation
        : null;
    // Fenced to this round's `seq`, so a record a newer round has already
    // replaced contributes nothing — its advisories belong to that round's
    // delivery, and its verdicts to that round's aggregate.
    const roundRecord = await loadCurrentRoundRecord(input, round);
    const specialistEntries = buildSpecialistEntries(
      roundRecord ?? round,
      verdict?.specialists,
    );
    const aggregateRefs =
      specialistEntries.length > 1
        ? { sessionRef: null, reviewArtifact: null }
        : {
            sessionRef: verdict?.sessionRef ?? null,
            reviewArtifact: verdict?.reviewArtifact ?? null,
          };

    const freshAdvisories =
      roundRecord === null ? [] : collectFreshAdvisories(roundRecord);

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
        advisories: freshAdvisories,
      });
      // Delivered only where a message actually carried them. A rejection with
      // nothing to reopen sends no message, so its advisories stay fresh rather
      // than being marked delivered to a turn that never happened.
      const deliveredAdvisories =
        validation.reopenTaskIds.length > 0
          ? freshAdvisories.map((advisory) => advisory.identity)
          : [];

      const executionWithValidationEvent =
        await reopenTasksAfterContextValidationFailure({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          contextId: input.contextId,
          reopenTaskIds: validation.reopenTaskIds,
          taskFailureMessages,
          deliveredAdvisories,
          ...(round !== null
            ? {
                refuseIfSuperseded: (execution) =>
                  roundStillCurrent(execution, input.contextId, round)
                    ? null
                    : publishRoundSuperseded({ input, execution, round }),
              }
            : {}),
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
              ...aggregateRefs,
              ...(round !== null
                ? { round: { seq: round.seq, specialists: specialistEntries } }
                : {}),
            }),
        });

      if (
        round !== null &&
        !roundStillCurrent(executionWithValidationEvent, input.contextId, round)
      ) {
        return abandonSupersededConclusion({
          input,
          execLogger,
          round,
          journal,
        });
      }

      journal.outcome = "failed";
      logRoundConcluded(input, execLogger, round, "failed");
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
        throw new IterationHaltedError(haltReason, undefined, {
          failureAlreadyCounted: true,
        });
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

    const passed = await deps.executionRepository.mutateActive(
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

        // The pass has the same authority problem as the rejection: clearing
        // the failure counter on a superseded round would credit the context's
        // CURRENT work with a review of a candidate it has already left.
        if (
          round !== null &&
          !roundStillCurrent(reset, input.contextId, round)
        ) {
          const delivery = publishRoundSuperseded({
            input,
            execution: reset,
            round,
          });
          return { execution: latest, ...delivery };
        }
        // A structured handoff clears failure accounting only when its reviewed
        // candidate is published. Capture acceptance alone grants no credit
        // toward semantic convergence (R3, D4).
        if (!contextOwesOutput(reset, input.contextId)) {
          contextState.consecutiveFailureCount = 0;
        }
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
          ...aggregateRefs,
          ...(round !== null
            ? { round: { seq: round.seq, specialists: specialistEntries } }
            : {}),
        });
        return { execution: reset, ...delivery };
      },
    );

    if (round !== null && !roundStillCurrent(passed, input.contextId, round)) {
      return abandonSupersededConclusion({ input, execLogger, round, journal });
    }

    // Banked BEFORE the advisory turn: the round's verdict is settled and
    // published by here, so a turn that fails afterwards must still leave the
    // round concluded as what it was, not as an outcome nobody rendered.
    journal.outcome = "passed";

    // The round passed and its specialists still had something to say. The
    // context does NOT finish here: it enters the advisory-response phase, which
    // owes the implementer one turn (R6) and then owes R8 an answer to whether
    // that turn left the certified candidate where it found it. The phase is
    // written durably before the turn runs, so a process that dies inside the
    // turn comes back owing the same turn rather than owing a fresh round.
    if (round !== null && freshAdvisories.length > 0) {
      await writeAdvisoryResponsePhase(input, {
        roundSeq: round.seq,
        phase: "awaiting_response",
        enteredAt: getNow(deps),
      });
      execLogger?.validation(input.contextId, "advisory_response.entered", {
        roundSeq: round.seq,
        advisoryCount: freshAdvisories.length,
      });
    }

    logRoundConcluded(input, execLogger, round, "passed");
    return null;
  }

  /**
   * The advisory-response phase, from the turn the implementer is owed to the
   * hash that decides what the context does next (R8, D8).
   *
   * The hash decides, and only the hash. A disposition is a claim about
   * intention — an implementer may decline every advisory and edit the tree
   * anyway, or address them all in prose and touch nothing — so certifying on
   * what the turn SAID would either ship a changed candidate nobody reviewed or
   * re-run a cohort over a candidate byte-identical to the one it just passed.
   * The candidate identity is a fact about the work, so it is what the engine
   * acts on.
   *
   * Identical: the context completes on the certification the round already
   * rendered. Nothing runs — not the script gate, not one validator lane — and
   * the dispositions are the only new record the turn produced.
   *
   * Changed: the phase becomes `recertifying` and the iteration ends asking to
   * continue in this context. The re-certification opens through the ordinary
   * round machinery on the next pass, which is what keeps the loop's own
   * fences — pending halts, the breaker, max iterations — between the two
   * rounds instead of inside a private loop that none of them can see.
   */
  async function processAdvisoryResponse(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    conversationId: string;
    /**
     * The implementer lane conversation this iteration ran on, when it had one.
     * The response turn rides it so the advisories are answered by the lane that
     * did the work; undefined on the validation-only path, whose
     * `conversationId` is bookkeeping rather than a live lane.
     */
    laneConversationId?: string;
  }): Promise<GraphWorkflowIterationResult | null> {
    const { input, execLogger, conversationId, laneConversationId } = params;
    const execution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );
    // The response turn is a lane turn like any other: an execution that was
    // aborted, paused, or halted while it ran resumes into this same check.
    if (execution.status !== "running") return null;

    const contextState = execution.contextStates[input.contextId];
    if (contextState?.advisoryResponse?.phase !== "awaiting_response") {
      return null;
    }
    const phase = contextState.advisoryResponse;

    const round = contextState.validationRound ?? null;
    if (round === null || round.seq !== phase.roundSeq) {
      // The certification this phase belongs to is not the round the context is
      // on. Nothing here can be answered against a round that is gone, so the
      // phase is retired rather than left blocking every future round.
      logger.warn("graph-workflow.advisory_response.phase_orphaned", {
        executionId: execution.id,
        contextId: input.contextId,
        phaseRoundSeq: phase.roundSeq,
        roundSeq: round?.seq ?? null,
      });
      await writeAdvisoryResponsePhase(input, null);
      return null;
    }

    // Read back off the record, so a phase resumed after the turn already ran
    // (and was recorded) asks for nothing a second time and goes straight to
    // the comparison the turn is still owed.
    const advisories = collectFreshAdvisories(round);
    if (advisories.length > 0) {
      await deliverAdvisoryResponse({
        input,
        execLogger,
        laneConversationId,
        round,
        advisories,
      });
    }

    const observed = await observeCandidate(
      input,
      await loadCurrentExecution(input.projectPath, input.sessionName),
    );
    if (
      observed.kind === "resolved" &&
      candidateIdentityMatches(round.candidate, observed.candidate)
    ) {
      await writeAdvisoryResponsePhase(input, null);
      execLogger?.validation(
        input.contextId,
        "advisory_response.candidate_unchanged",
        { roundSeq: round.seq },
      );
      logger.info("graph-workflow.advisory_response.candidate_unchanged", {
        executionId: execution.id,
        contextId: input.contextId,
        roundSeq: round.seq,
      });
      return null;
    }

    // An unreadable tree lands here with the drift: the phase cannot prove the
    // candidate is the one that was certified, and "cannot prove" is the same
    // answer as "is not" when the alternative is completing on a certification
    // that may no longer describe the work.
    const drift =
      observed.kind === "resolved"
        ? describeCandidateDrift(round.candidate, observed.candidate)
        : `candidate unreadable (${observed.reason})`;
    const recertifying = await writeAdvisoryResponsePhase(input, {
      roundSeq: round.seq,
      phase: "recertifying",
      enteredAt: getNow(deps),
    });
    execLogger?.validation(
      input.contextId,
      "advisory_response.recertification_required",
      { roundSeq: round.seq, drift },
    );
    logger.info("graph-workflow.advisory_response.recertification_required", {
      executionId: execution.id,
      contextId: input.contextId,
      roundSeq: round.seq,
      drift,
    });
    return {
      conversationId,
      execution: recertifying,
      // The context is NOT done: the next pass opens the blocking-only round
      // that decides whether the changed candidate is still certified.
      shouldContinueInContext: true,
    };
  }

  /**
   * Deliver a passing round's advisories and record what came back.
   *
   * Ordered deliver-then-record because only the turn's return proves delivery
   * happened: marking first would let a turn that never dispatched leave the
   * round claiming the implementer had seen advisories it never received. The
   * reverse risk — a crash between the turn and the write — costs at most a
   * re-delivery inside a round that this call is about to conclude anyway.
   *
   * A turn that produces no gate-validated disposition set throws, so it never
   * reaches the write at all: the batch stays undelivered and undisposed, the
   * round still concludes as the `passed` it was, and the failure surfaces as a
   * halt rather than as a context completed over an advisory nobody answered.
   */
  async function deliverAdvisoryResponse(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    laneConversationId: string | undefined;
    round: GraphWorkflowValidationRound | null;
    advisories: readonly GraphWorkflowValidationAdvisory[];
  }): Promise<void> {
    const { input, execLogger, laneConversationId, round, advisories } = params;
    if (!deps.advisoryResponseService || round === null) return;

    const execution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );
    const contextDefinition = getContextDefinition(execution, input.contextId);
    const conversationId = await resolveImplementerTurnConversationId({
      input,
      execution,
      laneConversationId,
      backend: contextDefinition.implementer.agent.backend,
    });

    execLogger?.iteration(input.contextId, "advisory_response.started", {
      roundSeq: round.seq,
      conversationId,
      advisoryCount: advisories.length,
    });

    const outcome = await deps.advisoryResponseService.runAdvisoryResponse({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution,
      contextId: input.contextId,
      conversationId,
      advisories,
      ...(input.executionTarget !== undefined
        ? { executionTarget: input.executionTarget }
        : {}),
    });

    // Delivered and disposed of are one write, never two: the turn returns a
    // gate-validated disposition for every advisory in the batch or it throws,
    // so this is the only state either field can reach. A record where delivery
    // landed and the answers did not would be the state R7 forbids, and here it
    // is unreachable rather than merely avoided.
    const recordedAt = getNow(deps);
    await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const current =
          next.contextStates[input.contextId]?.validationRound ?? null;
        // Fenced to the round that raised them: a newer round's advisories are
        // its own to deliver, and stamping them here would silence a batch
        // nobody has seen.
        if (current === null || current.seq !== round.seq) return latest;
        markAdvisoriesDelivered(
          current,
          advisories.map((advisory) => advisory.identity),
          recordedAt,
        );
        recordAdvisoryDispositions(current, outcome.dispositions, recordedAt);
        return next;
      },
    );

    execLogger?.iteration(input.contextId, "advisory_response.recorded", {
      roundSeq: round.seq,
      dispositions: outcome.dispositions.map((entry) => entry.disposition),
    });
    logger.info("graph-workflow.advisory_response.recorded", {
      executionId: execution.id,
      contextId: input.contextId,
      roundSeq: round.seq,
      dispositionCount: outcome.dispositions.length,
    });
  }

  /**
   * The outcome a round is heading for, recorded as the stages decide it so the
   * release in `finally` can conclude the round with the right one — including
   * on the paths that return through the normal validation flow rather than
   * through an incident.
   */
  interface RoundJournal {
    outcome: ValidationRoundOutcome | null;
    /**
     * Set when the round must survive this call still open: a round left with
     * only infrastructure outcomes never concluded, so concluding it on the way
     * out would erase the very fact a resume needs — which lanes still owe a
     * verdict on this candidate.
     */
    leaveOpen?: boolean;
  }

  function logRoundConcluded(
    input: GraphWorkflowIterationInput,
    execLogger: ReturnType<typeof getExecutionLogger>,
    round: GraphWorkflowValidationRound | null,
    outcome: ValidationRoundOutcome,
  ): void {
    if (round === null) return;
    execLogger?.validation(input.contextId, "validation_round.concluded", {
      roundSeq: round.seq,
      outcome,
      rosterSize: round.roster.length,
    });
    logger.info("graph-workflow.validation_round.concluded", {
      contextId: input.contextId,
      roundSeq: round.seq,
      outcome,
    });
  }

  interface GraphWorkflowOutputCaptureRejection {
    summary: string;
    issues: readonly GraphWorkflowValidationIssue[];
  }

  /**
   * Read back the rejection recorded for this context's last capture attempt,
   * so a retry turn is told what the gate refused instead of guessing. Returns
   * undefined when the latest validation event is anything else (a passing
   * result, or a context-validator verdict).
   *
   * MUST be sampled before the context validator runs this iteration: the
   * lookup resolves the single most recent validation-result row, and a context
   * whose tasks are all done re-validates on every capture retry, so a passing
   * context-validator verdict would otherwise bury the rejection that motivated
   * the retry.
   */
  async function resolveLatestOutputSchemaRejection(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
    contextId: string,
  ): Promise<GraphWorkflowOutputCaptureRejection | undefined> {
    const contextDef = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === contextId,
    );
    // No schema, no capture service, or an output already banked: nothing can
    // retry, so skip the read entirely rather than spending it every iteration.
    if (
      !deps.outputCaptureService ||
      contextDef?.outputSchema === undefined ||
      execution.contextOutputs[contextId] !== undefined
    ) {
      return undefined;
    }

    const latest = await deps.findLatestContextValidationEvent(
      projectPath,
      sessionName,
      execution.id,
      contextId,
    );
    const event = latest?.event;
    if (
      event === undefined ||
      event.type !== "graph-workflow-validation-result" ||
      event.kind !== "output_schema" ||
      event.pass
    ) {
      return undefined;
    }
    return { summary: event.summary, issues: event.issues };
  }

  /**
   * The D2 exit-evaluator branch (Req 2, 3).
   *
   * A context that declares an `outputSchema` and has finished its tasks is NOT
   * complete until a validated output exists. Instead of finalizing, this
   * dispatches one format turn on the context's lane conversation and lets the
   * canonical structured-output gate decide:
   *
   *  - accepted → stage a candidate for semantic review; the exit evaluator
   *    publishes exactly that candidate after all configured checks pass;
   *  - refused  → record an `output_schema` validation failure, increment the
   *    SAME consecutive-failure accounting the agent validator feeds, consume an
   *    iteration slot, and either trip the breaker or return a keep-going result
   *    so the next iteration retries the capture.
   *
   * Returns null for every context that does not declare a schema, for a
   * context whose output is already captured (exactly one output per context),
   * and whenever the capture service is not wired — those paths are byte-for-
   * byte the pre-D2 behavior.
   */
  /**
   * The conversation an engine-dispatched implementer turn runs on — the D2
   * format turn, and the advisory-response turn (D6).
   *
   * D3 puts the turn on the context's EXISTING implementer lane conversation so
   * the payload is restated from the work that conversation already did, so the
   * durable lane record wins. Two fallbacks follow it:
   *
   *  - the caller's own conversation, which `runIteration` resolved for this
   *    turn (authoritative even when no continuity service manages lanes);
   *  - a freshly created one, for a context that never opened an implementer
   *    conversation at all — a zero-task schema context reaches capture through
   *    the validation-only path, whose bookkeeping id is a historical task
   *    conversation or the literal `validation-only` sentinel. Dispatching onto
   *    either would hand the actor a conversation that does not exist.
   *
   * The created conversation is deliberately NOT written back into
   * `laneStates`: lane records are the continuity module's to own, and this
   * degenerate path has no work to carry forward anyway (a retry re-reads its
   * previous rejection from the recorded validation failure).
   */
  async function resolveImplementerTurnConversationId(params: {
    input: GraphWorkflowIterationInput;
    execution: GraphWorkflowExecution;
    laneConversationId: string | undefined;
    backend: AgentBackendId;
  }): Promise<string> {
    const { input, execution, laneConversationId, backend } = params;
    const durableLaneConversationId =
      execution.laneStates[input.contextId]?.["implementer"]
        ?.workflowConversationId;
    if (durableLaneConversationId) {
      return durableLaneConversationId;
    }
    if (laneConversationId !== undefined) {
      return laneConversationId;
    }
    const conversation = await deps.createConversation(
      input.projectPath,
      input.sessionName,
      // The context's OWN backend: the turn is dispatched with this context's
      // model selection and timeout, and a conversation created on the service
      // default would run them against a different backend entirely.
      { role: "iteration", agentBackend: backend },
    );
    return conversation.id;
  }

  async function processContextOutputCapture(params: {
    input: GraphWorkflowIterationInput;
    execLogger: ReturnType<typeof getExecutionLogger>;
    /** Conversation id carried on the returned iteration result. */
    conversationId: string;
    /**
     * The implementer lane conversation this turn already resolved, when the
     * caller had one. Undefined makes the capture resolve or create it rather
     * than inherit the caller's bookkeeping id.
     */
    laneConversationId: string | undefined;
    /** Sampled by the caller before this iteration's validator turn. */
    previousRejection: GraphWorkflowOutputCaptureRejection | undefined;
    onHalt: (reason: GraphWorkflowHaltReason) => Promise<void>;
  }): Promise<
    | GraphWorkflowIterationResult
    | { outputCandidate: GraphWorkflowContextOutput }
    | null
  > {
    const {
      input,
      execLogger,
      conversationId,
      laneConversationId,
      previousRejection,
      onHalt,
    } = params;
    if (!deps.outputCaptureService) {
      return null;
    }

    const execution = await loadCurrentExecution(
      input.projectPath,
      input.sessionName,
    );
    if (execution.status !== "running") {
      return null;
    }

    const contextDef = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === input.contextId,
    );
    const outputSchema = contextDef?.outputSchema;
    if (contextDef === undefined || outputSchema === undefined) {
      return null;
    }
    if (execution.contextOutputs[input.contextId] !== undefined) {
      return null;
    }
    const state = execution.contextStates[input.contextId];
    const previousRound = state?.validationRound;
    if (
      previousRound?.outputCandidate &&
      (isValidationRoundOpen(previousRound) ||
        state?.advisoryResponse?.phase === "awaiting_response")
    ) {
      return { outputCandidate: previousRound.outputCandidate };
    }
    if (getIncompleteTasks(execution, input.contextId).length > 0) {
      return null;
    }

    const captureConversationId = await resolveImplementerTurnConversationId({
      input,
      execution,
      laneConversationId,
      backend: contextDef.implementer.agent.backend,
    });

    execLogger?.iteration(input.contextId, "output_capture.started", {
      conversationId: captureConversationId,
      retry: previousRejection !== undefined,
    });

    const outcome = await deps.outputCaptureService.captureContextOutput({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution,
      contextId: input.contextId,
      conversationId: captureConversationId,
      outputSchema,
      ...(input.executionTarget !== undefined
        ? { executionTarget: input.executionTarget }
        : {}),
      ...(previousRejection !== undefined ? { previousRejection } : {}),
    });

    if (outcome.kind === "captured") {
      const capturedAt = getNow(deps);
      const outputCandidate: GraphWorkflowContextOutput = {
        value: outcome.value,
        capturedAt,
        iteration: Math.max(1, state?.iterationCount ?? 0),
        parse: outcome.parse,
      };
      execLogger?.iteration(input.contextId, "output_capture.captured", {
        conversationId: captureConversationId,
        source: outcome.parse.source,
        repaired: outcome.parse.repaired === true,
      });
      logger.info("graph-workflow.output_capture.captured", {
        executionId: execution.id,
        contextId: input.contextId,
        source: outcome.parse.source,
      });
      return { outputCandidate };
    }

    execLogger?.validation(input.contextId, "output_capture.rejected", {
      conversationId: captureConversationId,
      issueCount: outcome.issues.length,
      issuePaths: outcome.issues.map((issue) => issue.path ?? issue.title),
    });
    logger.warn("graph-workflow.output_capture.rejected", {
      executionId: execution.id,
      contextId: input.contextId,
      issueCount: outcome.issues.length,
    });

    let failureCount = 0;
    let iterationCount = 0;
    const rejectedExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        const next = cloneExecution(latest);
        const contextState = next.contextStates[input.contextId];
        if (!contextState) {
          throw new Error(
            `Execution context "${input.contextId}" does not exist in runtime state`,
          );
        }
        // Same accounting the agent-validator failure path feeds, so a context
        // that cannot satisfy its own output contract trips the breaker on the
        // configured threshold rather than looping forever.
        contextState.consecutiveFailureCount =
          (contextState.consecutiveFailureCount ?? 0) + 1;
        // A failed capture is a real agent turn, so it consumes an iteration
        // slot even on the validation-only re-entry path, which seeds none (D4).
        contextState.iterationCount += 1;
        failureCount = contextState.consecutiveFailureCount;
        iterationCount = contextState.iterationCount;
        next.machineSnapshot = buildLifecycleSnapshot(next, {
          hasLiveIteration: true,
        });
        const delivery = eventPublisher.publishValidationResult({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: next,
          contextId: input.contextId,
          validatorType: "context",
          kind: "output_schema",
          pass: false,
          summary: outcome.summary,
          issues: outcome.issues,
          reopenTaskIds: [],
          sessionRef: null,
          reviewArtifact: null,
          rejectedOutput: outcome.rejectedText,
          gateRepair: outcome.gateRepair ?? null,
          // The contract as it stood when it refused. A live edit may replace
          // it while the halt is open, so the halt surfaces read the snapshot
          // rather than the context's current schema (R3.2).
          rejectedAgainstSchema:
            next.workingDefinition.executionContexts.find(
              (entry) => entry.id === input.contextId,
            )?.outputSchema ?? null,
        });
        return { execution: next, ...delivery };
      },
    );

    const threshold = getConsecutiveFailureThreshold(contextDef);
    if (shouldTripCircuitBreaker(failureCount, threshold)) {
      execLogger?.decision("circuit_breaker.tripped", {
        contextId: input.contextId,
        consecutiveFailureCount: failureCount,
        threshold,
        condition: "output_schema_validation",
      });
      const haltReason: GraphWorkflowHaltReason = {
        type: "circuit_breaker",
        contextId: input.contextId,
        condition: "output_schema_validation",
        failureCount,
        summary: outcome.summary,
      };
      await onHalt(haltReason);
      // The rejection above already incremented the streak this halt reports.
      throw new IterationHaltedError(haltReason, undefined, {
        failureAlreadyCounted: true,
      });
    }

    execLogger?.iteration(input.contextId, "output_capture.retry_scheduled", {
      conversationId: captureConversationId,
      consecutiveFailureCount: failureCount,
      iterationCount,
    });
    return {
      conversationId,
      execution: rejectedExecution,
      // The context is NOT done: the next iteration re-enters the exit
      // evaluator and retries the capture.
      shouldContinueInContext: true,
    };
  }

  async function processContextExit(
    params: Parameters<typeof processContextOutputCapture>[0],
  ): Promise<GraphWorkflowIterationResult | null> {
    const capture = await processContextOutputCapture(params);
    if (capture !== null && !("outputCandidate" in capture)) return capture;
    const outputCandidate = capture?.outputCandidate;
    const beforeReview = await loadCurrentExecution(
      params.input.projectPath,
      params.input.sessionName,
    );
    const reviewRequired = contextReviewPlan(
      beforeReview,
      params.input.contextId,
    ).roundApplies;
    const validation = await processContextCompletionValidation({
      ...params,
      outputCandidate,
    });
    if (validation !== null) return validation;
    const advisory = await processAdvisoryResponse(params);
    if (advisory !== null) return advisory;
    if (outputCandidate === undefined) return null;

    const { input, execLogger } = params;
    let promoted = false;
    const execution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (latest) => {
        if (
          latest.status !== "running" ||
          latest.pendingHaltReason !== null ||
          getIncompleteTasks(latest, input.contextId).length > 0
        )
          return latest;
        const context = getContextDefinition(latest, input.contextId);
        const state = latest.contextStates[input.contextId];
        if (!state || state.advisoryResponse) return latest;
        const round = reviewRequired ? state.validationRound : null;
        if (reviewRequired && !round) return latest;
        if (
          round &&
          (round.phase !== "concluded" || round.outcome !== "passed")
        )
          return latest;
        if (round) {
          const observed = freezeValidationCandidate({
            tree: round.candidate,
            taskStates: latest.taskStates,
            contextId: input.contextId,
            outputSchema: context.outputSchema,
            outputValue: outputCandidate.value,
          });
          if (!candidateIdentityMatches(round.candidate, observed))
            return latest;
        }
        const next = cloneExecution(latest);
        next.contextOutputs[input.contextId] = {
          ...outputCandidate,
          ...(round ? { reviewedCandidate: round.candidate } : {}),
        };
        next.contextStates[input.contextId]!.consecutiveFailureCount = 0;
        promoted = true;
        return next;
      },
    );
    if (promoted) {
      const reviewedCandidate =
        execution.contextOutputs[input.contextId]?.reviewedCandidate;
      execLogger?.iteration(input.contextId, "output_capture.published", {
        reviewedCandidate,
      });
      logger.info("graph-workflow.output_capture.published", {
        executionId: execution.id,
        contextId: input.contextId,
        reviewedCandidate,
      });
    }
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
    let finalizationWithheldMissingOutput = false;

    // Frozen BEFORE the parking mutation, because reading git inside a
    // `mutateActive` reducer would put I/O in the write-queue critical section.
    // The gate branch below re-derives its own condition from the latest state;
    // a scope frozen for a branch that is not taken is simply dropped.
    const frozenApprovalScope = await freezeApprovalScope(
      input,
      currentExecution,
    );

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

        // Another writer has already taken this context back for a FRESH
        // iteration — retryable-error recovery and pause-to-edit both return it
        // to a schedulable status. Neither halts the run, so the mid-flight
        // guard above cannot see it: recovery deliberately clears `haltReason`
        // and leaves `execution.status` on "running". This iteration no longer
        // owns the context, so every outcome it would write is stale — and
        // `completed` is worse than stale, because the transition table refuses
        // `ready` -> `completed` and the throw escapes the write queue as an
        // `execution_loop_failed` halt, turning a recoverable error into a dead
        // run. Leave the context wherever the new owner put it, and report no
        // continuation so this iteration's caller stops rather than racing the
        // re-dispatch.
        //
        // `halted` is the same loss of ownership reached by the other door. A
        // halt signalled from inside this iteration records a PENDING reason and
        // leaves `execution.status` on "running" (see `signalHalt`), so the
        // mid-flight guard above cannot see it, and the thrown
        // `IterationHaltedError` is swallowed by both loops. Validation only
        // runs once every task is done, so the finalizer then finds nothing
        // remaining and would write `completed` over the context its own halt
        // just stopped — releasing the lane to land and merge work no validator
        // certified. The halt owns the context now; resume is what moves it.
        if (
          finalizedContextState.status === "ready" ||
          finalizedContextState.status === "pending" ||
          finalizedContextState.status === "halted"
        ) {
          const withheldReason =
            finalizedContextState.status === "halted"
              ? "context_halted"
              : "context_rescheduled";
          execLogger?.iteration(
            input.contextId,
            "iteration.finalize_withheld_context_rescheduled",
            {
              conversationId,
              status: finalizedContextState.status,
              reason: withheldReason,
            },
          );
          logger.info("graph-workflow.iteration.finalize_withheld", {
            executionId: finalizedExecution.id,
            contextId: input.contextId,
            reason: withheldReason,
            status: finalizedContextState.status,
          });
          shouldContinueInContext = false;
          finalizedExecution.machineSnapshot = buildLifecycleSnapshot(
            finalizedExecution,
            { hasLiveIteration: false },
          );
          return finalizedExecution;
        }

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
        } else if (contextOwesOutput(finalizedExecution, input.contextId)) {
          // Reaching the finalizer with tasks done, validators passed, and no
          // captured output means the capture did not succeed — the iteration
          // was halted (a tripped breaker throws IterationHaltedError, which
          // both loops swallow and still finalize). Production signal-halt
          // records a PENDING halt and leaves `execution.status` on "running",
          // so the guard above does not fire and this branch would otherwise
          // write `completed` over a halted context that never produced its
          // declared output (R2). Leave the context wherever the halt put it.
          finalizationWithheldMissingOutput = true;
        } else if (gateEnabled) {
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
        if (approvalRequestedAt !== null) {
          const delivery = eventPublisher.publishApprovalPending({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: finalizedExecution,
            contextId: input.contextId,
            conversationId,
            requestedAt: approvalRequestedAt,
          });
          return { execution: finalizedExecution, ...delivery };
        }
        return finalizedExecution;
      },
    );

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
      return {
        conversationId,
        execution: persistedExecution,
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

    const conversationId = pickConversationIdForValidationOnlyIteration(
      initialExecution,
      input.contextId,
    );
    let terminalErrorCaught = false;
    let parkedResult: GraphWorkflowIterationResult | null = null;
    try {
      const previousRejection = await resolveLatestOutputSchemaRejection(
        input.projectPath,
        input.sessionName,
        initialExecution,
        input.contextId,
      );
      parkedResult = await processContextExit({
        input,
        execLogger,
        conversationId,
        laneConversationId: undefined,
        previousRejection,
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
      // A thrower that already banked this failure (the output-capture
      // rejection) must not be counted a second time by the finalizer.
      terminalErrorCaught = !error.failureAlreadyCounted;
    }

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
        backend: context.implementer.agent.backend,
        modelSelection: context.implementer.agent.modelSelection,
        toolServer: toolServer.server,
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
        const latest = await loadCurrentExecution(
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
          const repoConfig = await (
            deps.readRepoConfig ?? defaultReadRepoConfig
          )(input.projectPath);
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
              sharedDocuments: seededExecution.sharedDocuments,
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

      // Sampled before the validator turn below, which would otherwise bury the
      // rejection this iteration is retrying (see the resolver's contract).
      const previousOutputRejection = await resolveLatestOutputSchemaRejection(
        input.projectPath,
        input.sessionName,
        initialExecution,
        input.contextId,
      );

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
        parkedResult = await processContextExit({
          input,
          execLogger,
          conversationId: conversation.id,
          laneConversationId: conversation.id,
          previousRejection: previousOutputRejection,
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
        // See the validation-only path: a halt whose thrower already banked the
        // failure must not be counted again by the finalizer.
        terminalErrorCaught = !error.failureAlreadyCounted;
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
