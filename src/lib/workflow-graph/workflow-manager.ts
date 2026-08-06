import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import path from "node:path";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { StaleLoopFenceError } from "@/lib/workflow-graph/loop-fence";
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
  validateContextId,
  type ParallelWorktrees,
  type ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
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
 * Find the upstream context whose laneId matches `laneId` and which is the
 * direct dependency of any of `contenders`. Used at fan-out to identify the
 * parent so the scheduler can consult `lanePlan.continuationMap[parentId]`
 * to pick which child inherits the lane.
 */
function findUpstreamCompletedOnLane(
  contenders: readonly string[],
  laneId: string,
  execution: GraphWorkflowExecution,
): string | null {
  const contenderSet = new Set(contenders);
  for (const edge of execution.workingDefinition.edges) {
    if (!contenderSet.has(edge.targetContextId)) continue;
    const upstream = execution.contextStates[edge.sourceContextId];
    if (!upstream) continue;
    if (upstream.laneId !== laneId) continue;
    if (upstream.status !== "completed") continue;
    return edge.sourceContextId;
  }
  return null;
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

    const normalizedJoinIds: string[] = [];
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
      classification: Extract<ContextSchedulability, { kind: "schedulable" }>;
      // When set, this entry is a fan-out fork: the candidate lost the
      // continuation contest for `sourceLaneId` and must provision a fresh
      // worktree lane from the parent lane's committed head (parentBranch).
      // Forked lane id equals the candidate's contextId.
      forkFromLane: {
        sourceLaneId: string;
        parentBranchName: string;
        parentContextId: string;
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

    // Staged protocol (Design 3.1): worktree provisioning (`getSession`,
    // `provisionLane`) — the ~20.8s hold — runs OUTSIDE the write queue between
    // a short synchronous `reserve` mutation (classify + record `ready` intent,
    // fenced) and a short synchronous `finalize` mutation (apply the lane state,
    // fence + halt re-checked, else compensate by disposing the worktrees).
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
        let remainingCapacity = initialCapacity;
        // Reservations made within this scheduling pass. Two fan-out contexts
        // classified against the same pre-scheduling snapshot would each see
        // the same idle source lane; without reservation tracking they would
        // both be marked running on that lane. Skip any later entry whose
        // target was already claimed by an earlier entry in this pass.
        const reservedLaneIds = new Set<string>();
        // Two-pass scheduling: collect classifications first so the plan-driven
        // inheritance decision can compare all contenders before reservation.
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
        // Plan-driven inheritor per contested lane. For each lane that two or
        // more candidates want to reuse, look up the parent context whose lane
        // matches and consult `lanePlan.continuationMap` to pick the inheriting
        // child. Fallback to the first candidate in definition order when no
        // plan entry exists. Sole contenders inherit unconditionally.
        const inheritorByLane = new Map<string, string>();
        const parentContextByLane = new Map<string, string>();
        const contendersByLane = new Map<string, string[]>();
        for (const candidate of candidates) {
          if (candidate.classification.targetLaneId === null) continue;
          const laneId = candidate.classification.targetLaneId;
          const list = contendersByLane.get(laneId) ?? [];
          list.push(candidate.contextId);
          contendersByLane.set(laneId, list);
        }
        for (const [laneId, contenders] of contendersByLane) {
          const parentContextId = findUpstreamCompletedOnLane(
            contenders,
            laneId,
            running,
          );
          if (parentContextId !== null) {
            parentContextByLane.set(laneId, parentContextId);
          }
          if (contenders.length === 1) {
            inheritorByLane.set(laneId, contenders[0]!);
            continue;
          }
          const planned = parentContextId
            ? running.lanePlan.continuationMap[parentContextId]
            : undefined;
          if (planned && contenders.includes(planned)) {
            inheritorByLane.set(laneId, planned);
          } else {
            inheritorByLane.set(laneId, contenders[0]!);
          }
        }
        for (const candidate of candidates) {
          const { contextId, classification } = candidate;
          if (remainingCapacity !== undefined && remainingCapacity <= 0) break;
          let forkFromLane: SchedulableEntry["forkFromLane"] = null;
          if (classification.targetLaneId !== null) {
            const inheritor = inheritorByLane.get(classification.targetLaneId);
            if (inheritor !== undefined && inheritor !== contextId) {
              // Non-inheritor sibling at fan-out: fork from the parent lane's
              // committed head if the parent lane is a worktree (forkable). A
              // session-kind parent cannot be forked, so the sibling waits for
              // the inheritor to release the lane on its next pass.
              const parentLane =
                running.executionLanes[classification.targetLaneId];
              const parentContextId = parentContextByLane.get(
                classification.targetLaneId,
              );
              if (
                !parentLane ||
                parentLane.kind !== "worktree" ||
                parentLane.worktreePath === null ||
                !parentContextId
              ) {
                continue;
              }
              forkFromLane = {
                sourceLaneId: classification.targetLaneId,
                parentBranchName: parentLane.branchName,
                parentContextId,
              };
            } else if (reservedLaneIds.has(classification.targetLaneId)) {
              // Defensive: an earlier candidate already claimed this lane in
              // this pass. Skip to avoid double-reserving.
              continue;
            }
          }
          schedulableEntries.push({ contextId, classification, forkFromLane });
          if (classification.targetLaneId !== null && forkFromLane === null) {
            reservedLaneIds.add(classification.targetLaneId);
          }
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
        const planHasContinuation = (contextId: string): boolean =>
          running.lanePlan.continuationMap[contextId] !== undefined;

        const soloEntry =
          schedulableEntries.length === 1 ? schedulableEntries[0]! : null;
        // A solo entry with a planned continuation must be provisioned into a
        // fresh worktree lane up front so downstream consumers can reuse the
        // same lane (sequential reuse). Without this, a root context would
        // land in `laneId: null` and the next context's classifier would see
        // no worktree source lane to reuse.
        const isSoloSession =
          soloEntry !== null &&
          soloEntry.classification.targetLaneId === null &&
          !soloEntry.classification.requiresFork &&
          !(canMintLane && planHasContinuation(soloEntry.contextId));

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

        // Concurrent session-bound contexts can't share the session worktree;
        // force fork when more than one entry would otherwise target session.
        const multiContextBatch = schedulableEntries.length > 1;
        const needsProvisioning = (entry: SchedulableEntry): boolean => {
          if (entry.forkFromLane !== null) return true;
          if (entry.classification.targetLaneId !== null) return false;
          if (entry.classification.requiresFork) return true;
          // Mint a fresh worktree lane for any session-bound entry whose lane
          // plan has a continuation — downstream consumers need a worktree
          // source lane to reuse for sequential lane reuse.
          if (planHasContinuation(entry.contextId)) return true;
          return multiContextBatch;
        };

        for (const entry of schedulableEntries) {
          validateContextId(entry.contextId);
        }

        // Reserve records the routing intent AND persists an owner-discriminated
        // reservation: each context this pass claims is stamped with the batch
        // id it will provision under (Design 3.1). Eligible contexts are already
        // marked `ready` above (surfaced in the UI), but `getEligibleContextIds`
        // now excludes a stamped context — so a concurrent same-epoch scheduler
        // running between this reserve's commit and the fenced finalize cannot
        // re-classify and double-provision these contexts. The running/lane
        // transition and the stamp's clearing happen at finalize, out of the
        // lock.
        const batchId = deps.createBatchId?.() ?? randomUUID();
        for (const entry of schedulableEntries) {
          const contextState = running.contextStates[entry.contextId];
          if (contextState) {
            contextState.reservedByBatchId = batchId;
          }
        }
        running.machineSnapshot = buildLifecycleSnapshot(running, {
          lifecycleStatus: "running",
          recoveryMode: "none",
          hasLiveIteration: false,
        });
        provisionPlan.value = {
          schedulableEntries,
          provisionEntries: schedulableEntries.filter(needsProvisioning),
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
              for (const entry of schedulableEntries) {
                const contextState = running.contextStates[entry.contextId];
                if (contextState?.reservedByBatchId === batchId) {
                  contextState.reservedByBatchId = null;
                }
              }
              return running;
            },
          );
        } catch (err) {
          if (!(err instanceof StaleLoopFenceError)) throw err;
        }
      };

      // Resolve the provisioning deps + session OUTSIDE the reserve lock. Reserve
      // rejects the deps-absent branch, but re-narrow here for the provisioning
      // calls. Any failure — missing dep, a rejected `getSession`, or a null
      // session — releases the reservations before aborting, so a lookup failure
      // after the reserve commits can never strand the batch's stamps.
      const { parallelWorktrees, sessionDir, sessionBranch } =
        await (async () => {
          const parallelWorktreesDep = deps.parallelWorktrees;
          const getSessionDep = deps.getSession;
          if (!parallelWorktreesDep || !getSessionDep) {
            throw new Error(
              "scheduleEligibleContexts requires `parallelWorktrees` and `getSession` deps when provisioning lanes",
            );
          }
          const session = await getSessionDep(projectPath, sessionName);
          if (!session) {
            throw new Error(
              `Session "${sessionName}" was not found for parallel scheduling`,
            );
          }
          return {
            parallelWorktrees: parallelWorktreesDep,
            sessionDir: path.basename(session.worktreePath),
            sessionBranch: session.branchName,
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
          const baseBranch =
            entry.forkFromLane?.parentBranchName ?? sessionBranch;
          const result = await parallelWorktrees.provisionLane({
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch: baseBranch,
            laneId: entry.contextId,
          });
          provisioned.push({ entry, result });
        }
      } catch (err) {
        await compensateSchedule();
        throw err;
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
              if (contextState) {
                contextState.reservedByBatchId = null;
              }
            }
            running.machineSnapshot = buildLifecycleSnapshot(running, {
              lifecycleStatus: "running",
              recoveryMode: "none",
              hasLiveIteration: false,
            });
            outcome.value = { kind: "none" };
            compensate = true;
            return running;
          }

          const provisionTimestamp = getNow(deps);
          for (const entry of schedulableEntries) {
            const { classification, contextId, forkFromLane } = entry;
            const contextState = running.contextStates[contextId]!;
            transitionContextStatus(running, contextId, "running", {
              reason: "manager.schedule_eligible_contexts.batch",
            });
            contextState.batchId = batchId;
            // Reservation realized: the context is now `running`, so drop the
            // owner-discriminated stamp the reserve set (Design 3.1).
            contextState.reservedByBatchId = null;

            if (forkFromLane !== null) {
              // Fan-out fork: provision a new worktree lane forked from the
              // parent lane's committed head. The new lane's id matches the
              // contextId. Inherit everything present in the parent's branch —
              // what ran on it AND what a succeeded join already merged into
              // it — so upstream visibility checks recognize the full history
              // the fork copied. Inheriting only the parent's own
              // `includedContextIds` strands the fork on any upstream that
              // arrived by join: its work is in the branch, but nothing in the
              // lane graph connects the fork to it.
              const prov = provisioned.find(
                (p) => p.entry.contextId === contextId,
              );
              if (!prov) {
                throw new Error(
                  `Fork provisioning for context "${contextId}" missing from provisioned results`,
                );
              }
              const inheritedIncluded = contextsPresentInLane(
                forkFromLane.sourceLaneId,
                running,
              );
              const newLaneId = contextId;
              running.executionLanes[newLaneId] = {
                laneId: newLaneId,
                kind: "worktree",
                status: "active",
                worktreePath: prov.result.worktreePath,
                branchName: prov.result.branchName,
                includedContextIds: [...inheritedIncluded],
                lastCommittingContextId: forkFromLane.parentContextId,
                commitSnapshots: [],
                createdAt: provisionTimestamp,
                updatedAt: provisionTimestamp,
              };
              contextState.laneId = newLaneId;
              contextState.worktreePath = prov.result.worktreePath;
              contextState.branchName = prov.result.branchName;
              contextState.isolation = "worktree";
              laneForkedDecisions.push({
                newLaneId,
                contextId,
                parentLaneId: forkFromLane.sourceLaneId,
                parentContextId: forkFromLane.parentContextId,
                parentBranchName: forkFromLane.parentBranchName,
                branchName: prov.result.branchName,
                worktreePath: prov.result.worktreePath,
              });
              continue;
            }

            if (classification.targetLaneId !== null) {
              const lane = running.executionLanes[classification.targetLaneId];
              if (!lane) {
                throw new Error(
                  `Target lane "${classification.targetLaneId}" referenced by context "${contextId}" was not found in executionLanes`,
                );
              }
              contextState.laneId = classification.targetLaneId;
              if (lane.kind === "session") {
                contextState.worktreePath = null;
                contextState.branchName = null;
                contextState.isolation = "session";
                laneReusedDecisions.push({
                  laneId: lane.laneId,
                  contextId,
                  branchName: null,
                  worktreePath: null,
                  kind: "session",
                });
              } else {
                if (lane.worktreePath === null) {
                  throw new Error(
                    `Target lane "${classification.targetLaneId}" referenced by context "${contextId}" is worktree-kind but has null worktreePath`,
                  );
                }
                contextState.worktreePath = lane.worktreePath;
                contextState.branchName = lane.branchName;
                contextState.isolation = "worktree";
                laneReusedDecisions.push({
                  laneId: lane.laneId,
                  contextId,
                  branchName: lane.branchName,
                  worktreePath: lane.worktreePath,
                  kind: "worktree",
                });
              }
              continue;
            }

            const prov = provisioned.find(
              (p) => p.entry.contextId === contextId,
            );
            if (prov) {
              // Every provisioned worktree is a lane — terminal contexts
              // included. Lane work publishes only through join-runner (context
              // joins + the quiescence final_publish join), which carries the
              // execution's provenance to the delivery gate; the laneId-null
              // fan-in path bypasses the gate and remains only for resumed
              // legacy executions. The lane id matches the contextId so
              // downstream consumers can identify the upstream's lane via the
              // existing classifier path. The minted lane starts empty —
              // commitments are recorded later by `runLaneCommit`.
              const newLaneId = contextId;
              running.executionLanes[newLaneId] = {
                laneId: newLaneId,
                kind: "worktree",
                status: "active",
                worktreePath: prov.result.worktreePath,
                branchName: prov.result.branchName,
                includedContextIds: [],
                lastCommittingContextId: null,
                commitSnapshots: [],
                createdAt: provisionTimestamp,
                updatedAt: provisionTimestamp,
              };
              contextState.laneId = newLaneId;
              laneCreatedDecisions.push({
                laneId: newLaneId,
                contextId,
                branchName: prov.result.branchName,
                worktreePath: prov.result.worktreePath,
                kind: "worktree",
              });
              contextState.worktreePath = prov.result.worktreePath;
              contextState.branchName = prov.result.branchName;
              contextState.isolation = "worktree";
              continue;
            }

            contextState.laneId = null;
            contextState.worktreePath = null;
            contextState.branchName = null;
            contextState.isolation = "session";
            contextState.batchId = null;
          }

          const activeIdSet = new Set(running.activeContextIds);
          for (const entry of schedulableEntries) {
            activeIdSet.add(entry.contextId);
          }
          running.activeContextIds = [...activeIdSet];
          const clearedLanes = clearLaneStatesFor(
            running,
            schedulableEntries.map((e) => e.contextId),
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
            contextIds: schedulableEntries.map((e) => e.contextId),
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
