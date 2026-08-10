import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import path from "node:path";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  collectLandingProbeTargets,
  reconcileLandingIntents,
  recordLandingIntent,
} from "@/lib/workflow-graph/route-runtime";
import {
  createLandingEvidenceProber,
  type LandingEvidenceProber,
} from "@/lib/workflow-graph/landing-evidence";
import { StaleLoopFenceError } from "@/lib/workflow-graph/loop-fence";
import { releaseLoopPassSlotsForContexts } from "@/lib/workflow-graph/loop-budgets";
import {
  classifyContextSchedulability,
  contextsPresentInLane,
  type ContextSchedulability,
} from "@/lib/workflow-graph/lane-readiness";
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
} from "@/lib/workflow-graph/reset-context";
import {
  ResetAssignmentError,
  resetExecutionContextAssignment,
} from "@/lib/workflow-graph/reset-assignment";
import {
  deriveLaneWorktreePath,
  type ParallelWorktrees,
  type ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import {
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
  validateLaneId,
} from "@/lib/workflow-graph/lane-identity";
import {
  canonicalizeOwnership,
  classifyLaneAdmission,
  laneWorktreeExists,
  type CanonicalOwnership,
  type LaneOccupant,
} from "@/lib/workflow-graph/lane-admission";
import type { SessionState } from "@/lib/sessions/schemas";
import type { DirtyPath } from "@/lib/workflow-graph/errors";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import {
  buildLifecycleSnapshot,
  resetJoinForRetry,
  resetRunningJoinsToPending,
  transitionContextMergeStatus,
  transitionContextStatus,
} from "@/lib/workflow-graph/context-transitions";
import { readWorktreeDirtyPaths } from "@/lib/git/worktree";
import {
  validateLaunchInputs,
  type LaunchInputError,
} from "@/lib/workflow-graph/start-input-service";
import type { MutateActiveResult } from "@/lib/workflow-graph/execution-repository";
import type { TemplateTier } from "@/lib/workflow-graph/template-library-service";
import { computeUsedBackends } from "@/lib/workflow-graph/resolve-config";
import { stopExecutionLaneDevServers as defaultStopExecutionLaneDevServers } from "@/lib/workflow-graph/dev-server-lane-cleanup";
import {
  createPreflightPrerequisiteService,
  type MissingPrerequisite,
  type PreflightPrerequisiteService,
} from "@/lib/workflow-graph/preflight-prerequisite-service";
import { readConfig } from "@/lib/config/loader";
import { parkedQuestionConversationIds } from "@/lib/workflow-graph/pending-user-input";
import {
  createUserInputGateService,
  type UserInputGateService,
} from "@/lib/workflow-graph/user-input-gate";
import { sendConversationEvent } from "@/lib/workflows/conversation/manager";
import type { GlobalConfig } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  ContextPlacement,
  GraphWorkflowStatus,
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  assertGraphExecutionContractAccepted,
  createRegisteredGraphExecutionContract,
  type GraphExecutionContract,
} from "@/lib/workflow-graph/execution-contract-port";
import {
  contextIdsResumingInfraHalt,
  isValidationRoundOpen,
  resetValidationRoundAttempts,
} from "@/lib/workflow-graph/validation-round";
interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
  inputs: Record<string, string>;
  // The tier the template was launched from. Rides the definition tier onto the
  // execution as an additive audit annotation, parallel to `inputs`/boundInputs.
  launchedTier: TemplateTier;
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
  archiveActive(projectPath: string, sessionName: string): Promise<void>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  markContextEventsPreReset(
    projectPath: string,
    sessionName: string,
    executionId: string,
    contextId: string,
  ): Promise<number>;
}

export interface GraphWorkflowStartInput {
  projectPath: string;
  sessionName: string;
  definitionId: string;
  expectedDefinitionRevision?: number;
  /**
   * Template tier to resolve the definition from. Omitted defaults to
   * `"project"`, preserving every current caller (the per-project load).
   */
  tier?: TemplateTier;
  /**
   * Raw supplied launch values (parameter name → unvalidated value). Validated
   * by `validateLaunchInputs` inside the shared start path; omitted/empty is a
   * behavior-neutral zero-input launch.
   */
  parameters?: Record<string, unknown>;
}

/**
 * Raised by the shared start path when a pre-seed guard rejects the launch. The
 * `guard` discriminator lets the thin HTTP/MCP surface reconstruct the exact
 * 409 response (the active-execution message, or the structured
 * `uncommitted_changes` payload built from `dirtyPaths`) without re-deriving it
 * from a message string.
 */
export class WorkflowStartGuardError extends Error {
  readonly guard: "active_execution" | "uncommitted_changes";
  readonly dirtyPaths?: DirtyPath[];

  constructor(
    guard: "active_execution" | "uncommitted_changes",
    message: string,
    dirtyPaths?: DirtyPath[],
  ) {
    super(message);
    this.name = "WorkflowStartGuardError";
    this.guard = guard;
    if (dirtyPaths !== undefined) {
      this.dirtyPaths = dirtyPaths;
    }
  }
}

/**
 * Raised by the shared start path when start-input validation rejects the
 * launch. Carries the structured `LaunchInputError` so the surface can map it to
 * a 400 naming the offending parameter without re-parsing the message.
 */
export class WorkflowStartInputError extends Error {
  readonly inputError: LaunchInputError;

  constructor(inputError: LaunchInputError, message: string) {
    super(message);
    this.name = "WorkflowStartInputError";
    this.inputError = inputError;
  }
}

export class WorkflowDefinitionApprovalRequiredError extends Error {
  readonly code = "definition_approval_required" as const;
  readonly instruction: string;

  constructor(
    readonly executionId: string,
    readonly definitionId: string,
    readonly definitionRevision: number,
  ) {
    super(
      `Workflow execution ${executionId} was created and parked awaiting definition approval`,
    );
    this.name = "WorkflowDefinitionApprovalRequiredError";
    this.instruction = `Approve the pending workflow definition to resume execution ${executionId}.`;
  }
}

export type RecordDefinitionApprovalResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | {
      ok: false;
      reason:
        | "no_active_execution"
        | "not_awaiting_approval"
        | "already_decided"
        | "definition_mismatch"
        | "definition_revision_mismatch"
        | "execution_mismatch";
    };

export interface RecordDefinitionApprovalInput {
  projectPath: string;
  sessionName: string;
  expectedExecutionId?: string;
  expectedDefinitionId?: string;
  expectedDefinitionRevision?: number;
}

/**
 * Raised by the shared start path when the requested template does not exist in
 * the indicated tier (R3.4). Carries the `definitionId` + `tier` so a surface
 * can identify the missing template distinctly from every other rejection class.
 * The `message` keeps the established `'Workflow definition "<id>" was not
 * found'` shape so the HTTP handler's string-based 404 mapping and the MCP
 * tool's `not_found` detection continue to fire unchanged.
 */
export class WorkflowDefinitionNotFoundError extends Error {
  readonly definitionId: string;
  readonly tier: TemplateTier;

  constructor(definitionId: string, tier: TemplateTier) {
    super(`Workflow definition "${definitionId}" was not found`);
    this.name = "WorkflowDefinitionNotFoundError";
    this.definitionId = definitionId;
    this.tier = tier;
  }
}

export class WorkflowDefinitionRevisionMismatchError extends Error {
  readonly code = "definition_revision_mismatch" as const;

  constructor(
    readonly definitionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Workflow definition "${definitionId}" changed from revision ${expectedRevision} to revision ${actualRevision}`,
    );
    this.name = "WorkflowDefinitionRevisionMismatchError";
  }
}

/**
 * Raised by the shared start path when the deterministic prerequisite gate
 * rejects the launch (a declared path/skill prerequisite is unmet on the target
 * worktree, or its probe errored — fail-closed, R5.10). Carries the itemized
 * `missing` so the thin HTTP/MCP surface can reconstruct the structured
 * `prerequisites_unmet` response (each item's kind, scoped backend for a skill,
 * and `reason` of `absent`|`probe_error`) without re-deriving it from a message
 * string. Distinct from `WorkflowStartGuardError` (active-execution /
 * uncommitted-changes), `WorkflowStartInputError` (missing/invalid input), and
 * the not-found error so the rejection class is unambiguous (R6.2).
 */
export class WorkflowPrerequisitesUnmetError extends Error {
  readonly missing: MissingPrerequisite[];

  constructor(missing: MissingPrerequisite[], message: string) {
    super(message);
    this.name = "WorkflowPrerequisitesUnmetError";
    this.missing = missing;
  }
}

export interface GraphWorkflowRetryableIterationErrorInput {
  contextId: string;
  errorMessage: string;
}

export interface GraphWorkflowResumeOptions {
  /** Per-file operator guidance attached to every failed join reset by this
   *  resume; consumed by the next conflict-resolution attempt. */
  conflictGuidance?: ConflictDecisionInput[];
}

export type GraphWorkflowLifecycleAction =
  | "pause"
  | "resume"
  | "abort"
  | "complete"
  | "halt";

export class GraphWorkflowTransitionConflictError extends Error {
  readonly code = "workflow_transition_conflict" as const;

  constructor(
    readonly action: GraphWorkflowLifecycleAction,
    readonly currentStatus: GraphWorkflowStatus,
    readonly allowedStatuses: readonly GraphWorkflowStatus[],
    message: string,
  ) {
    super(message);
    this.name = "GraphWorkflowTransitionConflictError";
  }
}

function assertLifecycleTransitionAllowed(
  execution: GraphWorkflowExecution,
  action: GraphWorkflowLifecycleAction,
  allowedStatuses: readonly GraphWorkflowStatus[],
  message: string,
): void {
  if (allowedStatuses.includes(execution.status)) return;
  throw new GraphWorkflowTransitionConflictError(
    action,
    execution.status,
    allowedStatuses,
    message,
  );
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
    tier: TemplateTier,
  ): Promise<WorkflowDefinitionRecord | null>;
  executionContract?: GraphExecutionContract;
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
  /**
   * Read the uncommitted (tracked + untracked, non-ignored) changes in a
   * session worktree. The shared start path uses it for the dirty-worktree
   * guard. Defaults to the real `git status --porcelain` reader.
   */
  readSessionWorktreeDirtyPaths?(worktreePath: string): Promise<DirtyPath[]>;
  /**
   * Deterministic pre-flight prerequisite gate. The shared start path invokes
   * it after the dirty-worktree guard + tier resolve and before start-input
   * validation/substitution, so a missing prerequisite halts the launch with a
   * distinct diagnostic and seeds nothing. Defaults to the real report-only
   * service over the production probes.
   */
  preflightService?: PreflightPrerequisiteService;
  /**
   * Read the global config, used to resolve the workflow's used-backend set
   * (per-context implementer + enabled context-validator backends) for the
   * prerequisite gate. Defaults to the real config loader.
   */
  readGlobalConfig?(): Promise<GlobalConfig>;
  createBatchId?(): string;
  /**
   * Signal the in-flight Claude Code SDK query for a running task's
   * conversation to abort. Invoked once per unique conversationId across
   * running tasks on pause/abort/halt so the orchestrator does not leave
   * an orphan query running concurrently with the next iteration after
   * resume.
   */
  abortConversation?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): void;
  abortExecutionLoop?(projectPath: string, sessionName: string): void;
  /**
   * Stop dev servers running in an execution's lane worktrees. Invoked on
   * abort/halt/drain/reset so a workflow that ends (or has a context reset)
   * never leaves orphaned lane dev servers. Defaults to the real worktree-
   * scoped registry stop; injected in tests to assert invocation.
   */
  stopExecutionLaneDevServers?(input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
    contextIds?: string[];
  }): Promise<void>;
  /**
   * User-input gate. Pause uses it to end the in-flight validation round and
   * withdraw exactly the validator questions that round parked (pause-to-edit,
   * R9). Defaults to a service over this manager's repository.
   */
  userInputGateService?: UserInputGateService;
  /**
   * Stop a lane conversation's actor (and with it the backend subprocess) when
   * a per-assignment reset retires it. Best-effort: a throw is logged, never a
   * reset failure — the durable state is already committed.
   */
  retireLaneConversation?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): void;
  /**
   * Read the replayable landing evidence off a context's branch (D4 decision
   * D8) so restart reconciliation settles commit-mode intents from what the
   * committer actually left behind. Defaults to the real git-backed prober.
   */
  landingEvidenceProber?: LandingEvidenceProber;
}

export interface ScheduleEligibleContextsInput {
  projectPath: string;
  sessionName: string;
  /**
   * Upper bound on the number of contexts this pass may schedule. Omit for
   * unbounded. The scheduler also forwards the running budget to the
   * classifier so each eligible context sees its own remaining capacity.
   */
  capacityRemaining?: number;
  /**
   * Whether the scheduler may place a context on the session worktree.
   * Defaults to `true`. When `false`, classifier results that would otherwise
   * land on the session lane are routed to a freshly forked worktree lane.
   */
  sessionLaneEnabled?: boolean;
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
  expectedExecutionId?: string;
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
  expectedExecutionId?: string;
}

const logger = createLogger("graph-workflow-manager");

function describeLaunchInputError(error: LaunchInputError): string {
  switch (error.kind) {
    case "missing_required":
      return `Required parameter "${error.name}" was not supplied`;
    case "invalid_value":
      return `Parameter "${error.name}" is invalid: ${error.message}`;
    case "unknown_parameter":
      return `Unknown parameter "${error.name}" is not declared by this workflow`;
  }
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

let defaultLandingEvidenceProber: LandingEvidenceProber | null = null;

/** Built once and only when a restart actually finds an unsettled landing. */
function resolveLandingEvidenceProber(
  deps: GraphWorkflowManagerDeps,
): LandingEvidenceProber {
  if (deps.landingEvidenceProber) return deps.landingEvidenceProber;
  defaultLandingEvidenceProber ??= createLandingEvidenceProber();
  return defaultLandingEvidenceProber;
}

function requireRunningExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  if (execution.status !== "running") {
    throw new Error("Only running graph workflow executions can be updated");
  }

  return execution;
}

function clearLaneStatesFor(
  execution: GraphWorkflowExecution,
  contextIds: readonly string[],
): string[] {
  const cleared: string[] = [];
  for (const contextId of contextIds) {
    if (execution.laneStates[contextId]) {
      cleared.push(contextId);
      delete execution.laneStates[contextId];
    }
  }
  return cleared;
}

/**
 * The envelope assumed for a context whose ownership was never frozen — a run
 * whose deps cannot resolve a session, and therefore cannot provision lanes
 * either. Full access is the fail-closed reading: it collides with every other
 * write-capable member, so such a context can only ever hold a lane alone.
 */
const UNKNOWN_OWNERSHIP: CanonicalOwnership = {
  mode: "full",
  canonicalPrefixes: [],
};

/**
 * Drop every lane reservation this batch owns. Owner-checked, like the
 * per-context stamp: a lane re-reserved by a concurrent batch carries a
 * different `batchId` and its claim must survive.
 */
function releaseLaneReservations(
  execution: GraphWorkflowExecution,
  batchId: string,
): void {
  for (const [laneId, reservation] of Object.entries(
    execution.laneReservations,
  )) {
    if (reservation.batchId !== batchId) continue;
    delete execution.laneReservations[laneId];
  }
}

/**
 * Find the upstream context whose laneId matches `laneId` and which is the
 * direct dependency of any of `contenders`. Used at fan-out to name the parent
 * a non-inheriting sibling forks from.
 */
function findUpstreamCompletedOnLane(
  contenders: readonly string[],
  laneId: string,
  execution: GraphWorkflowExecution,
): string | null {
  // Projection-resolved (decision D1), still walked in definition order: the
  // parent whose lane a contender may inherit is the EFFECTIVE source of an
  // ACTIVE incoming edge. A declined branch never committed anything on that
  // lane, so inheriting from it would continue work that does not exist.
  const contenderSet = new Set(contenders);
  for (const edge of projectExecutionRoutes(execution).edges) {
    if (!contenderSet.has(edge.targetContextId)) continue;
    if (edge.resolution.kind !== "active") continue;
    if (edge.effectiveSourceId === null) continue;
    const upstream = execution.contextStates[edge.effectiveSourceId];
    if (!upstream) continue;
    if (upstream.laneId !== laneId) continue;
    if (upstream.status !== "completed") continue;
    return edge.effectiveSourceId;
  }
  return null;
}

/**
 * Record how a just-dispatched context is going to land (D4 decision D8).
 *
 * The mode is read off the placement the dispatch just made, which is the only
 * point where all three shapes are distinguishable: a lane-bound context
 * commits on its lane, a session-bound one commits solo, and a legacy
 * laneId-null worktree context publishes through the fan-in squash merge.
 *
 * `baselineSha` stays null here: the lane head is resolved out of the write
 * queue, so the runner persists it as soon as it captures it — still before the
 * context's first turn (see `runContextTask`).
 */
function recordDispatchLandingIntent(
  execution: GraphWorkflowExecution,
  contextId: string,
  now: string,
): void {
  const state = execution.contextStates[contextId];
  if (!state) return;
  const placement = execution.workingDefinition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement;
  if (placement?.mode === "readOnly") return;
  const mode =
    state.laneId !== null
      ? "lane_commit"
      : state.isolation === "session"
        ? "solo_commit"
        : "fan_in_merge";
  recordLandingIntent(execution, contextId, {
    mode,
    laneId: state.laneId,
    worktreePath: state.worktreePath,
    now,
  });
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
      transitionContextStatus(execution, activeContextId, "ready", {
        reason: "manager.mark_active_context_ready",
      });
    }
  }
}

/**
 * Running task conversations, minus any parked on a user question. A parked
 * conversation's machine sits in waitingForInput, which accepts ABORT_TURN and
 * would persist a cleared question while the execution keeps the parked record:
 * subsequent answers would be rejected and the context could never be
 * re-dispatched. A parked conversation has no in-flight turn, so excluding it
 * from cancellation costs nothing.
 */
function collectRunningTaskConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  const parked = parkedQuestionConversationIds(execution);
  const ids = new Set<string>();
  for (const taskState of Object.values(execution.taskStates)) {
    if (
      taskState.status === "running" &&
      taskState.lastConversationId &&
      !parked.has(taskState.lastConversationId)
    ) {
      ids.add(taskState.lastConversationId);
    }
  }
  return [...ids];
}

/**
 * CC conversation ids of every lane (implementer + validator) tracked on the
 * execution, except conversations parked on a user question. Validator runs
 * live here, NOT in taskStates — collecting only running-task conversations
 * lets a long validator run burn to completion after an abort. Aborting an
 * idle (non-parked) lane conversation is a harmless no-op (abort-registry
 * miss; the actor ignores ABORT_TURN when idle).
 */
function collectLaneConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  const parked = parkedQuestionConversationIds(execution);
  const ids = new Set<string>();
  for (const lanes of Object.values(execution.laneStates)) {
    for (const laneState of Object.values(lanes)) {
      if (laneState.workflowConversationId) {
        ids.add(laneState.workflowConversationId);
      }
    }
  }
  return [...ids].filter((id) => !parked.has(id));
}

/** Every conversation an active-cancellation transition should abort. */
function collectCancellableConversationIds(
  execution: GraphWorkflowExecution,
): string[] {
  return [
    ...new Set([
      ...collectRunningTaskConversationIds(execution),
      ...collectLaneConversationIds(execution),
    ]),
  ];
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
  if (execution.status === "running") {
    nextExecution.loopEpoch += 1;
  }
  nextExecution.status = status;
  nextExecution.completedAt = completedAt;
  nextExecution.haltReason = haltReason;
  nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
    lifecycleStatus: status,
    recoveryMode: hadRunningTasks ? "interrupted_task" : "none",
    hasLiveIteration: false,
  });
  return nextExecution;
}

export function createGraphWorkflowManager(deps: GraphWorkflowManagerDeps) {
  const stopLaneDevServers =
    deps.stopExecutionLaneDevServers ?? defaultStopExecutionLaneDevServers;
  const executionContract =
    deps.executionContract ?? createRegisteredGraphExecutionContract();
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();
  const userInputGateService =
    deps.userInputGateService ??
    createUserInputGateService({
      getActive: deps.executionRepository.getActive,
      mutateActive: deps.executionRepository.mutateActive,
      publishUserInputPending: eventPublisher.publishUserInputPending,
      publishUserInputResolved: eventPublisher.publishUserInputResolved,
      deliver: eventPublisher.deliver,
      sendConversationEvent,
      now: () => getNow(deps),
    });

  function abortRunningTaskConversations(
    projectPath: string,
    sessionName: string,
    conversationIds: readonly string[],
  ): void {
    if (!deps.abortConversation || conversationIds.length === 0) {
      return;
    }
    for (const conversationId of conversationIds) {
      try {
        deps.abortConversation({
          projectPath,
          sessionName,
          conversationId,
        });
      } catch (err) {
        logger.warn("graph-workflow.abort_conversation.failed", {
          projectPath,
          sessionName,
          conversationId,
          error: getErrorMessage(err),
        });
      }
    }
  }

  async function readStartSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null> {
    if (!deps.getSession) {
      return null;
    }
    return deps.getSession(projectPath, sessionName);
  }

  async function readSessionDirtyPaths(
    projectPath: string,
    sessionName: string,
  ): Promise<DirtyPath[]> {
    if (!deps.getSession) {
      return [];
    }
    const session = await deps.getSession(projectPath, sessionName);
    if (!session) {
      return [];
    }
    const readDirty =
      deps.readSessionWorktreeDirtyPaths ?? readWorktreeDirtyPaths;
    try {
      return (await readDirty(session.worktreePath)) ?? [];
    } catch (error) {
      // Don't wedge a legitimate start if the status probe itself fails; the
      // dirty gate is a guard, not a hard precondition we can always evaluate.
      logger.warn("graph-workflow.start.dirty_check_failed", {
        projectPath,
        sessionName,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  function recordExecutionStarted(
    execution: GraphWorkflowExecution,
    projectPath: string,
    sessionName: string,
  ): void {
    const execLogger = createExecutionLogger(execution.id);
    registerExecutionLogger(execLogger);
    execLogger.writeManifest(execution);
    execLogger.lifecycle("execution.started", {
      definitionId: execution.seedDefinitionId,
      definitionRevision: execution.seedDefinitionRevision,
      projectPath,
      sessionName,
      contextCount: execution.workingDefinition.executionContexts.length,
      taskCount: execution.workingDefinition.tasks.length,
    });
    logger.info("graph-workflow.execution.started", {
      executionId: execution.id,
      definitionId: execution.seedDefinitionId,
      definitionRevision: execution.seedDefinitionRevision,
      tier: execution.launchedTier,
    });
  }

  async function start(
    input: GraphWorkflowStartInput,
  ): Promise<GraphWorkflowExecution> {
    // Guard order is behavior-preserving and load-bearing: active-execution
    // first, then the dirty-worktree guard, both BEFORE loadDefinition. The
    // dirty 409 must still win over a 404 when both apply (the HTTP handler
    // historically checked dirty before resolving the definition), and the
    // active-execution guard precedes everything so an already-running workflow
    // reports the more specific message.
    const existing = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (existing) {
      const terminalStatuses: GraphWorkflowStatus[] = [
        "completed",
        "halted",
        "aborted",
      ];
      if (terminalStatuses.includes(existing.status)) {
        await deps.executionRepository.archiveActive(
          input.projectPath,
          input.sessionName,
        );
      } else {
        throw new WorkflowStartGuardError(
          "active_execution",
          `Session "${input.sessionName}" already has an active graph workflow execution`,
        );
      }
    }

    // Lanes fork from the committed session branch, so any uncommitted change in
    // the session worktree (e.g. a freshly-written, never-committed Kiro spec —
    // which is untracked) would be missing from every lane. Refuse the start.
    const dirtyPaths = await readSessionDirtyPaths(
      input.projectPath,
      input.sessionName,
    );
    if (dirtyPaths.length > 0) {
      logger.info("graph-workflow.start.blocked_uncommitted_changes", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        dirtyCount: dirtyPaths.length,
      });
      throw new WorkflowStartGuardError(
        "uncommitted_changes",
        `Cannot start the workflow while the session worktree has ${dirtyPaths.length} uncommitted change(s). Workflow lanes are created from the committed branch, so uncommitted files would be missing. Commit your changes and try again.`,
        dirtyPaths,
      );
    }

    const tier: TemplateTier = input.tier ?? "project";
    const definition = await deps.loadDefinition(
      input.projectPath,
      input.definitionId,
      tier,
    );
    if (!definition) {
      throw new WorkflowDefinitionNotFoundError(input.definitionId, tier);
    }
    if (
      input.expectedDefinitionRevision !== undefined &&
      definition.revision !== input.expectedDefinitionRevision
    ) {
      logger.warn("graph-workflow.start.definition_revision_mismatch", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        expectedDefinitionRevision: input.expectedDefinitionRevision,
        actualDefinitionRevision: definition.revision,
      });
      throw new WorkflowDefinitionRevisionMismatchError(
        input.definitionId,
        input.expectedDefinitionRevision,
        definition.revision,
      );
    }

    const contractDecision = executionContract.validateDefinition(
      definition.definition,
    );
    if (!contractDecision.ok) {
      logger.warn("graph-workflow.start.execution_contract_rejected", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        tier,
        code: contractDecision.code,
        issueCount: contractDecision.issues.length,
      });
    }
    assertGraphExecutionContractAccepted(contractDecision);

    // Deterministic prerequisite gate. It sits AFTER the dirty-worktree guard
    // (mirroring the existing chain — a dirty worktree is reported before a
    // missing prerequisite, both are pre-token gates) and BEFORE start-input
    // validation/substitution, so a prerequisite miss is attributed distinctly
    // and seeds nothing — no conversation, no agent turn (R5.9, R6.1, R6.3).
    const session = await readStartSession(
      input.projectPath,
      input.sessionName,
    );
    if (session) {
      const preflightService =
        deps.preflightService ?? createPreflightPrerequisiteService();
      const global = await (deps.readGlobalConfig ?? readConfig)();
      // Backends are not a parameterizable field, so the used-backend set is
      // resolved from the RAW resolved definition pre-substitution — the same
      // resolution the run uses (per-context → workflow → global). It scopes
      // backend-dependent (skill) prerequisites to the backend(s) that actually
      // run the launch, never a single assumed launch backend (R5.2a, R5.4b).
      const usedBackends = computeUsedBackends(global, definition.definition);
      const preflight = await preflightService.evaluate({
        definition: definition.definition,
        worktreePath: session.worktreePath,
        usedBackends,
      });
      if (preflight.status === "prerequisites_unmet") {
        logger.info("graph-workflow.start.blocked_prerequisites_unmet", {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          definitionId: input.definitionId,
          tier,
          missingCount: preflight.missing.length,
        });
        throw new WorkflowPrerequisitesUnmetError(
          preflight.missing,
          `Cannot start the workflow: ${preflight.missing.length} declared prerequisite(s) are unmet in the session worktree.`,
        );
      }
    }

    const validation = validateLaunchInputs({
      parameters: definition.definition.parameters,
      supplied: input.parameters,
    });
    if (!validation.ok) {
      logger.info("graph-workflow.start.input_rejected", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        definitionId: input.definitionId,
        rejectionKind: validation.error.kind,
        parameterName: validation.error.name,
      });
      throw new WorkflowStartInputError(
        validation.error,
        describeLaunchInputError(validation.error),
      );
    }
    const boundInputs = validation.boundInputs;

    const pendingExecution = await deps.executionRepository.create(
      input.projectPath,
      input.sessionName,
      {
        definition: definition.definition,
        definitionId: definition.id,
        definitionRevision: definition.revision,
        executionId: getExecutionId(deps),
        startedAt: getNow(deps),
        inputs: boundInputs,
        launchedTier: tier,
      },
    );

    if (
      pendingExecution.definitionApproval !== null &&
      pendingExecution.definitionApproval.approvedAt === null
    ) {
      logger.info("graph-workflow.definition_approval.pending", {
        executionId: pendingExecution.id,
        definitionId: pendingExecution.seedDefinitionId,
        definitionRevision: pendingExecution.seedDefinitionRevision,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        requestedAt: pendingExecution.definitionApproval.requestedAt,
      });
      throw new WorkflowDefinitionApprovalRequiredError(
        pendingExecution.id,
        pendingExecution.seedDefinitionId,
        pendingExecution.seedDefinitionRevision,
      );
    }

    const nextExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (execution) => {
        execution.status = "running";
        execution.machineSnapshot = buildLifecycleSnapshot(execution, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        return execution;
      },
    );

    recordExecutionStarted(nextExecution, input.projectPath, input.sessionName);

    return nextExecution;
  }

  async function recordDefinitionApproval(
    input: RecordDefinitionApprovalInput,
  ): Promise<RecordDefinitionApprovalResult> {
    const active = await deps.executionRepository.getActive(
      input.projectPath,
      input.sessionName,
    );
    if (!active) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "no_active_execution",
      });
      return { ok: false, reason: "no_active_execution" };
    }

    if (
      input.expectedExecutionId !== undefined &&
      active.id !== input.expectedExecutionId
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "execution_mismatch",
        expectedExecutionId: input.expectedExecutionId,
      });
      return { ok: false, reason: "execution_mismatch" };
    }

    if (
      input.expectedDefinitionId !== undefined &&
      active.seedDefinitionId !== input.expectedDefinitionId
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "definition_mismatch",
        expectedDefinitionId: input.expectedDefinitionId,
        activeDefinitionId: active.seedDefinitionId,
      });
      return { ok: false, reason: "definition_mismatch" };
    }

    if (
      input.expectedDefinitionRevision !== undefined &&
      active.seedDefinitionRevision !== input.expectedDefinitionRevision
    ) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: active.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: "definition_revision_mismatch",
        expectedDefinitionRevision: input.expectedDefinitionRevision,
        activeDefinitionRevision: active.seedDefinitionRevision,
      });
      return { ok: false, reason: "definition_revision_mismatch" };
    }

    if (
      active.definitionApproval?.approvedAt === null &&
      active.status === "pending"
    ) {
      const contractDecision = executionContract.validateDefinition(
        active.workingDefinition,
      );
      if (!contractDecision.ok) {
        logger.warn(
          "graph-workflow.definition_approval.execution_contract_rejected",
          {
            executionId: active.id,
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            code: contractDecision.code,
            issueCount: contractDecision.issues.length,
          },
        );
      }
      assertGraphExecutionContractAccepted(contractDecision);
    }

    let guardFailure:
      | "not_awaiting_approval"
      | "already_decided"
      | "definition_mismatch"
      | "definition_revision_mismatch"
      | "execution_mismatch"
      | null = null;
    const nextExecution = await deps.executionRepository.mutateActive(
      input.projectPath,
      input.sessionName,
      (execution) => {
        if (
          input.expectedExecutionId !== undefined &&
          execution.id !== input.expectedExecutionId
        ) {
          guardFailure = "execution_mismatch";
          return execution;
        }
        if (
          input.expectedDefinitionId !== undefined &&
          execution.seedDefinitionId !== input.expectedDefinitionId
        ) {
          guardFailure = "definition_mismatch";
          return execution;
        }
        if (
          input.expectedDefinitionRevision !== undefined &&
          execution.seedDefinitionRevision !== input.expectedDefinitionRevision
        ) {
          guardFailure = "definition_revision_mismatch";
          return execution;
        }
        const approval = execution.definitionApproval;
        if (approval === null) {
          guardFailure = "not_awaiting_approval";
          return execution;
        }
        if (approval.approvedAt !== null) {
          guardFailure = "already_decided";
          return execution;
        }
        if (execution.status !== "pending") {
          guardFailure = "not_awaiting_approval";
          return execution;
        }

        approval.approvedAt = getNow(deps);
        execution.status = "running";
        execution.machineSnapshot = buildLifecycleSnapshot(execution, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        return execution;
      },
    );

    if (guardFailure !== null) {
      logger.warn("graph-workflow.definition_approval.guard_failed", {
        executionId: nextExecution.id,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        reason: guardFailure,
        expectedExecutionId: input.expectedExecutionId,
        expectedDefinitionId: input.expectedDefinitionId,
        expectedDefinitionRevision: input.expectedDefinitionRevision,
        activeDefinitionId: nextExecution.seedDefinitionId,
        activeDefinitionRevision: nextExecution.seedDefinitionRevision,
      });
      return { ok: false, reason: guardFailure };
    }

    logger.info("graph-workflow.definition_approval.recorded", {
      executionId: nextExecution.id,
      definitionId: nextExecution.seedDefinitionId,
      definitionRevision: nextExecution.seedDefinitionRevision,
      approvedAt: nextExecution.definitionApproval?.approvedAt ?? null,
    });
    recordExecutionStarted(nextExecution, input.projectPath, input.sessionName);
    return { ok: true, execution: nextExecution };
  }

  async function send(
    projectPath: string,
    sessionName: string,
    event: GraphWorkflowManagerEvent,
  ): Promise<GraphWorkflowExecution> {
    const now = getNow(deps);

    if (event.type === "pause") {
      let conversationIdsToAbort: string[] = [];
      const pausedExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) => {
          assertLifecycleTransitionAllowed(
            execution,
            "pause",
            ["running"],
            "Only running graph workflow executions can be paused",
          );
          conversationIdsToAbort = collectCancellableConversationIds(execution);
          return transitionToNonRunningState(execution, "paused", null, null);
        },
      );
      deps.abortExecutionLoop?.(projectPath, sessionName);
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        conversationIdsToAbort,
      );
      // Pause is the edit point (doc 06): the in-flight round is abandoned and
      // its parked validator questions go with it, so the edited roster's next
      // round starts with no residue — no stale question the human could still
      // answer into a cohort that no longer exists. An implementer's parked
      // question belongs to no round and survives, as it always has.
      const nextExecution = await userInputGateService.withdrawRoundQuestions({
        projectPath,
        sessionName,
        executionId: pausedExecution.id,
      });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.paused", { actor: "operator" });
      logger.info("graph-workflow.execution.paused", {
        executionId: nextExecution.id,
      });
      return nextExecution;
    }

    if (event.type === "abort") {
      let conversationIdsToAbort: string[] = [];
      const abortedExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) => {
          assertLifecycleTransitionAllowed(
            execution,
            "abort",
            ["pending", "running", "paused", "halted"],
            "Completed or aborted graph workflow executions cannot be aborted",
          );
          conversationIdsToAbort = collectCancellableConversationIds(execution);
          return transitionToNonRunningState(execution, "aborted", now, {
            type: "aborted",
            cause: null,
            summary: null,
          });
        },
      );
      deps.abortExecutionLoop?.(projectPath, sessionName);
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        conversationIdsToAbort,
      );
      // A parked question must not dangle as answerable once the execution is
      // aborted (Req 7.4). The withdrawal belongs here, beside the transition,
      // for two reasons: aborting a paused or halted execution has no loop to
      // run cleanup at all, and the transition above retires the running loop's
      // generation — a loop that reacted to the abort itself would be fenced
      // out of the very write the cleanup needs. Pause withdraws only its
      // round's questions; abort ends the execution, so every park goes.
      const nextExecution = await userInputGateService.withdrawAll({
        projectPath,
        sessionName,
        executionId: abortedExecution.id,
      });
      await stopLaneDevServers({ execution: nextExecution, projectPath });
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("execution.aborted", { actor: "operator" });
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
          assertLifecycleTransitionAllowed(
            execution,
            "complete",
            ["running"],
            "Only running graph workflow executions can be completed",
          );
          execution.status = "completed";
          execution.completedAt = now;
          execution.haltReason = null;
          execution.loopEpoch += 1;
          execution.machineSnapshot = buildLifecycleSnapshot(execution, {
            lifecycleStatus: "completed",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
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
    let conversationIdsToAbort: string[] = [];
    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        assertLifecycleTransitionAllowed(
          execution,
          "halt",
          ["running"],
          "Only running graph workflow executions can be halted",
        );
        conversationIdsToAbort = collectCancellableConversationIds(execution);
        return transitionToNonRunningState(
          execution,
          "halted",
          now,
          haltReason,
        );
      },
    );
    deps.abortExecutionLoop?.(projectPath, sessionName);
    abortRunningTaskConversations(
      projectPath,
      sessionName,
      conversationIdsToAbort,
    );
    await stopLaneDevServers({ execution: nextExecution, projectPath });
    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason,
      actor: "system",
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
    options?: GraphWorkflowResumeOptions,
  ): Promise<GraphWorkflowExecution> {
    let previousStatus: GraphWorkflowStatus | null = null;
    // Holder object rather than a `let`: TS flow analysis does not see the
    // closure assignment, so a bare local reads as never at the emit site.
    const resumeCapture: {
      resolvedHaltReason: GraphWorkflowHaltReason | null;
    } = { resolvedHaltReason: null };
    let hasInterrupted = false;
    let mergeRetryContextIds: string[] = [];
    let resetJoinIds: string[] = [];
    let laneConversationIdsToAbort: string[] = [];

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        assertLifecycleTransitionAllowed(
          execution,
          "resume",
          ["paused", "halted"],
          "Only paused or halted graph workflow executions can be resumed",
        );

        previousStatus = execution.status;
        // Captured before the clear below: the resume event echoes which halt
        // it resolved, so lifecycle.jsonl halt→resume pairs stay verifiable.
        resumeCapture.resolvedHaltReason = execution.haltReason;
        // Captured here for the same reason — the halt reasons are cleared
        // below, and which contexts they named decides whose validation round
        // gets its attempt budget back.
        const infraHaltContextIds = contextIdsResumingInfraHalt([
          execution.haltReason,
          ...execution.secondaryHaltReasons,
        ]);

        // Resume is a manual retry decision: concluded-failed joins go back to
        // pending (per-lane merge progress survives) so the loop re-runs them,
        // carrying any operator conflict guidance into the next resolution.
        const joinResetAt = new Date().toISOString();
        const joinIdsToReset = Object.values(execution.joins ?? {})
          .filter(
            (join) => join.status === "failed" || join.status === "conflicts",
          )
          .map((join) => join.joinId);
        for (const joinId of joinIdsToReset) {
          execution = resetJoinForRetry(
            execution,
            joinId,
            joinResetAt,
            options?.conflictGuidance,
          );
        }
        resetJoinIds = joinIdsToReset;
        // A zombie loop's in-flight turn is write-fenced but can still hold a
        // lane conversation against the new generation; collect the lanes so
        // any such turn is actively aborted below. Safe: no legitimate turn
        // can be running while the execution is paused/halted, so aborting an
        // idle lane conversation is a no-op.
        laneConversationIdsToAbort = collectLaneConversationIds(execution);
        execution.status = "running";
        execution.completedAt = null;
        execution.haltReason = null;
        execution.secondaryHaltReasons = [];
        // A pending reason recorded by a turn that settled after the
        // pause/halt belongs to the superseded generation; preserving it
        // would drain-halt the replacement loop on its first pass.
        execution.pendingHaltReason = null;
        // Start a loop generation distinct from both the generation that was
        // retired on entry to the quiescent state and any persisted quiescent
        // execution restored without an in-process predecessor.
        execution.loopEpoch += 1;

        const retryIds: string[] = [];
        for (const contextState of Object.values(execution.contextStates)) {
          // Starting a new loop generation invalidates any scheduling
          // reservation from the old one: a superseded pass may have stamped a
          // context and then had its finalize fenced out, which would otherwise
          // leave the context permanently ineligible. Clear every stamp so the
          // fresh generation re-schedules from a clean slate (Design 3.1).
          contextState.reservedByBatchId = null;
          // in-progress: the merge's success write was fenced out (resume
          // landed mid-git-operation) or the server died mid-merge. The
          // context is completed so it is never rescheduled and downstream
          // eligibility requires merged-success — without a retry the
          // execution wedges. The merge runner reconciles against whatever
          // actually landed on the branch.
          if (
            contextState.mergeStatus === "merged-failed" ||
            contextState.mergeStatus === "in-progress"
          ) {
            transitionContextMergeStatus(
              execution,
              contextState.contextId,
              "pending",
              { reason: "manager.resume_merge_retry" },
            );
            contextState.lastMergeError = null;
            retryIds.push(contextState.contextId);
            continue;
          }
          // A context that tripped the circuit breaker is active+running at
          // halt, so the halt transition (markActiveContextReady) bumps it to
          // `ready`, not `halted`. Handling only `halted` here would leave its
          // consecutiveFailureCount intact and the breaker would re-trip almost
          // immediately on resume. Resume is a manual retry decision, so clear
          // the failure counter for every retryable context.
          if (contextState.status === "halted") {
            transitionContextStatus(
              execution,
              contextState.contextId,
              "ready",
              {
                reason: "manager.resume_halted_context",
              },
            );
          }
          if (contextState.status === "ready") {
            contextState.consecutiveFailureCount = 0;
          }
          // Resume is the manual retry decision for an infrastructure halt too:
          // the lanes that never reached a verdict get their attempt budget
          // back, so the round can actually run again. Without this the halt is
          // resumable in name only — every unsettled lane comes back already at
          // the bound and re-halts on the first pass (D5). Only for the contexts
          // the halt named, though: a restart-driven resume carries no halt
          // reason, and giving it a reset would refill the budget on every
          // server bounce.
          const round = contextState.validationRound;
          if (
            round &&
            isValidationRoundOpen(round) &&
            infraHaltContextIds.has(contextState.contextId)
          ) {
            contextState.validationRound = resetValidationRoundAttempts(round);
          }
        }
        mergeRetryContextIds = retryIds;
        execution.pendingMergeRetry = retryIds;

        hasInterrupted = Object.values(execution.taskStates).some(
          (ts) => ts.status === "interrupted",
        );
        execution.machineSnapshot = buildLifecycleSnapshot(execution, {
          lifecycleStatus: "running",
          recoveryMode: hasInterrupted ? "interrupted_task" : "none",
          hasLiveIteration: false,
        });
        return execution;
      },
    );

    // Abort only after the epoch bump is committed: a zombie turn racing the
    // abort is already write-fenced, and the new loop is not kicked until
    // resume returns, so a fresh generation's turn can never be the target.
    if (laneConversationIdsToAbort.length > 0) {
      logger.info("graph-workflow.resume.lane_turns_aborted", {
        executionId: nextExecution.id,
        conversationIds: laneConversationIdsToAbort,
      });
      abortRunningTaskConversations(
        projectPath,
        sessionName,
        laneConversationIdsToAbort,
      );
    }

    // Re-register execution logger on resume
    const execLogger = createExecutionLogger(nextExecution.id);
    registerExecutionLogger(execLogger);
    execLogger.lifecycle("execution.resumed", {
      previousStatus,
      actor: "operator",
      resolvedHaltType: resumeCapture.resolvedHaltReason?.type ?? null,
      // Not every halt variant carries a contextId (e.g. recovery_error).
      resolvedHaltContextId:
        resumeCapture.resolvedHaltReason !== null &&
        "contextId" in resumeCapture.resolvedHaltReason
          ? (resumeCapture.resolvedHaltReason.contextId ?? null)
          : null,
      hasInterruptedTasks: hasInterrupted,
      resetContextIds: Object.values(nextExecution.contextStates)
        .filter((cs) => cs.status === "ready")
        .map((cs) => cs.contextId),
    });
    if (mergeRetryContextIds.length > 0) {
      execLogger.lifecycle("resume.merge_retry_scheduled", {
        retryContextIds: mergeRetryContextIds,
      });
      logger.info("graph-workflow.resume.merge_retry_scheduled", {
        executionId: nextExecution.id,
        retryContextIds: mergeRetryContextIds,
      });
    }
    if (resetJoinIds.length > 0) {
      execLogger.lifecycle("resume.join_retry_scheduled", {
        resetJoinIds,
        hasConflictGuidance: (options?.conflictGuidance?.length ?? 0) > 0,
      });
      logger.info("graph-workflow.resume.join_retry_scheduled", {
        executionId: nextExecution.id,
        resetJoinIds,
        hasConflictGuidance: (options?.conflictGuidance?.length ?? 0) > 0,
      });
    }
    logger.info("graph-workflow.execution.resumed", {
      executionId: nextExecution.id,
      previousStatus,
      loopEpoch: nextExecution.loopEpoch,
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

    // Probed BEFORE the mutation: reading a branch is I/O and the write queue
    // is not the place for it. Only unlanded commit-mode intents are worth a
    // probe, so an execution that never crashed mid-landing costs nothing.
    const probeTargets = collectLandingProbeTargets(execution);
    const branchEvidence =
      probeTargets.length > 0
        ? await resolveLandingEvidenceProber(deps).probe(probeTargets)
        : undefined;

    const normalizedJoinIds: string[] = [];
    const reconciledIntentContextIds: string[] = [];
    const normalizedExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (current) => {
        if (current.status !== "running") {
          return current;
        }

        const timestamp = getNow(deps);
        const resetRunningJoins = (execution: GraphWorkflowExecution): void => {
          normalizedJoinIds.push(
            ...resetRunningJoinsToPending(execution, timestamp),
          );
        };

        // A crash between a landing and its intent's settlement leaves the
        // intent `pending` over work that is already committed — or over a
        // fan-in merge that failed. Both are decided here from state that
        // outlived the process (decision D8): the join's own record, and the
        // branch evidence probed above. The resumed loop classifies from that
        // durable evidence instead of re-deriving it.
        reconciledIntentContextIds.push(
          ...reconcileLandingIntents(current, {
            now: timestamp,
            branchEvidence,
          }),
        );

        if (current.pendingHaltReason !== null) {
          const haltReason = current.pendingHaltReason;
          const transitioned = transitionToNonRunningState(
            current,
            "halted",
            timestamp,
            haltReason,
          );
          transitioned.pendingHaltReason = null;
          resetRunningJoins(transitioned);
          transitioned.machineSnapshot = buildLifecycleSnapshot(transitioned, {
            lifecycleStatus: "halted",
            recoveryMode: "restart_drain_resumed",
            hasLiveIteration: false,
          });
          return transitioned;
        }

        const nextExecution = transitionToNonRunningState(
          current,
          "paused",
          null,
          null,
        );
        resetRunningJoins(nextExecution);
        nextExecution.machineSnapshot = buildLifecycleSnapshot(nextExecution, {
          lifecycleStatus: "paused",
          recoveryMode: "restart_normalized",
          hasLiveIteration: false,
        });
        return nextExecution;
      },
    );

    if (reconciledIntentContextIds.length > 0) {
      logger.info("graph-workflow.restart.landing_intents_reconciled", {
        executionId: normalizedExecution.id,
        contextIds: reconciledIntentContextIds,
      });
      getExecutionLogger(normalizedExecution.id)?.lifecycle(
        "restart.landing_intents_reconciled",
        { contextIds: reconciledIntentContextIds },
      );
    }

    if (normalizedJoinIds.length > 0) {
      const execLogger = getExecutionLogger(normalizedExecution.id);
      execLogger?.lifecycle("restart.joins_normalized", {
        joinIds: normalizedJoinIds,
      });
      logger.info("graph-workflow.restart.joins_normalized", {
        executionId: normalizedExecution.id,
        joinIds: normalizedJoinIds,
      });
    }

    if (
      normalizedExecution.status === "halted" &&
      normalizedExecution.haltReason !== null
    ) {
      const execLogger = getExecutionLogger(normalizedExecution.id);
      execLogger?.lifecycle("execution.halted", {
        haltReason: normalizedExecution.haltReason,
        cause: "restart_drain_resumed",
        actor: "system",
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
          if (!running.contextStates[contextId]) {
            continue;
          }

          transitionContextStatus(running, contextId, "ready", {
            reason: "manager.schedule_next_context.eligible",
          });
        }

        const nextContextId = eligibleContextIds[0] ?? null;
        running.activeContextIds = nextContextId ? [nextContextId] : [];
        if (nextContextId) {
          transitionContextStatus(running, nextContextId, "running", {
            reason: "manager.schedule_next_context.activate",
          });
          recordDispatchLandingIntent(running, nextContextId, getNow(deps));
          const clearedLanes = Object.keys(running.laneStates);
          running.laneStates = {};

          scheduledContextId = nextContextId;
          scheduledEligibleContextIds = eligibleContextIds;
          scheduledClearedLanes = clearedLanes;
        }

        running.machineSnapshot = buildLifecycleSnapshot(running, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
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

  /**
   * The session's worktree directory and branch — everything scheduling needs
   * from the session record. Resolved once per pass, BEFORE anything is
   * reserved, so a lookup failure aborts with no state to compensate.
   *
   * Returns null when the deps a lane-provisioning scheduler needs are absent,
   * or when the session itself is gone. Both are refused at the point a pass
   * actually needs to provision, not here: this runs on EVERY pass, including
   * passes with nothing eligible, and a session deleted out from under a
   * winding-down execution should leave those passes a quiet no-op rather than
   * a throw.
   */
  async function resolveSessionTargets(
    projectPath: string,
    sessionName: string,
  ): Promise<{
    sessionDir: string;
    sessionBranch: string;
    sessionWorktreePath: string;
  } | null> {
    if (!deps.getSession || !deps.parallelWorktrees) return null;
    const session = await deps.getSession(projectPath, sessionName);
    if (!session) return null;
    return {
      sessionDir: path.basename(session.worktreePath),
      sessionBranch: session.branchName,
      sessionWorktreePath: session.worktreePath,
    };
  }

  async function scheduleEligibleContexts(
    input: ScheduleEligibleContextsInput,
  ): Promise<ScheduleEligibleContextsResult> {
    const { projectPath, sessionName } = input;
    // Session-lane participation is opt-in per the accepted orchestration
    // design (decision 10). Default off keeps every parallel chain on its
    // own worktree lane and merges into the session branch only at final
    // publish. Callers that have validated the dirty-worktree and
    // concurrent-job preconditions can opt in by passing `true`.
    const sessionLaneEnabled = input.sessionLaneEnabled ?? false;
    const initialCapacity = input.capacityRemaining;
    const outcome: { value: ScheduleEligibleContextsOutcome } = {
      value: { kind: "none" },
    };
    let scheduledClearedLanes: string[] = [];
    let readySetEligibleContextIds: string[] = [];
    type LaneCreatedDecision = {
      laneId: string;
      contextId: string;
      branchName: string;
      worktreePath: string;
      kind: "worktree";
    };
    type LaneForkedDecision = {
      newLaneId: string;
      contextId: string;
      parentLaneId: string;
      parentContextId: string;
      parentBranchName: string;
      branchName: string;
      worktreePath: string;
    };
    type LaneReusedDecision = {
      laneId: string;
      contextId: string;
      branchName: string | null;
      worktreePath: string | null;
      kind: "session" | "worktree";
    };
    const laneCreatedDecisions: LaneCreatedDecision[] = [];
    const laneForkedDecisions: LaneForkedDecision[] = [];
    const laneReusedDecisions: LaneReusedDecision[] = [];
    type SchedulableEntry = {
      contextId: string;
      /**
       * The runtime lane id this context is placed on — its AUTHORED lane name,
       * or `SESSION_LANE_ID` for the reserved session lane. Resolved once here,
       * where the definition is in hand, so the out-of-lock provisioning and the
       * finalize mutation address the lane by the same id.
       *
       * Not the context id: a context id accepts any non-empty string while a
       * lane name is spliced into a git branch and a worktree path, and a
       * pre-placement definition's migrated lane (R11.1) is the sanitized
       * encoding of an id that may itself be illegal there.
       */
      laneId: string;
      classification: Extract<ContextSchedulability, { kind: "schedulable" }>;
      /** The envelope this context was admitted under, frozen before reserve. */
      ownership: CanonicalOwnership | null;
      // Set on the entry that MINTS the lane: the lane is provisioned once, from
      // this base, and every other member of the same lane in this batch simply
      // joins the record it produces.
      mint: {
        /** Lane whose committed head the new lane branches from; null = session. */
        sourceLaneId: string | null;
        parentBranchName: string;
        parentContextId: string | null;
      } | null;
    };
    // Routing plan captured by the sync `reserve` mutation below and consumed by
    // the out-of-lock provisioning + the sync `finalize` mutation. `null` means
    // reserve resolved a terminal outcome (none / solo-session) with no worktree
    // work to stage. Boxed like `outcome` so a value assigned inside the reducer
    // callback keeps its declared type after the call (closure-assignment CFA).
    type ProvisionPlan = {
      schedulableEntries: SchedulableEntry[];
      provisionEntries: SchedulableEntry[];
      batchId: string;
    };
    const provisionPlan: { value: ProvisionPlan | null } = { value: null };

    // ── Stage 0: canonicalize OUTSIDE the write queue (decision D4) ──
    //
    // Resolving a placement's owned prefixes to canonical paths is filesystem
    // I/O, and the reservation reducer runs on the synchronous write-queue
    // entry where no I/O is allowed. So the realpath work happens here, against
    // the pre-scheduling snapshot, and hands the reducer an IMMUTABLE canonical
    // set per candidate. The reducer then compares frozen sets — which is what
    // makes the admission decision atomic against co-candidates and against a
    // concurrent scheduler — and the set it admitted on is the set persisted for
    // dispatch, so nothing between here and the turn can widen the envelope.
    //
    // A candidate with no frozen set (deps that cannot resolve a session, which
    // is also a scheduler that cannot provision lanes) is treated as needing the
    // lane to itself, the fail-closed reading.
    const frozenOwnership = new Map<string, CanonicalOwnership>();
    // Freezes taken against a lane worktree that did not exist yet, keyed by
    // context: provisional until the worktree is checked out (decision D4).
    const provisionalFreezes = new Map<
      string,
      { placement: ContextPlacement; laneWorktreePath: string }
    >();
    // Candidates whose canonical envelope could not be resolved at all. Held
    // apart from "no freeze taken" so the reducer can refuse them outright
    // instead of reading them as full access.
    const unresolvableOwnership = new Set<string>();
    const sessionTargets = await resolveSessionTargets(
      projectPath,
      sessionName,
    );
    if (sessionTargets) {
      const snapshot = await deps.executionRepository.getActive(
        projectPath,
        sessionName,
      );
      if (snapshot) {
        for (const contextId of getEligibleContextIds(
          snapshot.workingDefinition,
          snapshot,
        )) {
          const placement = snapshot.workingDefinition.executionContexts.find(
            (context) => context.id === contextId,
          )?.placement;
          if (!placement) continue;
          const laneId =
            placement.lane === SESSION_LANE_NAME
              ? SESSION_LANE_ID
              : placement.lane;
          const laneWorktreePath =
            snapshot.executionLanes[laneId]?.worktreePath ??
            (laneId === SESSION_LANE_ID
              ? sessionTargets.sessionWorktreePath
              : deriveLaneWorktreePath({
                  projectPath,
                  sessionDir: sessionTargets.sessionDir,
                  laneId,
                }));
          try {
            frozenOwnership.set(
              contextId,
              canonicalizeOwnership({ placement, laneWorktreePath }),
            );
          } catch (error) {
            // The envelope could not be resolved — an unreadable ancestor, an
            // unterminating symlink chain, a prefix escaping the worktree. This
            // is NOT the same as "no freeze was taken" (the no-session case
            // below), which reads as full access: a candidate whose canonical
            // set is unknown must not be admitted at all, because there is
            // nothing to prove it disjoint from anyone. Refusing only this
            // candidate leaves lanes whose envelopes did resolve free to
            // proceed, and the next pass re-probes.
            unresolvableOwnership.add(contextId);
            logger.warn("graph-workflow.scheduler.ownership_freeze_failed", {
              executionId: snapshot.id,
              contextId,
              laneId,
              error: getErrorMessage(error),
            });
            continue;
          }
          // A freeze taken before the lane worktree exists resolved nothing;
          // it is re-taken after provisioning, below, and re-judged before
          // anyone starts.
          if (!laneWorktreeExists(laneWorktreePath)) {
            provisionalFreezes.set(contextId, { placement, laneWorktreePath });
          }
        }
      }
    }

    // Staged protocol (Design 3.1): worktree provisioning (`provisionLane`) —
    // the ~20.8s hold — runs OUTSIDE the write queue between a short synchronous
    // `reserve` mutation (classify + record `ready` intent, fenced) and a short
    // synchronous `finalize` mutation (apply the lane state, fence + halt
    // re-checked, else compensate by disposing the worktrees).
    let nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        const running = requireRunningExecution(execution);

        // Enforce no-new-scheduling-after-pending-halt at the transaction
        // boundary. The outer event-driven loop checks pendingHaltReason
        // against its local snapshot, but an in-flight sibling may record a
        // halt concurrently between the loop's refresh and this scheduling
        // mutation. Reading pendingHaltReason from the latest persisted
        // execution inside the repository transaction is the only way to
        // guarantee the invariant holds under event-driven rescheduling.
        if (running.pendingHaltReason !== null) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return running;
        }

        const eligibleContextIds = getEligibleContextIds(
          running.workingDefinition,
          running,
        );
        readySetEligibleContextIds = [...eligibleContextIds];

        if (eligibleContextIds.length === 0) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return running;
        }

        for (const contextId of eligibleContextIds) {
          if (running.contextStates[contextId]) {
            transitionContextStatus(running, contextId, "ready", {
              reason: "manager.schedule_eligible_contexts.eligible",
            });
          }
        }

        // Lane-aware routing: classify each eligible context. The classifier
        // separates dependency-ready, lane-safe contexts from those still
        // waiting on a join, busy lane, or capacity. Wait-state contexts stay
        // in status `ready` so the UI surfaces them but are not provisioned.
        //
        // `targetLaneId` on a schedulable result is the existing lane to
        // consume (null = session worktree); `requiresFork` indicates the
        // session lane is unsafe (either disabled by caller or another
        // worktree lane has unpublished work) so the scheduler must mint a
        // fresh worktree lane instead.
        const schedulableEntries: SchedulableEntry[] = [];
        // Reserved-but-not-running contexts count against the query budget: the
        // caller's remaining capacity was computed from what is IN FLIGHT under
        // its own loop, and a sibling batch's reservations are turns that are
        // about to start but have not been dispatched yet (decision D4).
        const foreignReservedCount = Object.values(
          running.laneReservations,
        ).reduce((total, reservation) => total + reservation.members.length, 0);
        let remainingCapacity =
          initialCapacity === undefined
            ? undefined
            : Math.max(0, initialCapacity - foreignReservedCount);
        // The one place a context's authored lane name is read. Every lane this
        // pass validates, provisions, or keys uses this rather than the context
        // id: the two coincide for a context whose id is already a legal lane
        // segment, and diverge exactly where they must — an authored group lane,
        // and a pre-placement context whose migrated lane is the sanitized
        // encoding of an id that is not spliceable into a branch or a path.
        const authoredLaneOf = (contextId: string): string | undefined =>
          running.workingDefinition.executionContexts.find(
            (ctx) => ctx.id === contextId,
          )?.placement.lane;
        type Candidate = {
          contextId: string;
          classification: Extract<
            ContextSchedulability,
            { kind: "schedulable" }
          >;
        };
        const candidates: Candidate[] = [];
        for (const contextId of eligibleContextIds) {
          const classification = classifyContextSchedulability({
            contextId,
            definition: running.workingDefinition,
            execution: running,
            options: {
              sessionLaneEnabled,
            },
          });
          if (classification.kind !== "schedulable") continue;
          candidates.push({ contextId, classification });
        }

        // ── Reservation reducer: the atomic half of admission (decision D4) ──
        //
        // Occupancy per lane, over the three populations that can collide with a
        // candidate: members RUNNING on the lane (their own frozen envelope), a
        // sibling batch's reservations, and candidates admitted earlier in THIS
        // pass. All three are compared as frozen canonical sets, so no ordering
        // of concurrent schedulers can admit two contexts whose write surfaces
        // touch.
        const occupantsByLane = new Map<string, LaneOccupant[]>();
        const occupantsOf = (laneId: string): LaneOccupant[] => {
          const known = occupantsByLane.get(laneId);
          if (known) return known;
          const occupants: LaneOccupant[] = [];
          for (const state of Object.values(running.contextStates)) {
            if (state.laneId !== laneId) continue;
            if (state.status !== "running") continue;
            occupants.push({
              contextId: state.contextId,
              ownership: state.reservedOwnership ?? UNKNOWN_OWNERSHIP,
            });
          }
          for (const member of running.laneReservations[laneId]?.members ??
            []) {
            occupants.push(member);
          }
          occupantsByLane.set(laneId, occupants);
          return occupants;
        };
        // Lanes this pass will MINT, and the entry that mints each one. A lane
        // is one worktree for the whole execution, so the first admitted member
        // provisions it and every later member of the same lane in this pass
        // coalesces onto the record it produces (decision D5).
        const mintedByLane = new Map<string, SchedulableEntry>();
        for (const candidate of candidates) {
          const { contextId, classification } = candidate;
          if (remainingCapacity !== undefined && remainingCapacity <= 0) break;
          // Fail closed rather than falling back to the context id: a context
          // the definition does not carry has no authored lane, and inventing
          // one from its id is the lexical fallback lane-write-policy forbids.
          const laneName = authoredLaneOf(contextId);
          if (laneName === undefined) {
            throw new Error(
              `Context "${contextId}" is not present in the working definition, so it has no authored lane placement`,
            );
          }
          const laneId =
            laneName === SESSION_LANE_NAME ? SESSION_LANE_ID : laneName;

          // No canonical set, no admission. The stage-0 probe could not decide
          // what this candidate would write, and an envelope that cannot be
          // resolved cannot be proven disjoint from anyone.
          if (unresolvableOwnership.has(contextId)) continue;

          const ownership = frozenOwnership.get(contextId) ?? null;
          const verdict = classifyLaneAdmission({
            candidate: ownership ?? UNKNOWN_OWNERSHIP,
            occupants: occupantsOf(laneId),
          });
          if (verdict.kind === "refuse") {
            logger.info("graph-workflow.scheduler.lane_admission_refused", {
              executionId: running.id,
              contextId,
              laneId,
              reason: verdict.reason,
              blockingContextId: verdict.blockingContextId,
            });
            continue;
          }

          // Minting. `requiresFork` with no existing lane record means the
          // authored lane has to be provisioned; a sibling batch already
          // provisioning it makes this candidate wait for the pass where the
          // lane exists, rather than racing `git worktree add` for one path.
          const mintsLane =
            classification.targetLaneId === null &&
            classification.requiresFork &&
            laneId !== SESSION_LANE_ID;
          let mint: SchedulableEntry["mint"] = null;
          if (mintsLane) {
            if (running.laneReservations[laneId] !== undefined) continue;
            if (!mintedByLane.has(laneId)) {
              // Fail closed at the point provisioning is actually required: no
              // session means no branch to fork from and no path to place the
              // worktree at, and inventing either is how a lane ends up
              // somewhere its execution does not own.
              if (!sessionTargets) {
                throw new Error(
                  `Cannot provision lane "${laneId}": session "${sessionName}" was not found (or the scheduler has no \`parallelWorktrees\`/\`getSession\` deps)`,
                );
              }
              const sourceLaneId = classification.forkFromLaneId;
              const parentLane =
                sourceLaneId === null
                  ? undefined
                  : running.executionLanes[sourceLaneId];
              mint = {
                sourceLaneId: parentLane ? sourceLaneId : null,
                parentBranchName:
                  parentLane?.branchName ?? sessionTargets.sessionBranch,
                parentContextId:
                  sourceLaneId !== null && parentLane
                    ? findUpstreamCompletedOnLane(
                        [contextId],
                        sourceLaneId,
                        running,
                      )
                    : null,
              };
            }
          }

          const entry: SchedulableEntry = {
            contextId,
            laneId,
            classification,
            ownership,
            mint,
          };
          schedulableEntries.push(entry);
          if (mintsLane && !mintedByLane.has(laneId)) {
            mintedByLane.set(laneId, entry);
          }
          occupantsOf(laneId).push({
            contextId,
            ownership: ownership ?? UNKNOWN_OWNERSHIP,
          });
          if (remainingCapacity !== undefined) {
            remainingCapacity = Math.max(0, remainingCapacity - 1);
          }
        }

        if (schedulableEntries.length === 0) {
          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
          outcome.value = { kind: "none" };
          return running;
        }

        const canMintLane = !!(deps.parallelWorktrees && deps.getSession);
        // Whether the context's AUTHORED lane is a group lane — anything but
        // the reserved session lane, which is the session worktree itself.
        //
        // This is where the deleted plan's continuation score used to sit, and
        // the declared answer subsumes it: a context on a group lane needs that
        // lane provisioned, both for its own work and because every later
        // member of the lane inherits the worktree it mints. Without it the
        // first member would land in `laneId: null` and the next member's
        // classifier would see no worktree source lane to reuse.
        const laneIsGroupLane = (contextId: string): boolean => {
          const lane = authoredLaneOf(contextId);
          return lane !== undefined && lane !== SESSION_LANE_NAME;
        };

        const soloEntry =
          schedulableEntries.length === 1 ? schedulableEntries[0]! : null;
        const isSoloSession =
          soloEntry !== null &&
          soloEntry.classification.targetLaneId === null &&
          !soloEntry.classification.requiresFork &&
          !(canMintLane && laneIsGroupLane(soloEntry.contextId));

        if (isSoloSession && soloEntry) {
          const soloContextId = soloEntry.contextId;
          const contextState = running.contextStates[soloContextId]!;
          transitionContextStatus(running, soloContextId, "running", {
            reason: "manager.schedule_eligible_contexts.solo_session",
          });
          contextState.isolation = "session";
          contextState.worktreePath = null;
          contextState.branchName = null;
          contextState.batchId = null;
          contextState.laneId = null;
          recordDispatchLandingIntent(running, soloContextId, getNow(deps));

          const activeIdSet = new Set(running.activeContextIds);
          activeIdSet.add(soloContextId);
          running.activeContextIds = [...activeIdSet];

          const clearedLanes = clearLaneStatesFor(running, [soloContextId]);
          scheduledClearedLanes = clearedLanes;

          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });
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

        // The lane id is what gets spliced into a branch name and a worktree
        // path, so that is what must satisfy the charset. Validating the context
        // id here would refuse a pre-placement context whose migrated lane is
        // legal precisely because the id was not (R11.1). The session lane is
        // exempt: it is never spliced into anything, being the session worktree.
        for (const entry of schedulableEntries) {
          if (entry.laneId !== SESSION_LANE_ID) validateLaneId(entry.laneId);
        }

        // Reserve records the routing intent AND persists two owner-discriminated
        // reservations (Design 3.1, decision D5). Per CONTEXT: the batch id it
        // will provision under — `getEligibleContextIds` excludes a stamped
        // context, so a concurrent same-epoch scheduler cannot re-classify and
        // double-provision it. Per LANE: the batch id plus the frozen ownership
        // of every member this pass admitted — which is how a concurrent
        // scheduler sees a lane that is mid-provision (and must not race
        // `git worktree add` for it) and judges its own candidates against write
        // surfaces that are claimed but not yet running. Both are cleared at the
        // fenced finalize, out of the lock, or by the compensating release.
        const batchId = deps.createBatchId?.() ?? randomUUID();
        const reservedAt = getNow(deps);
        for (const entry of schedulableEntries) {
          const contextState = running.contextStates[entry.contextId];
          if (contextState) {
            contextState.reservedByBatchId = batchId;
            contextState.reservedOwnership = entry.ownership;
          }
          const reservation = (running.laneReservations[entry.laneId] ??= {
            laneId: entry.laneId,
            batchId,
            provisioning: false,
            members: [],
            createdAt: reservedAt,
          });
          reservation.provisioning ||= entry.mint !== null;
          reservation.members.push({
            contextId: entry.contextId,
            ownership: entry.ownership ?? UNKNOWN_OWNERSHIP,
          });
        }
        running.machineSnapshot = buildLifecycleSnapshot(running, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        provisionPlan.value = {
          schedulableEntries,
          // Exactly the lane-minting entries: one worktree per lane, however
          // many members of that lane this batch admitted (decision D5).
          provisionEntries: schedulableEntries.filter(
            (entry) => entry.mint !== null,
          ),
          batchId,
        };
        return running;
      },
    );

    // Terminal outcomes (none / solo-session) are fully applied by reserve; only
    // a routing plan warrants the out-of-lock provisioning + fenced finalize.
    const plan = provisionPlan.value;
    if (plan !== null) {
      const { schedulableEntries, provisionEntries, batchId } = plan;

      // Compensating release of the reserve's owner-discriminated stamps.
      // DEFINED BEFORE any post-reserve work (session lookup, provisioning) can
      // throw so EVERY failure path after the reserve commits releases
      // `reservedByBatchId` — a `getSession` rejection/null (or a missing-dep
      // throw) must not strand the stamps and leave the contexts permanently
      // ineligible for a same-epoch retry (Design 3.1). A short sync mutation;
      // if this generation was already superseded the write is fenced out and
      // the stamps belong to a dead generation anyway, so a stale-fence refusal
      // is swallowed. OWNER-CHECKED: only a stamp this batch still owns is
      // cleared — a concurrent same-epoch batch that re-reserved the context
      // carries a different `batchId` and its reservation must survive.
      const releaseReservations = async (): Promise<void> => {
        try {
          await deps.executionRepository.mutateActive(
            projectPath,
            sessionName,
            (execution) => {
              const running = requireRunningExecution(execution);
              const releasedContextIds: string[] = [];
              for (const entry of schedulableEntries) {
                const contextState = running.contextStates[entry.contextId];
                if (contextState?.reservedByBatchId === batchId) {
                  contextState.reservedByBatchId = null;
                  contextState.reservedOwnership = null;
                  releasedContextIds.push(entry.contextId);
                }
              }
              releaseLaneReservations(running, batchId);
              // A batch that never formed also gives back the shared pass slots
              // of any loop pass it was going to start (decision D7): the
              // reservation is durable, so keeping it would charge the
              // execution's 25-pass backstop for a pass no lane exists for. The
              // retry re-reserves through the same definition-ordered admission
              // walk, and a released slot is reusable meanwhile.
              const releasedSlots = releaseLoopPassSlotsForContexts(
                running,
                releasedContextIds,
              );
              if (releasedSlots.length > 0) {
                logger.info("graph-workflow.loop.pass_slot_released", {
                  executionId: running.id,
                  slots: releasedSlots,
                });
              }
              return running;
            },
          );
        } catch (err) {
          if (!(err instanceof StaleLoopFenceError)) throw err;
        }
      };

      // Re-narrow the provisioning deps. The session was already resolved in
      // stage 0 — before anything was reserved — so a lookup failure aborts with
      // nothing to compensate; only a genuinely absent dep can surface here, and
      // it still releases the reservations before aborting.
      const { parallelWorktrees, sessionDir, sessionBranch } =
        await (async () => {
          const parallelWorktreesDep = deps.parallelWorktrees;
          if (!parallelWorktreesDep || !sessionTargets) {
            throw new Error(
              "scheduleEligibleContexts requires `parallelWorktrees` and `getSession` deps when provisioning lanes",
            );
          }
          return {
            parallelWorktrees: parallelWorktreesDep,
            sessionDir: sessionTargets.sessionDir,
            sessionBranch: sessionTargets.sessionBranch,
          };
        })().catch(async (err: unknown) => {
          await releaseReservations();
          throw err;
        });

      // Worktrees to dispose if the finalize is refused (superseded fence) or a
      // halt lands mid-provision — this caller's worktree-side-effect
      // compensation story.
      const provisioned: Array<{
        entry: SchedulableEntry;
        result: ProvisionResult;
      }> = [];
      // Best-effort disposal: a `disposeLane` rejection on one lane must NOT
      // abort disposal of the remaining lanes nor skip the reservation release
      // that follows. Failures are collected and returned so the caller can
      // report them; this never throws.
      const disposeProvisioned = async (): Promise<
        Array<{ branchName: string; error: unknown }>
      > => {
        const failures: Array<{ branchName: string; error: unknown }> = [];
        for (const { result } of provisioned) {
          try {
            await parallelWorktrees.disposeLane({
              projectPath,
              worktreePath: result.worktreePath,
              branchName: result.branchName,
            });
          } catch (error) {
            failures.push({ branchName: result.branchName, error });
          }
        }
        return failures;
      };

      // Compensate a failed/superseded schedule: dispose every provisioned lane
      // best-effort, then GUARANTEE the owner-checked reservation release (it
      // runs even when a lane disposal failed), then report any disposal
      // failures. Never throws — the callers preserve the original scheduling
      // error with their own `throw`. A genuine (non-fence) release failure is
      // reported rather than masking that original error.
      const compensateSchedule = async (): Promise<void> => {
        const disposalFailures = await disposeProvisioned();
        try {
          await releaseReservations();
        } catch (releaseError) {
          logger.error("graph-workflow.scheduler.reservation_release_failed", {
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        }
        if (disposalFailures.length > 0) {
          logger.warn("graph-workflow.scheduler.lane_dispose_failed", {
            failedLaneBranches: disposalFailures.map((f) => f.branchName),
          });
        }
      };

      // Slow worktree provisioning OUTSIDE the write queue. A failure disposes
      // the lanes already created in this pass, releases the reservations, and
      // aborts scheduling.
      try {
        for (const entry of provisionEntries) {
          const result = await parallelWorktrees.provisionLane({
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch: entry.mint?.parentBranchName ?? sessionBranch,
            laneId: entry.laneId,
          });
          provisioned.push({ entry, result });
        }
      } catch (err) {
        await compensateSchedule();
        throw err;
      }

      // ── Re-freeze what could only be guessed before the worktree existed ──
      //
      // Stage 0 canonicalized a to-be-minted lane's prefixes against a path
      // `git worktree add` had not created, so they were appended lexically.
      // Checking the source branch out is exactly the step that can turn two
      // lexically disjoint prefixes into one directory — a symlink committed on
      // that branch — so the pre-provision freeze cannot be the set anyone is
      // admitted under. Re-take it here, still OUTSIDE the write queue (this is
      // realpath I/O), and let the finalize reducer re-judge the frozen results
      // atomically. A canonicalization that now throws (a prefix escaping the
      // checked-out worktree) fails the whole batch closed rather than starting
      // a turn under an envelope that could not be resolved.
      const recanonicalized = new Map<string, CanonicalOwnership>();
      if (provisionalFreezes.size > 0) {
        const provisionedPathByLane = new Map<string, string>();
        for (const { entry, result } of provisioned) {
          provisionedPathByLane.set(entry.laneId, result.worktreePath);
        }
        try {
          for (const entry of schedulableEntries) {
            const staged = provisionalFreezes.get(entry.contextId);
            if (!staged) continue;
            recanonicalized.set(
              entry.contextId,
              canonicalizeOwnership({
                placement: staged.placement,
                laneWorktreePath:
                  provisionedPathByLane.get(entry.laneId) ??
                  staged.laneWorktreePath,
              }),
            );
          }
        } catch (err) {
          await compensateSchedule();
          throw err;
        }
      }

      // Fenced finalize: a short synchronous mutation that re-checks the loop
      // fence (inside the repository's `mutateActive`) and the pending-halt
      // state before committing the running/lane transition. If this generation
      // was superseded or a halt landed while provisioning was in flight, the
      // provisioned worktrees are disposed as compensation.
      let compensate = false;
      nextExecution = await deps.executionRepository
        .mutateActive(projectPath, sessionName, (execution) => {
          const running = requireRunningExecution(execution);

          // A halt recorded during provisioning supersedes this schedule: do
          // not start the contexts; commit only the halt-aware snapshot and
          // dispose the provisioned worktrees below. Clear the reservation stamps
          // so the contexts are re-schedulable once the halt clears — the batch
          // never formed (Design 3.1).
          if (running.pendingHaltReason !== null) {
            for (const entry of schedulableEntries) {
              const contextState = running.contextStates[entry.contextId];
              // Owner-checked like every other release: a stamp reassigned to a
              // replacement batch while this one was provisioning is that
              // batch's claim, and clearing it here would strand a context this
              // batch no longer owns.
              if (contextState?.reservedByBatchId === batchId) {
                contextState.reservedByBatchId = null;
                contextState.reservedOwnership = null;
              }
            }
            releaseLaneReservations(running, batchId);
            running.machineSnapshot = buildLifecycleSnapshot(running, {
              lifecycleStatus: "running",
              recoveryMode: "none",
              hasLiveIteration: false,
            });
            outcome.value = { kind: "none" };
            compensate = true;
            return running;
          }

          // Re-judge the batch on the re-taken freezes, atomically. Only the
          // comparison happens here — the realpath work is already done — so
          // the reducer stays synchronous. A member refused now was admitted on
          // a prefix set the checkout invalidated: it keeps no lane, gives back
          // its stamp, and stays eligible. Its next pass canonicalizes against
          // the worktree that now exists, so the collision is visible up front
          // and the refusal is stable rather than a livelock.
          // Owner fence on the per-context stamp, the twin of the one
          // `releaseLaneReservations` applies to the lane claim (decision D5).
          // A context whose stamp is no longer this batch's was taken over
          // while provisioning was in flight — by reservation recovery or a
          // replacement batch. Starting it here would run it under a plan its
          // current owner did not make, and clearing the stamp would erase that
          // owner's claim, so it is dropped untouched.
          // Both halves of the claim are fenced, because either can be replaced
          // while provisioning is in flight and each alone is insufficient: the
          // context stamp says this batch may still start THIS context, and the
          // lane claim says it may still materialize and occupy THAT lane. The
          // owner-checked delete afterwards is cleanup, not an admission fence —
          // without the lane half, a batch whose claim was replaced would still
          // create the lane record and start its members on it.
          const disownedContextIds = new Set<string>();
          for (const entry of schedulableEntries) {
            const stampLost =
              running.contextStates[entry.contextId]?.reservedByBatchId !==
              batchId;
            const laneClaim = running.laneReservations[entry.laneId];
            const laneLost =
              laneClaim === undefined || laneClaim.batchId !== batchId;
            if (!stampLost && !laneLost) continue;
            disownedContextIds.add(entry.contextId);
            // Give back only what is still ours. A stamp this batch still holds
            // has to be released or the context is stranded ineligible; a stamp
            // already reassigned belongs to its new owner and is left alone.
            if (!stampLost) {
              const contextState = running.contextStates[entry.contextId];
              if (contextState) {
                contextState.reservedByBatchId = null;
                contextState.reservedOwnership = null;
              }
            }
            logger.warn("graph-workflow.scheduler.reservation_disowned", {
              executionId: running.id,
              contextId: entry.contextId,
              laneId: entry.laneId,
              batchId,
              stampLost,
              laneLost,
            });
          }

          const refusedContextIds = new Set<string>();
          if (recanonicalized.size > 0) {
            const finalizeOccupants = new Map<string, LaneOccupant[]>();
            const finalizeOccupantsOf = (laneId: string): LaneOccupant[] => {
              const known = finalizeOccupants.get(laneId);
              if (known) return known;
              const occupants: LaneOccupant[] = [];
              for (const state of Object.values(running.contextStates)) {
                if (state.laneId !== laneId) continue;
                if (state.status !== "running") continue;
                occupants.push({
                  contextId: state.contextId,
                  ownership: state.reservedOwnership ?? UNKNOWN_OWNERSHIP,
                });
              }
              finalizeOccupants.set(laneId, occupants);
              return occupants;
            };
            for (const entry of schedulableEntries) {
              if (disownedContextIds.has(entry.contextId)) continue;
              const ownership =
                recanonicalized.get(entry.contextId) ??
                entry.ownership ??
                UNKNOWN_OWNERSHIP;
              const occupants = finalizeOccupantsOf(entry.laneId);
              const verdict = classifyLaneAdmission({
                candidate: ownership,
                occupants,
              });
              if (verdict.kind === "refuse") {
                refusedContextIds.add(entry.contextId);
                const contextState = running.contextStates[entry.contextId];
                if (contextState) {
                  contextState.reservedByBatchId = null;
                  contextState.reservedOwnership = null;
                }
                logger.info(
                  "graph-workflow.scheduler.lane_admission_refused_post_provision",
                  {
                    executionId: running.id,
                    contextId: entry.contextId,
                    laneId: entry.laneId,
                    reason: verdict.reason,
                    blockingContextId: verdict.blockingContextId,
                  },
                );
                continue;
              }
              occupants.push({ contextId: entry.contextId, ownership });
            }
          }
          const admittedEntries = schedulableEntries.filter(
            (entry) =>
              !refusedContextIds.has(entry.contextId) &&
              !disownedContextIds.has(entry.contextId),
          );

          // Nothing survived the re-check, so this batch never formed. Report
          // it as such rather than as an empty parallel batch, and give back
          // only the lane claims still owned here — a replacement owner's claim
          // must outlive this finalize. Any worktree cut for a lane taken over
          // meanwhile is deliberately left in place: disposing it could remove
          // the one its new owner is about to use.
          if (admittedEntries.length === 0) {
            releaseLaneReservations(running, batchId);
            running.machineSnapshot = buildLifecycleSnapshot(running, {
              lifecycleStatus: "running",
              recoveryMode: "none",
              hasLiveIteration: false,
            });
            outcome.value = { kind: "none" };
            return running;
          }

          const provisionTimestamp = getNow(deps);

          // Mint each provisioned lane exactly once, before placing anyone on
          // it: several members of one lane can be admitted in a single pass,
          // and they all join the same record (decision D5).
          for (const { entry, result } of provisioned) {
            // A lane whose claim was replaced mid-provision is not this batch's
            // to materialize: recording it would hand the replacement owner a
            // lane record it never created. The worktree stays on disk
            // unreferenced, which is the safe side of this trade.
            if (disownedContextIds.has(entry.contextId)) continue;
            const mint = entry.mint;
            if (!mint) {
              throw new Error(
                `Provisioned lane "${entry.laneId}" has no mint plan; only a minting entry is provisioned`,
              );
            }
            // Inherit everything present in the fork parent's branch — what ran
            // on it AND what a succeeded join already merged into it — so
            // upstream visibility checks recognize the full history the fork
            // copied. Inheriting only the parent's own `includedContextIds`
            // strands the fork on any upstream that arrived by join: its work is
            // in the branch, but nothing in the lane graph connects the fork to
            // it. A lane forked from the session branch inherits nothing.
            const inheritedIncluded =
              mint.sourceLaneId === null
                ? []
                : contextsPresentInLane(mint.sourceLaneId, running);
            running.executionLanes[entry.laneId] = {
              laneId: entry.laneId,
              kind: "worktree",
              status: "active",
              worktreePath: result.worktreePath,
              branchName: result.branchName,
              includedContextIds: [...inheritedIncluded],
              lastCommittingContextId: mint.parentContextId,
              commitSnapshots: [],
              // Captured by provisioning, after the init script ran: what this
              // lane's members inherited rather than wrote (R8, decision D8).
              ignoredBaseline: [...result.ignoredBaseline],
              createdAt: provisionTimestamp,
              updatedAt: provisionTimestamp,
            };
            if (mint.sourceLaneId !== null && mint.parentContextId !== null) {
              laneForkedDecisions.push({
                newLaneId: entry.laneId,
                contextId: entry.contextId,
                parentLaneId: mint.sourceLaneId,
                parentContextId: mint.parentContextId,
                parentBranchName: mint.parentBranchName,
                branchName: result.branchName,
                worktreePath: result.worktreePath,
              });
            } else {
              laneCreatedDecisions.push({
                laneId: entry.laneId,
                contextId: entry.contextId,
                branchName: result.branchName,
                worktreePath: result.worktreePath,
                kind: "worktree",
              });
            }
          }

          for (const entry of admittedEntries) {
            const { contextId, laneId } = entry;
            const contextState = running.contextStates[contextId]!;
            transitionContextStatus(running, contextId, "running", {
              reason: "manager.schedule_eligible_contexts.batch",
            });
            contextState.batchId = batchId;
            // Reservation realized: the context is now `running`, so drop the
            // owner-discriminated stamp the reserve set (Design 3.1). The frozen
            // ownership STAYS — it is the envelope dispatch composes the turn's
            // write policy from, and the set later admissions compare against.
            // Where the pre-provision freeze was provisional, the re-taken one
            // supersedes it, so the persisted envelope is the one this context
            // was actually admitted under.
            contextState.reservedByBatchId = null;
            const refrozen = recanonicalized.get(contextId);
            if (refrozen) contextState.reservedOwnership = refrozen;

            const placement = running.workingDefinition.executionContexts.find(
              (context) => context.id === contextId,
            )?.placement;
            if (
              placement?.lane === SESSION_LANE_NAME &&
              placement.mode === "readOnly"
            ) {
              contextState.laneId = null;
              contextState.worktreePath = null;
              contextState.branchName = null;
              contextState.isolation = "session";
              contextState.batchId = null;
              continue;
            }

            const lane = running.executionLanes[laneId];
            if (!lane) {
              // The session lane before final publish materializes a record for
              // it: the context runs in the session worktree with no lane.
              if (laneId === SESSION_LANE_ID) {
                contextState.laneId = null;
                contextState.worktreePath = null;
                contextState.branchName = null;
                contextState.isolation = "session";
                contextState.batchId = null;
                continue;
              }
              throw new Error(
                `Lane "${laneId}" referenced by context "${contextId}" was not found in executionLanes`,
              );
            }

            contextState.laneId = laneId;
            if (lane.kind === "session") {
              contextState.worktreePath = null;
              contextState.branchName = null;
              contextState.isolation = "session";
              laneReusedDecisions.push({
                laneId,
                contextId,
                branchName: null,
                worktreePath: null,
                kind: "session",
              });
              continue;
            }
            if (lane.worktreePath === null) {
              throw new Error(
                `Lane "${laneId}" referenced by context "${contextId}" is worktree-kind but has null worktreePath`,
              );
            }
            contextState.worktreePath = lane.worktreePath;
            contextState.branchName = lane.branchName;
            contextState.isolation = "worktree";
            if (entry.mint === null) {
              laneReusedDecisions.push({
                laneId,
                contextId,
                branchName: lane.branchName,
                worktreePath: lane.worktreePath,
                kind: "worktree",
              });
            }
          }

          releaseLaneReservations(running, batchId);

          // Landing intents ride the SAME mutation that assigns the lanes
          // (decision D8): the placement above is what decides how each context
          // will land, so recording the intent anywhere later would leave a
          // window where the only record of it lives in the runner's memory.
          for (const entry of admittedEntries) {
            recordDispatchLandingIntent(
              running,
              entry.contextId,
              provisionTimestamp,
            );
          }

          const activeIdSet = new Set(running.activeContextIds);
          for (const entry of admittedEntries) {
            activeIdSet.add(entry.contextId);
          }
          running.activeContextIds = [...activeIdSet];
          const clearedLanes = clearLaneStatesFor(
            running,
            admittedEntries.map((e) => e.contextId),
          );
          scheduledClearedLanes = clearedLanes;

          running.machineSnapshot = buildLifecycleSnapshot(running, {
            lifecycleStatus: "running",
            recoveryMode: "none",
            hasLiveIteration: false,
          });

          outcome.value = {
            kind: "parallel",
            batchId,
            contextIds: admittedEntries.map((e) => e.contextId),
          };
          return running;
        })
        .catch(async (err: unknown) => {
          // A finalize refused for a non-fence reason leaves the reserve's
          // stamps set; the owner-checked release inside `compensateSchedule`
          // clears them so the contexts re-schedule. When the refusal IS a
          // stale fence the stamps live on a superseded generation and the
          // release fences out harmlessly. Disposal is best-effort and cannot
          // skip the release.
          await compensateSchedule();
          throw err;
        });
      if (compensate) {
        // Halt superseded this batch: the fenced finalize already cleared the
        // reservation stamps atomically, so only the provisioned worktrees need
        // best-effort disposal here.
        const disposalFailures = await disposeProvisioned();
        if (disposalFailures.length > 0) {
          logger.warn("graph-workflow.scheduler.lane_dispose_failed", {
            failedLaneBranches: disposalFailures.map((f) => f.branchName),
          });
        }
      }
    }

    const scheduled = outcome.value;
    const execLogger = getExecutionLogger(nextExecution.id);

    if (readySetEligibleContextIds.length > 0) {
      execLogger?.lifecycle("scheduler.ready_set", {
        eligibleContextIds: readySetEligibleContextIds,
      });
      logger.info("graph-workflow.scheduler.ready_set", {
        executionId: nextExecution.id,
        eligibleContextIds: readySetEligibleContextIds,
      });
    }

    for (const decision of laneCreatedDecisions) {
      execLogger?.lifecycle("lane.created", decision);
      logger.info("graph-workflow.lane.created", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    for (const decision of laneForkedDecisions) {
      execLogger?.lifecycle("lane.forked", decision);
      logger.info("graph-workflow.lane.forked", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    for (const decision of laneReusedDecisions) {
      execLogger?.lifecycle("lane.reused", decision);
      logger.info("graph-workflow.lane.reused", {
        executionId: nextExecution.id,
        ...decision,
      });
    }

    if (scheduledClearedLanes.length > 0) {
      execLogger?.lifecycle("lane.cleanup", {
        clearedLaneStateContextIds: scheduledClearedLanes,
      });
      logger.info("graph-workflow.lane.cleanup", {
        executionId: nextExecution.id,
        clearedLaneStateContextIds: scheduledClearedLanes,
      });
    }

    if (scheduled.kind === "solo") {
      logger.info("graph-workflow.context.scheduled", {
        executionId: nextExecution.id,
        nextContextId: scheduled.contextId,
        eligibleContextIds: [scheduled.contextId],
        clearedLanes: scheduledClearedLanes,
      });
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

        transitionContextStatus(running, input.contextId, "ready", {
          reason: "manager.recover_retryable_iteration_error",
        });
        if (!running.activeContextIds.includes(input.contextId)) {
          running.activeContextIds = [
            ...running.activeContextIds,
            input.contextId,
          ];
        }
        running.completedAt = null;
        running.haltReason = null;
        running.machineSnapshot = buildLifecycleSnapshot(running, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });

        const implementerLane =
          running.laneStates[input.contextId]?.["implementer"];
        rotationScheduled =
          implementerLane?.refKind === "conversation" &&
          implementerLane.contextId === input.contextId;

        if (rotationScheduled && implementerLane) {
          implementerLane.metrics.rotateBeforeNextTurn = true;
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
    let rejectedStatus: GraphWorkflowStatus | null = null;
    let rejectedExecutionId: string | null = null;

    const nextExecution = await deps.executionRepository.mutateActive(
      projectPath,
      sessionName,
      (execution) => {
        if (
          input.expectedExecutionId !== undefined &&
          execution.id !== input.expectedExecutionId
        ) {
          rejectedExecutionId = execution.id;
          return execution;
        }
        // A pending halt reason is a signal to a running loop's
        // drain-then-halt path. The loop fence rejects writes from a generation
        // retired by pause/halt/abort; this status guard also protects unfenced
        // callers from poisoning suspended state with a late halt signal.
        if (execution.status !== "running") {
          rejectedStatus = execution.status;
          return execution;
        }
        const next = cloneExecution(execution);
        if (applyAdditionalMutation) {
          applyAdditionalMutation(next);
        }
        if (execution.pendingHaltReason === null) {
          next.pendingHaltReason = reason;
          accepted = true;
        } else if (next.secondaryHaltReasons.length < 10) {
          next.secondaryHaltReasons = [...next.secondaryHaltReasons, reason];
        }
        return next;
      },
    );

    if (rejectedExecutionId !== null) {
      logger.warn(
        "graph-workflow.parallel.pending_halt_rejected_execution_mismatch",
        {
          expectedExecutionId: input.expectedExecutionId,
          activeExecutionId: rejectedExecutionId,
          attemptedHaltReasonType: reason.type,
        },
      );
      return { execution: nextExecution, accepted: false };
    }

    if (rejectedStatus !== null) {
      const execLogger = getExecutionLogger(nextExecution.id);
      execLogger?.lifecycle("parallel.pending_halt_rejected_non_running", {
        attemptedHaltReason: reason,
        executionStatus: rejectedStatus,
      });
      logger.warn("graph-workflow.parallel.pending_halt_rejected_non_running", {
        executionId: nextExecution.id,
        attemptedHaltReasonType: reason.type,
        executionStatus: rejectedStatus,
      });
      return { execution: nextExecution, accepted: false };
    }

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
        if (
          input.expectedExecutionId !== undefined &&
          execution.id !== input.expectedExecutionId
        ) {
          logger.warn("graph-workflow.drain_halt.execution_mismatch", {
            expectedExecutionId: input.expectedExecutionId,
            activeExecutionId: execution.id,
          });
          throw new Error(
            `Cannot drain execution ${input.expectedExecutionId}: active execution is ${execution.id}`,
          );
        }
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

    await stopLaneDevServers({ execution: nextExecution, projectPath });

    const execLogger = getExecutionLogger(nextExecution.id);
    execLogger?.lifecycle("execution.halted", {
      haltReason: nextExecution.haltReason,
      cause: "drain_and_halt",
      actor: "system",
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

    // Mark every event filed under the context up to the current insertion
    // boundary as pre-reset before the reset write appends its own status-change
    // events, so those new events stay visible post-reset (the old in-memory
    // history.map ran before the reset's appendEvents for the same reason).
    const active = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (active) {
      await deps.executionRepository.markContextEventsPreReset(
        projectPath,
        sessionName,
        active.id,
        contextId,
      );
      // Stop this context's lane dev servers before the reset drops its lane
      // association (resetExecutionContext rebuilds the context's lane state).
      await stopLaneDevServers({
        execution: active,
        projectPath,
        contextIds: [contextId],
      });
      // Reset-intent log emitted BEFORE entering the queue, off the write-queue
      // critical section (`no-slow-work-in-critical-section`).
      logger.info("graph-workflow.context.reset_requested", {
        executionId: active.id,
        contextId,
        status: active.status,
      });
    }

    // The reducer captures the pre-reset status (pure) and returns the reset
    // execution; a rejected reset (ResetExecutionContextError) is logged in the
    // catch below, outside the lock.
    let resetExecutionId: string | null = null;
    let nextExecution: GraphWorkflowExecution;
    try {
      nextExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) => {
          previousStatus = execution.status;
          resetExecutionId = execution.id;
          return resetExecutionContext(execution, contextId);
        },
      );
    } catch (error) {
      if (error instanceof ResetExecutionContextError) {
        logger.warn("graph-workflow.context.reset_rejected", {
          executionId: resetExecutionId,
          contextId,
          status: previousStatus,
          reason: error.message,
        });
      }
      throw error;
    }

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

  /**
   * Reset ONE validator assignment on a paused or halted execution (R8.3).
   *
   * Narrower than {@link resetContext} by design: the sibling verdicts that
   * judged the same candidate, the implementer's lane, and the context's task
   * state all survive. The reducer is pure, so the two effects it implies —
   * stopping the retired conversation and publishing the withdrawal of a
   * question nobody can answer any more — happen here, post-commit.
   */
  async function resetContextAssignment(
    projectPath: string,
    sessionName: string,
    contextId: string,
    assignmentId: string,
  ): Promise<GraphWorkflowExecution> {
    let retiredConversationId: string | null = null;
    let withdrawnQuestion: {
      conversationId: string;
      questionBatchId: string;
    } | null = null;
    let previousStatus: GraphWorkflowStatus | null = null;
    let resetExecutionId: string | null = null;

    let nextExecution: GraphWorkflowExecution;
    try {
      nextExecution = await deps.executionRepository.mutateActive(
        projectPath,
        sessionName,
        (execution) => {
          previousStatus = execution.status;
          resetExecutionId = execution.id;
          const result = resetExecutionContextAssignment(execution, {
            contextId,
            assignmentId,
          });
          retiredConversationId = result.retiredConversationId;
          withdrawnQuestion = result.withdrawnQuestion;
          return result.execution;
        },
      );
    } catch (error) {
      if (error instanceof ResetAssignmentError) {
        logger.warn("graph-workflow.assignment.reset_rejected", {
          executionId: resetExecutionId,
          contextId,
          assignmentId,
          status: previousStatus,
          reason: error.message,
        });
      }
      throw error;
    }

    if (retiredConversationId !== null && deps.retireLaneConversation) {
      try {
        deps.retireLaneConversation({
          projectPath,
          sessionName,
          conversationId: retiredConversationId,
        });
      } catch (error) {
        logger.warn("graph-workflow.assignment.retire_lane_failed", {
          executionId: nextExecution.id,
          contextId,
          assignmentId,
          error: getErrorMessage(error),
        });
      }
    }

    if (withdrawnQuestion !== null) {
      const question: { conversationId: string; questionBatchId: string } =
        withdrawnQuestion;
      sendConversationEvent(projectPath, sessionName, question.conversationId, {
        type: "CLEAR_PENDING_QUESTION",
      });
      eventPublisher.deliver(
        eventPublisher.publishUserInputResolved({
          projectPath,
          sessionName,
          execution: nextExecution,
          contextId,
          conversationId: question.conversationId,
          questionBatchId: question.questionBatchId,
          resolution: "withdrawn",
          resolvedAt: getNow(deps),
        }),
      );
    }

    getExecutionLogger(nextExecution.id)?.lifecycle("assignment.reset", {
      contextId,
      assignmentId,
      previousStatus,
    });
    logger.info("graph-workflow.assignment.reset_applied", {
      executionId: nextExecution.id,
      contextId,
      assignmentId,
      retiredConversation: retiredConversationId !== null,
      withdrewQuestion: withdrawnQuestion !== null,
    });

    return nextExecution;
  }

  async function mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
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
    recordDefinitionApproval,
    send,
    resume,
    normalizeAfterRestart,
    scheduleNextContext,
    scheduleEligibleContexts,
    recoverRetryableIterationError,
    recordPendingHaltReason,
    drainAndHalt,
    resetContext,
    resetContextAssignment,
    hasActive,
    mutateActive,
    getActive,
  };
}
