import path from "node:path";
import { createLogger } from "@/lib/logging";
import { assertNever } from "@/lib/shared/assert-never";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import { publishEvent } from "@/lib/events/publication";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import type {
  GraphWorkflowApprovalPendingEvent,
  GraphWorkflowApprovalResolvedEvent,
  GraphWorkflowBatchScheduledEvent,
  GraphWorkflowBoundaryEvent,
  GraphWorkflowBoundaryKind,
  GraphWorkflowCharterRegisteredEvent,
  GraphWorkflowCharterUpdatedEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowExecutionAmendedEvent,
  GraphWorkflowContextSkippedEvent,
  GraphWorkflowRouteResolvedEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowJoinStatusEvent,
  GraphWorkflowLaneConcurrentAdmissionEvent,
  GraphWorkflowLaneCreatedEvent,
  GraphWorkflowLaneCommitEvent,
  GraphWorkflowLaneDriftHaltedEvent,
  GraphWorkflowPlanDefectHaltedEvent,
  GraphWorkflowLaneLandedEvent,
  GraphWorkflowLaneStatusEvent,
  GraphWorkflowGraphExpandedEvent,
  GraphWorkflowLiveEditAppliedEvent,
  GraphWorkflowLoopDecisionEvent,
  GraphWorkflowPlanRepairEvent,
  GraphWorkflowMergeStatusEvent,
  GraphWorkflowPendingHaltReasonEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowStatusEvent,
  GraphWorkflowUserInputPendingEvent,
  GraphWorkflowUserInputResolvedEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationSpecialistEntry,
  GraphWorkflowValidationSpecialistResultEvent,
  GraphWorkflowValidationIncidentEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowHaltReason,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidationSessionRef,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowValidationIssue,
  GraphWorkflowValidatorType,
} from "@/lib/workflow-graph/definition-schemas";
import { SESSION_LANE_ID } from "@/lib/workflow-graph/lane-identity";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import { projectGraphWorkflowResultOutputs } from "@/lib/workflow-graph/context-outputs";

const liveEditLogger = createLogger("workflow.live-edit");
const laneLogger = createLogger("workflow.lanes");
const validationLogger = createLogger("workflow.validation");

function defaultBroadcast(event: GraphWorkflowSSEEvent): void {
  publishEvent(event);
}

/**
 * The pure-DATA result of a publisher-derivation call (Design 3.2). Building it
 * has NO side effects and it carries NO callable: `events` are the append-only
 * rows persisted in the mutation's transaction (each row's inner SSE event is
 * also what gets broadcast), and `pushes` are the push-notification descriptors
 * to dispatch. Because the record is inert data, a mutation reducer that returns
 * it literally cannot broadcast before its write persists — delivery is
 * performed only by {@link deliverGraphWorkflowEvents}, which the mutation seam
 * invokes AFTER its transaction commits (`post-commit-delivery`). Callers lose
 * delivery access entirely; the seam owns delivery timing.
 */
export interface GraphWorkflowEventDelivery {
  events: GraphWorkflowExecutionEvent[];
  pushes: GraphWorkflowPushInfo[];
  /** Typed invalidations derived from inserted row ids; never persisted again. */
  publications?: GraphWorkflowSSEEvent[];
  resultEffects?: Array<{
    projectPath: string;
    event: Extract<
      GraphWorkflowSSEEvent,
      { type: "graph-workflow-result-recorded" }
    >;
  }>;
}

/**
 * Concatenate several deliveries into one: append-only rows and push descriptors
 * join in order. Pure data — used where a single mutation bundles events from
 * more than one publisher call (e.g. charter-registered + the initial status
 * diff at execution create).
 */
export function combineEventDeliveries(
  deliveries: readonly GraphWorkflowEventDelivery[],
): GraphWorkflowEventDelivery {
  return {
    events: deliveries.flatMap((delivery) => delivery.events),
    pushes: deliveries.flatMap((delivery) => delivery.pushes),
    publications: deliveries.flatMap((delivery) => delivery.publications ?? []),
    resultEffects: deliveries.flatMap(
      (delivery) => delivery.resultEffects ?? [],
    ),
  };
}

interface PublishExecutionUpdateInput {
  projectPath: string;
  sessionName: string;
  previousExecution: GraphWorkflowExecution | null;
  nextExecution: GraphWorkflowExecution;
}

interface PublishValidationResultInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  validatorType: GraphWorkflowValidatorType;
  /** Defaults to the agent/script validator verdict this event has always
   *  carried; `output_schema` marks a D2 format-turn rejection. */
  kind?: GraphWorkflowValidationResultEvent["kind"];
  pass: boolean;
  summary: string;
  issues?: readonly GraphWorkflowValidationIssue[];
  reopenTaskIds?: string[];
  /** The refused payload, for an `output_schema` failure only. */
  rejectedOutput?: string | null;
  /** The structured-output gate's bounded-repair spend and budget, for an
   *  `output_schema` failure only. */
  gateRepair?: { attempts: number; maxAttempts: number } | null;
  /** The contract that refused the payload, snapshotted so a later schema edit
   *  cannot re-caption this rejection. `output_schema` failures only. */
  rejectedAgainstSchema?: Record<string, unknown> | null;
  sessionRef?: GraphWorkflowValidationSessionRef | null;
  reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
  /**
   * The round this verdict concluded, and every cohort member's verdict in
   * configured cohort order. Absent outside a round — and then the published
   * event carries neither field.
   */
  round?: {
    seq: number;
    specialists: readonly GraphWorkflowValidationSpecialistEntry[];
  };
}

interface PublishValidationSpecialistResultInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  roundSeq: number;
  specialist: GraphWorkflowValidationSpecialistEntry;
}

interface PublishValidationIncidentInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  incident: GraphWorkflowValidationIncidentEvent["incident"];
  roundSeq: number;
  stage: GraphWorkflowValidationIncidentEvent["stage"];
  assignmentId?: string | null;
  /** Admitted dispatches spent; only an exhaustion has a non-zero count. */
  attempts?: number;
  driftedComponents: string;
  message: string;
}

interface PublishApprovalPendingInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  requestedAt: string;
}

interface PublishApprovalResolvedInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  decision: GraphWorkflowApprovalResolvedEvent["decision"];
  message: string | null;
  decidedAt: string;
}

interface PublishUserInputPendingInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  questionBatchId: string;
  requestedAt: string;
}

interface PublishUserInputResolvedInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  conversationId: string;
  questionBatchId: string;
  resolution: GraphWorkflowUserInputResolvedEvent["resolution"];
  resolvedAt: string;
}

interface PublishCharterRegisteredInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  definitionId: string | null;
  definitionRevision: number | null;
  charterHash: string;
}

export interface PublishCharterUpdatedInput {
  projectPath: string;
  sessionName: string;
  definitionId: string | null;
  definitionRevision: number | null;
  charterHash: string;
  execution?: GraphWorkflowExecution | null;
}

export interface PublishLiveEditAppliedInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  liveRevision: number;
  operationCount: number;
  affectedContextIds: string[];
  source: GraphWorkflowLiveEditAppliedEvent["source"];
}

export interface PublishExecutionAmendedInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  liveRevision: number;
  reason: string;
  actor: string;
  policyBasis: GraphWorkflowExecutionAmendedEvent["policyBasis"];
  previousWorkingDefinitionHash: string;
  workingDefinitionHash: string;
  addedContextIds: string[];
  addedTaskIds: string[];
  addedEdgeIds: string[];
}

export interface PublishGraphExpansionInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  invokerContextId: string;
  requestId: string;
  outcome: GraphWorkflowGraphExpandedEvent["outcome"];
  addedContextIds: string[];
  addedTaskIds: string[];
  rejoinContextIds: string[];
  refusalCode: string | null;
  occurredAt: string;
}

export interface GraphWorkflowPushInfo {
  kind:
    | "workflow-completed"
    | "workflow-halted"
    | "circuit-breaker"
    | "context-completed"
    | "approval-pending"
    | "plan-repair";
  projectName: string;
  sessionName: string;
  contextTitle?: string;
  completedContexts?: number;
  totalContexts?: number;
  /** Plan-repair pushes only (docs/design/cc-cli/08). */
  planRepairOutcome?: GraphWorkflowPlanRepairEvent["outcome"];
  planRepairAttempt?: number;
  planRepairDiagnosis?: string | null;
  dedupeKey?: string;
}

export interface PublishPlanRepairInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  haltType: GraphWorkflowPlanRepairEvent["haltType"];
  loopGroupId: string | null;
  attempt: number;
  outcome: GraphWorkflowPlanRepairEvent["outcome"];
  planningDefect: boolean | null;
  diagnosis: string | null;
  operationCount: number;
  resumed: boolean;
  conversationId: string | null;
}

export interface GraphWorkflowExecutionEventPublisherDeps {
  broadcast?(event: GraphWorkflowSSEEvent): void;
  now?(): string;
  dispatchPush?(info: GraphWorkflowPushInfo): void;
  deliverResultRecorded?(input: {
    projectPath: string;
    event: Extract<
      GraphWorkflowSSEEvent,
      { type: "graph-workflow-result-recorded" }
    >;
    completionPush: GraphWorkflowPushInfo | null;
  }): Promise<void>;
}

function getNow(deps: GraphWorkflowExecutionEventPublisherDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

function getTaskSource(index: ExecutionIndex, taskId: string) {
  return index.taskById.get(taskId)?.source;
}

function orderContextIdsByActive(
  execution: GraphWorkflowExecution,
  index: ExecutionIndex,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of execution.activeContextIds) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const context of index.contextById.values()) {
    if (!seen.has(context.id)) {
      seen.add(context.id);
      out.push(context.id);
    }
  }
  return out;
}

function deriveActiveJoinIds(execution: GraphWorkflowExecution): string[] {
  const out: string[] = [];
  for (const join of Object.values(execution.joins ?? {})) {
    if (join.status === "pending" || join.status === "running") {
      out.push(join.joinId);
    }
  }
  out.sort();
  return out;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

type DirtyPath = Extract<
  GraphWorkflowHaltReason,
  { type: "merge_precondition_failed" | "worktree_creation_dirty" }
>["dirtyPaths"][number];

function dirtyPathsEqual(
  left: readonly DirtyPath[],
  right: readonly DirtyPath[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((path, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      path.path === other.path &&
      path.statusCode === other.statusCode &&
      path.tracked === other.tracked
    );
  });
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function haltReasonsEqual(
  previous: GraphWorkflowHaltReason | null,
  next: GraphWorkflowHaltReason | null,
): boolean {
  if (previous === null || next === null) {
    return previous === next;
  }

  if (previous.type !== next.type) {
    return false;
  }

  switch (previous.type) {
    case "infrastructure_blocked":
      return (
        next.type === "infrastructure_blocked" &&
        previous.contextId === next.contextId &&
        previous.commandName === next.commandName &&
        previous.attempts === next.attempts &&
        previous.message === next.message
      );
    case "delivery_gate_failed":
      // Compare the full presentation projection: halt surfaces render
      // refusalCode and the spec block (name/project deep link), so equality
      // must not swallow an observable change in either (mid-run rename).
      return (
        next.type === "delivery_gate_failed" &&
        deepEqualJson(previous.unmet, next.unmet) &&
        previous.instruction === next.instruction &&
        previous.refusalCode === next.refusalCode &&
        deepEqualJson(previous.spec ?? null, next.spec ?? null)
      );
    case "circuit_breaker":
      return (
        next.type === "circuit_breaker" &&
        previous.contextId === next.contextId &&
        previous.condition === next.condition &&
        previous.failureCount === next.failureCount &&
        previous.summary === next.summary
      );
    case "max_iterations":
      return (
        next.type === "max_iterations" &&
        previous.contextId === next.contextId &&
        previous.iterationCount === next.iterationCount
      );
    case "recovery_error":
      return (
        next.type === "recovery_error" && previous.message === next.message
      );
    case "aborted":
      return next.type === "aborted";
    case "validator_infra_error":
      return (
        next.type === "validator_infra_error" &&
        previous.contextId === next.contextId &&
        previous.engine === next.engine &&
        previous.infraReason === next.infraReason &&
        previous.message === next.message &&
        previous.summary === next.summary
      );
    case "script_validator_missing_command":
      return (
        next.type === "script_validator_missing_command" &&
        previous.contextId === next.contextId &&
        previous.message === next.message
      );
    case "script_validator_unknown_command":
      return (
        next.type === "script_validator_unknown_command" &&
        previous.contextId === next.contextId &&
        previous.commandName === next.commandName &&
        previous.message === next.message
      );
    case "validation_candidate_unavailable":
      return (
        next.type === "validation_candidate_unavailable" &&
        previous.contextId === next.contextId &&
        previous.attempts === next.attempts &&
        previous.message === next.message
      );
    case "plan_defect":
      return (
        next.type === "plan_defect" &&
        previous.contextId === next.contextId &&
        previous.roundSeq === next.roundSeq &&
        // The defects themselves are the identity: the same context can be
        // halted again on a different finding after a repair, and only the
        // finding tells the two apart. `summary` is excluded on purpose —
        // plan repair writing its verdict onto a standing halt is bookkeeping
        // about that halt (the `loop_limit_reached` precedent), never a second
        // one to announce.
        deepEqualJson(previous.planDefects, next.planDefects)
      );
    case "candidate_unstable":
      return (
        next.type === "candidate_unstable" &&
        previous.contextId === next.contextId &&
        previous.stage === next.stage &&
        previous.driftedComponents === next.driftedComponents &&
        // A run that stopped moving and started answering late is a different
        // diagnosis, so it is a different halt to announce. `summary` stays out
        // for the reason it does everywhere else: a repair verdict written onto
        // a standing halt is bookkeeping about it, not a second one.
        previous.lastIncident === next.lastIncident &&
        previous.consecutiveCount === next.consecutiveCount
      );
    case "merge_failure":
      return (
        next.type === "merge_failure" &&
        previous.contextId === next.contextId &&
        previous.message === next.message &&
        arraysEqual(previous.conflictFiles, next.conflictFiles)
      );
    case "join_failure":
      return (
        next.type === "join_failure" &&
        previous.joinId === next.joinId &&
        previous.joinKind === next.joinKind &&
        previous.contextId === next.contextId &&
        previous.targetLaneId === next.targetLaneId &&
        previous.message === next.message &&
        arraysEqual(previous.sourceLaneIds, next.sourceLaneIds) &&
        arraysEqual(previous.conflictFiles, next.conflictFiles)
      );
    case "merge_precondition_failed":
      return (
        next.type === "merge_precondition_failed" &&
        previous.contextId === next.contextId &&
        previous.targetBranch === next.targetBranch &&
        dirtyPathsEqual(previous.dirtyPaths, next.dirtyPaths) &&
        previous.totalDirtyCount === next.totalDirtyCount &&
        previous.message === next.message
      );
    case "agent_turn_failed":
      return (
        next.type === "agent_turn_failed" &&
        previous.contextId === next.contextId &&
        previous.engine === next.engine &&
        previous.cause === next.cause &&
        previous.message === next.message
      );
    case "worktree_creation_dirty":
      return (
        next.type === "worktree_creation_dirty" &&
        previous.contextId === next.contextId &&
        previous.worktreePath === next.worktreePath &&
        previous.branchName === next.branchName &&
        dirtyPathsEqual(previous.dirtyPaths, next.dirtyPaths) &&
        previous.totalDirtyCount === next.totalDirtyCount
      );
    case "execution_loop_failed":
      return (
        next.type === "execution_loop_failed" &&
        previous.contextId === next.contextId &&
        previous.message === next.message &&
        previous.cause === next.cause
      );
    case "collaboration_failure":
      return (
        next.type === "collaboration_failure" &&
        previous.status === next.status &&
        previous.brief === next.brief &&
        previous.executionContextId === next.executionContextId &&
        previous.conversationId === next.conversationId &&
        previous.summary === next.summary
      );
    case "routing_cardinality":
      return (
        next.type === "routing_cardinality" &&
        previous.contextId === next.contextId &&
        previous.policy === next.policy &&
        previous.outcome === next.outcome &&
        stringArraysEqual(previous.activatedEdgeIds, next.activatedEdgeIds) &&
        stringArraysEqual(previous.conditionalEdgeIds, next.conditionalEdgeIds)
      );
    case "routing_invariant":
      return (
        next.type === "routing_invariant" &&
        previous.contextId === next.contextId &&
        previous.reason === next.reason &&
        stringArraysEqual(previous.edgeIds, next.edgeIds)
      );
    case "loop_exit_skipped":
      return (
        next.type === "loop_exit_skipped" &&
        previous.loopGroupId === next.loopGroupId &&
        previous.pass === next.pass &&
        previous.contextId === next.contextId
      );
    case "loop_invariant":
      return (
        next.type === "loop_invariant" &&
        previous.loopGroupId === next.loopGroupId &&
        previous.pass === next.pass &&
        previous.contextId === next.contextId &&
        previous.reason === next.reason
      );
    case "loop_limit_reached":
      return (
        next.type === "loop_limit_reached" &&
        // `scope` is part of the identity: the same loop and pass can be
        // refused by its own cap or by the execution-wide backstop, and those
        // are different halts with different remedies.
        previous.scope === next.scope &&
        previous.loopGroupId === next.loopGroupId &&
        previous.pass === next.pass &&
        previous.maxPasses === next.maxPasses
      );
    case "ownership_violation":
      return (
        next.type === "ownership_violation" &&
        previous.laneId === next.laneId &&
        // The reporting context is part of the identity: the same lane can drift
        // again after a repair, and the member that noticed says which landing
        // it was found at.
        previous.contextId === next.contextId &&
        // `summary` is deliberately NOT part of the identity: plan repair
        // stamps its verdict onto a standing drift, and that is the same drift.
        arraysEqual(previous.unattributedPaths, next.unattributedPaths)
      );
  }

  return assertNever(previous);
}

function haltReasonArraysEqual(
  previous: readonly GraphWorkflowHaltReason[],
  next: readonly GraphWorkflowHaltReason[],
): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((reason, index) =>
    haltReasonsEqual(reason, next[index] ?? null),
  );
}

function deriveActiveBatchIds(execution: GraphWorkflowExecution): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const contextId of execution.activeContextIds) {
    const batchId = execution.contextStates[contextId]?.batchId;
    if (batchId && !seen.has(batchId)) {
      seen.add(batchId);
      out.push(batchId);
    }
  }
  return out;
}

function activeContextIdsByAuthoredLane(
  execution: GraphWorkflowExecution,
): Map<string, string[]> {
  const activeContextIds = new Set(execution.activeContextIds);
  const contextIdsByLane = new Map<string, string[]>();
  for (const context of execution.workingDefinition.executionContexts) {
    if (!activeContextIds.has(context.id)) continue;
    const contextIds = contextIdsByLane.get(context.placement.lane) ?? [];
    contextIds.push(context.id);
    contextIdsByLane.set(context.placement.lane, contextIds);
  }
  for (const contextId of execution.activeContextIds) {
    const context = execution.workingDefinition.executionContexts.find(
      (candidate) => candidate.id === contextId,
    );
    if (context) continue;
    const runtimeLaneId = execution.contextStates[contextId]?.laneId;
    if (!runtimeLaneId) continue;
    const contextIds = contextIdsByLane.get(runtimeLaneId) ?? [];
    contextIds.push(contextId);
    contextIdsByLane.set(runtimeLaneId, contextIds);
  }
  return contextIdsByLane;
}

function ownershipViolationReasons(
  execution: GraphWorkflowExecution | null,
): Extract<GraphWorkflowHaltReason, { type: "ownership_violation" }>[] {
  if (!execution) return [];
  return [
    execution.haltReason,
    execution.pendingHaltReason,
    ...execution.secondaryHaltReasons,
  ].filter(
    (
      reason,
    ): reason is Extract<
      GraphWorkflowHaltReason,
      { type: "ownership_violation" }
    > => reason?.type === "ownership_violation",
  );
}

/**
 * Every plan-defect halt an execution is carrying, wherever it sits in the
 * halt lifecycle. Read from all three slots for the reason the ownership-drift
 * reader is: signal-halt writes a PENDING reason and the loop drains it to
 * `haltReason` one write later, so a reader that watched only one slot would
 * either announce the halt twice or announce it a write late.
 */
function planDefectReasons(
  execution: GraphWorkflowExecution | null,
): Extract<GraphWorkflowHaltReason, { type: "plan_defect" }>[] {
  if (!execution) return [];
  return [
    execution.haltReason,
    execution.pendingHaltReason,
    ...execution.secondaryHaltReasons,
  ].filter(
    (
      reason,
    ): reason is Extract<GraphWorkflowHaltReason, { type: "plan_defect" }> =>
      reason?.type === "plan_defect",
  );
}

function laneFieldsChanged(
  previous: GraphWorkflowExecutionLaneState | undefined,
  next: GraphWorkflowExecutionLaneState,
): boolean {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.branchName !== next.branchName ||
    previous.worktreePath !== next.worktreePath ||
    previous.lastCommittingContextId !== next.lastCommittingContextId ||
    JSON.stringify(previous.includedContextIds) !==
      JSON.stringify(next.includedContextIds)
  );
}

function joinFieldsChanged(
  previous: GraphWorkflowExecutionJoinState | undefined,
  next: GraphWorkflowExecutionJoinState,
): boolean {
  if (!previous) return true;
  return (
    previous.status !== next.status ||
    previous.errorMessage !== next.errorMessage ||
    JSON.stringify(previous.mergedSourceLaneIds) !==
      JSON.stringify(next.mergedSourceLaneIds) ||
    JSON.stringify(previous.sourceLaneIds) !==
      JSON.stringify(next.sourceLaneIds) ||
    previous.targetLaneId !== next.targetLaneId ||
    JSON.stringify(previous.conflicts) !== JSON.stringify(next.conflicts) ||
    JSON.stringify(previous.resolvedConflicts ?? []) !==
      JSON.stringify(next.resolvedConflicts ?? [])
  );
}

function mergeFieldsChanged(
  previous: GraphWorkflowExecutionContextState | null,
  next: GraphWorkflowExecutionContextState,
): boolean {
  if (!previous) {
    return (
      next.mergeStatus !== "not-applicable" ||
      next.cleanupStatus !== "not-applicable" ||
      next.lastMergeError !== null
    );
  }
  return (
    previous.mergeStatus !== next.mergeStatus ||
    previous.cleanupStatus !== next.cleanupStatus ||
    previous.lastMergeError !== next.lastMergeError
  );
}

function buildEvents(
  occurredAt: string,
  events: GraphWorkflowSSEEvent[],
): GraphWorkflowExecutionEvent[] {
  return events.map(
    (event): GraphWorkflowExecutionEvent => ({
      occurredAt,
      event,
      preReset: false,
    }),
  );
}

function deriveExecutionBoundaryKind(
  previousExecution: GraphWorkflowExecution | null,
  nextExecution: GraphWorkflowExecution,
): GraphWorkflowBoundaryKind | null {
  if (
    previousExecution?.abandonment === null &&
    nextExecution.abandonment !== null
  ) {
    return "abandon";
  }

  const definitionApprovalParked =
    nextExecution.status === "pending" &&
    nextExecution.definitionApproval !== null &&
    nextExecution.definitionApproval.approvedAt === null &&
    (previousExecution === null ||
      previousExecution.definitionApproval?.requestedAt !==
        nextExecution.definitionApproval.requestedAt);
  if (definitionApprovalParked) return "definition_approval";

  if (previousExecution?.status === nextExecution.status) return null;
  switch (nextExecution.status) {
    case "paused":
      return "pause";
    case "halted":
      return "halt";
    case "completed":
      return "completion";
    case "aborted":
      return "abort";
    case "pending":
    case "running":
      return null;
    default:
      return assertNever(nextExecution.status);
  }
}

function projectBoundaryPendingActions(
  boundaryKind: GraphWorkflowBoundaryKind,
  contextId: string | null,
  execution: GraphWorkflowExecution,
): Array<Record<string, unknown>> {
  switch (boundaryKind) {
    case "definition_approval":
      return [{ kind: "approve_definition" }];
    case "context_approval":
      return [{ kind: "resolve_context_approval", contextId }];
    case "lane_question":
      return [{ kind: "answer_lane_question", contextId }];
    case "pause":
    case "halt":
      return holdsExecutionLease(
        execution.status,
        execution.haltReason,
        execution.abandonment,
      )
        ? [{ kind: "resume" }]
        : [];
    case "abandon":
    case "completion":
    case "abort":
      return [];
    default:
      return assertNever(boundaryKind);
  }
}

export function createGraphWorkflowBoundaryEvent(input: {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  boundaryKind: GraphWorkflowBoundaryKind;
  contextId?: string | null;
}): GraphWorkflowBoundaryEvent {
  const contextId = input.contextId ?? null;
  const projectName = getProjectName(input.projectPath);
  return {
    type: "graph-workflow-boundary",
    projectName,
    sessionName: input.sessionName,
    executionId: input.execution.id,
    boundaryKind: input.boundaryKind,
    workflowStatus: input.execution.status,
    startedAt: input.execution.startedAt,
    completedAt: input.execution.completedAt,
    haltReason: input.execution.haltReason,
    abandonment: input.execution.abandonment,
    contextId,
    pendingActions: projectBoundaryPendingActions(
      input.boundaryKind,
      contextId,
      input.execution,
    ),
    outputProjection: projectGraphWorkflowResultOutputs({
      projectName,
      sessionName: input.sessionName,
      execution: input.execution,
    }),
  };
}

/**
 * Perform the post-commit delivery of a derived {@link GraphWorkflowEventDelivery}
 * (Design 3.2). Broadcasts each persisted row's inner SSE event through the
 * publication seam (default) or the injected test broadcaster, then dispatches
 * every push descriptor. This is the ONLY code that produces external side
 * effects for a mutation's events, and the mutation seam calls it strictly AFTER
 * the transaction commits — so the delivery cannot precede the write. The
 * live-edit observability log fires here (post-commit), never during the pure
 * derivation that builds the delivery.
 */
export function deliverGraphWorkflowEvents(
  deps: GraphWorkflowExecutionEventPublisherDeps,
  delivery: GraphWorkflowEventDelivery,
): Promise<void> {
  const send = deps.broadcast ?? defaultBroadcast;
  const events = [
    ...delivery.events.map((row) => row.event),
    ...(delivery.publications ?? []),
  ];
  for (const event of events) {
    send(event);
    if (event.type === "graph-workflow-live-edit-applied") {
      liveEditLogger.info("live_edit.applied", {
        executionId: event.executionId,
        liveRevision: event.liveRevision,
        source: event.source,
        operationCount: event.operationCount,
        affectedContextIds: event.affectedContextIds,
      });
    }
    if (event.type === "graph-workflow-lane-created") {
      laneLogger.info("lane.created", {
        executionId: event.executionId,
        laneId: event.laneId,
        kind: event.kind,
        placementSource: event.placementSource,
      });
    }
    if (event.type === "graph-workflow-lane-concurrent-admission") {
      laneLogger.info("lane.concurrent_admission", {
        executionId: event.executionId,
        laneId: event.laneId,
        batchId: event.batchId,
        memberContextIds: event.memberContextIds,
        canonicalCheckResult: event.canonicalCheckResult,
      });
    }
    if (event.type === "graph-workflow-lane-landed") {
      laneLogger.info("lane.landed", {
        executionId: event.executionId,
        laneId: event.laneId,
        contextId: event.contextId,
        ownedPathspec: event.ownedPathspec,
        commitSha: event.commitSha,
      });
    }
    if (event.type === "graph-workflow-lane-drift-halted") {
      laneLogger.error("lane.drift_halted", {
        executionId: event.executionId,
        laneId: event.laneId,
        contextId: event.contextId,
        unattributedPaths: event.unattributedPaths,
      });
    }
    if (event.type === "graph-workflow-plan-defect-halted") {
      validationLogger.warn("validation.plan_defect_halted", {
        executionId: event.executionId,
        contextId: event.contextId,
        roundSeq: event.roundSeq,
        assignmentIds: event.defects.map((defect) => defect.assignmentId),
        conflictingContracts: event.defects.map(
          (defect) => defect.conflictingContract,
        ),
      });
    }
  }
  const completionPushIndex = delivery.pushes.findIndex(
    (push) => push.kind === "workflow-completed",
  );
  const completionPush =
    completionPushIndex === -1 ? null : delivery.pushes[completionPushIndex]!;
  const resultEffects = delivery.resultEffects ?? [];
  const effectPromises = resultEffects.map(async (effect, index) => {
    const deliverResult =
      deps.deliverResultRecorded ??
      (async (input) => {
        const { getGraphWorkflowResultDeliveryService } =
          await import("./result-delivery-service");
        await getGraphWorkflowResultDeliveryService().deliverRecordedResult(
          input,
        );
      });
    await deliverResult({
      ...effect,
      completionPush: index === 0 ? completionPush : null,
    });
  });
  const dispatchRemainingPushes = (): void => {
    if (!deps.dispatchPush) return;
    for (const [index, push] of delivery.pushes.entries()) {
      if (resultEffects.length > 0 && index === completionPushIndex) continue;
      deps.dispatchPush(push);
    }
  };
  if (effectPromises.length === 0) {
    dispatchRemainingPushes();
    return Promise.resolve();
  }
  return Promise.allSettled(effectPromises).then(dispatchRemainingPushes);
}

/**
 * Pure derivation of the push-notification descriptors for an execution-update
 * diff. Returns data only — no dispatch happens here; the seam dispatches these
 * post-commit through {@link deliverGraphWorkflowEvents}.
 */
function derivePushNotifications(
  events: GraphWorkflowSSEEvent[],
  input: PublishExecutionUpdateInput,
  nextExecution: GraphWorkflowExecution,
  index: ExecutionIndex,
): GraphWorkflowPushInfo[] {
  const projectName = getProjectName(input.projectPath);
  const { sessionName } = input;
  const pushes: GraphWorkflowPushInfo[] = [];

  const hasCircuitBreaker = events.some(
    (e) => e.type === "graph-workflow-circuit-breaker",
  );

  for (const event of events) {
    if (event.type === "graph-workflow-status") {
      if (event.workflowStatus === "completed") {
        pushes.push({
          kind: "workflow-completed",
          projectName,
          sessionName,
        });
      } else if (event.workflowStatus === "halted" && !hasCircuitBreaker) {
        // Circuit-breaker events send their own, more specific push —
        // skip the generic halt push to avoid duplicate notifications.
        pushes.push({
          kind: "workflow-halted",
          projectName,
          sessionName,
        });
      }
    }

    if (event.type === "graph-workflow-circuit-breaker") {
      const contextDef = index.contextById.get(event.contextId);
      pushes.push({
        kind: "circuit-breaker",
        projectName,
        sessionName,
        contextTitle: contextDef?.title ?? event.contextId,
      });
    }

    if (
      event.type === "graph-workflow-context-status" &&
      event.status === "completed"
    ) {
      const contextDef = index.contextById.get(event.contextId);
      const completedContexts = Object.values(
        nextExecution.contextStates,
      ).filter((cs) => cs.status === "completed").length;
      const totalContexts = index.contextById.size;

      pushes.push({
        kind: "context-completed",
        projectName,
        sessionName,
        contextTitle: contextDef?.title ?? event.contextId,
        completedContexts,
        totalContexts,
      });
    }
  }

  return pushes;
}

export function createGraphWorkflowExecutionEventPublisher(
  deps: GraphWorkflowExecutionEventPublisherDeps = {},
) {
  function publishExecutionUpdate(
    input: PublishExecutionUpdateInput,
  ): GraphWorkflowEventDelivery {
    const projectName = getProjectName(input.projectPath);
    const previousExecution = input.previousExecution;
    const nextExecution = input.nextExecution;
    const nextIndex = createExecutionIndex(
      nextExecution.workingDefinition,
      nextExecution,
    );
    const events: GraphWorkflowSSEEvent[] = [];
    const boundaryKind = deriveExecutionBoundaryKind(
      previousExecution,
      nextExecution,
    );

    const nextActiveBatchIds = deriveActiveBatchIds(nextExecution);
    const previousActiveBatchIds = previousExecution
      ? deriveActiveBatchIds(previousExecution)
      : [];
    const nextActiveJoinIds = deriveActiveJoinIds(nextExecution);
    const previousActiveJoinIds = previousExecution
      ? deriveActiveJoinIds(previousExecution)
      : [];

    if (
      !previousExecution ||
      previousExecution.status !== nextExecution.status ||
      !arraysEqual(
        previousExecution.activeContextIds,
        nextExecution.activeContextIds,
      ) ||
      !arraysEqual(previousActiveBatchIds, nextActiveBatchIds) ||
      !arraysEqual(previousActiveJoinIds, nextActiveJoinIds) ||
      !haltReasonsEqual(
        previousExecution.haltReason,
        nextExecution.haltReason,
      ) ||
      !haltReasonsEqual(
        previousExecution.pendingHaltReason,
        nextExecution.pendingHaltReason,
      ) ||
      !haltReasonArraysEqual(
        previousExecution.secondaryHaltReasons,
        nextExecution.secondaryHaltReasons,
      )
    ) {
      events.push({
        type: "graph-workflow-status",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        workflowStatus: nextExecution.status,
        activeContextIds: [...nextExecution.activeContextIds],
        activeBatchIds: nextActiveBatchIds,
        activeJoinIds: nextActiveJoinIds,
        haltReason: nextExecution.haltReason,
        pendingHaltReason: nextExecution.pendingHaltReason,
        secondaryHaltReasons: [...nextExecution.secondaryHaltReasons],
      } satisfies GraphWorkflowStatusEvent);
    }

    if (
      !previousExecution ||
      !haltReasonsEqual(
        previousExecution.pendingHaltReason,
        nextExecution.pendingHaltReason,
      )
    ) {
      if (
        nextExecution.pendingHaltReason !== null ||
        previousExecution?.pendingHaltReason
      ) {
        events.push({
          type: "graph-workflow-pending-halt-reason",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          pendingHaltReason: nextExecution.pendingHaltReason,
        } satisfies GraphWorkflowPendingHaltReasonEvent);
      }
    }

    const orderedContextIds = orderContextIdsByActive(nextExecution, nextIndex);

    const newlyAssignedBatches = new Map<string, string[]>();
    const batchOrder: string[] = [];
    for (const contextId of orderedContextIds) {
      const previousContext =
        previousExecution?.contextStates[contextId] ?? null;
      const nextContext = nextExecution.contextStates[contextId];
      if (!nextContext) continue;
      const nextBatchId = nextContext.batchId;
      const previousBatchId = previousContext?.batchId ?? null;
      if (nextBatchId && nextBatchId !== previousBatchId) {
        if (!newlyAssignedBatches.has(nextBatchId)) {
          batchOrder.push(nextBatchId);
        }
        const ids = newlyAssignedBatches.get(nextBatchId) ?? [];
        ids.push(contextId);
        newlyAssignedBatches.set(nextBatchId, ids);
      }
    }
    for (const batchId of batchOrder) {
      const contextIds = newlyAssignedBatches.get(batchId);
      if (!contextIds) continue;
      events.push({
        type: "graph-workflow-batch-scheduled",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        batchId,
        contextIds,
      } satisfies GraphWorkflowBatchScheduledEvent);
    }

    for (const [laneId, nextLane] of Object.entries(
      nextExecution.executionLanes,
    )) {
      const previousLane = previousExecution?.executionLanes[laneId];
      if (previousLane) continue;
      events.push({
        type: "graph-workflow-lane-created",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        laneId: nextLane.laneId,
        kind: nextLane.kind,
        placementSource:
          nextLane.laneId === SESSION_LANE_ID ? "session" : "authored",
      } satisfies GraphWorkflowLaneCreatedEvent);
    }

    const previousActiveByLane = previousExecution
      ? activeContextIdsByAuthoredLane(previousExecution)
      : new Map<string, string[]>();
    for (const [laneId, memberContextIds] of activeContextIdsByAuthoredLane(
      nextExecution,
    )) {
      if (memberContextIds.length < 2) continue;
      const previousMembers = new Set(previousActiveByLane.get(laneId) ?? []);
      const newlyActiveContextIds = memberContextIds.filter(
        (contextId) => !previousMembers.has(contextId),
      );
      if (newlyActiveContextIds.length === 0) continue;
      const batchId =
        newlyActiveContextIds
          .map((contextId) => nextExecution.contextStates[contextId]?.batchId)
          .find(
            (candidate): candidate is string =>
              candidate !== null && candidate !== undefined,
          ) ?? null;
      events.push({
        type: "graph-workflow-lane-concurrent-admission",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        laneId,
        batchId,
        memberContextIds,
        canonicalCheckResult: "passed",
      } satisfies GraphWorkflowLaneConcurrentAdmissionEvent);
    }

    // The blob keeps one bounded settlement marker per source; the LEDGER is
    // this event stream (decision D4). Derived from the marker diff so the
    // route resolution and the event commit in the same mutation by
    // construction, and a source re-decided under an amended route-control
    // revision emits again — which is exactly the history the bounded blob
    // cannot hold.
    for (const [sourceContextId, settlement] of Object.entries(
      nextExecution.routeSettlements,
    )) {
      const previousSettlement =
        previousExecution?.routeSettlements[sourceContextId];
      if (
        previousSettlement &&
        previousSettlement.effectiveSourceContextId ===
          settlement.effectiveSourceContextId &&
        previousSettlement.captureIteration === settlement.captureIteration &&
        previousSettlement.routeControlRevision ===
          settlement.routeControlRevision
      ) {
        continue;
      }
      events.push({
        type: "graph-workflow-route-resolved",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        sourceContextId,
        effectiveSourceContextId: settlement.effectiveSourceContextId,
        edgeEvaluations: settlement.edgeEvaluations,
        captureIteration: settlement.captureIteration,
        routeControlRevision: settlement.routeControlRevision,
        activatedEdgeIds: [...settlement.activatedEdgeIds],
        inactiveEdgeIds: [...settlement.inactiveEdgeIds],
        omittedEdgeIds: [...settlement.omittedEdgeIds],
        settledAt: settlement.settledAt,
      } satisfies GraphWorkflowRouteResolvedEvent);
    }

    // Same shape as the route ledger above, for the same reason (decision D9):
    // `loopStates[group].decisions` keeps only the LATEST record per pass, so a
    // pass re-decided under an amended control revision — or a repaired exit
    // instance — would leave no trace at all if the history were not this event
    // stream. Derived from the marker diff, so the decision and its event commit
    // in the same mutation by construction.
    for (const [loopGroupId, loopState] of Object.entries(
      nextExecution.loopStates,
    )) {
      const previousDecisions =
        previousExecution?.loopStates[loopGroupId]?.decisions ?? {};
      const decisions = Object.values(loopState.decisions).sort(
        (left, right) => left.pass - right.pass,
      );
      for (const decision of decisions) {
        const previousDecision = previousDecisions[String(decision.pass)];
        if (
          previousDecision &&
          previousDecision.loopControlRevision ===
            decision.loopControlRevision &&
          previousDecision.templateVersion === decision.templateVersion &&
          previousDecision.exitContextId === decision.exitContextId &&
          previousDecision.exitCaptureIteration ===
            decision.exitCaptureIteration
        ) {
          continue;
        }
        events.push({
          type: "graph-workflow-loop-decision",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          loopGroupId,
          pass: decision.pass,
          loopControlRevision: decision.loopControlRevision,
          templateVersion: decision.templateVersion,
          exitContextId: decision.exitContextId,
          exitCaptureIteration: decision.exitCaptureIteration,
          verdict: decision.verdict,
          outcome: decision.outcome,
          nextPass: decision.nextPass,
          decidedAt: decision.decidedAt,
        } satisfies GraphWorkflowLoopDecisionEvent);
      }
    }

    for (const context of nextIndex.contextById.values()) {
      const previousContext =
        previousExecution?.contextStates[context.id] ?? null;
      const nextContext = nextExecution.contextStates[context.id];
      if (!nextContext) {
        continue;
      }

      // A skip is a routing decision, so it gets its own event carrying the
      // verdicts — the status event above says only that the context reached
      // `skipped`. Fired on the ENTRY diff and never again: `skipped` is
      // terminal, so a later commit touching the settled context re-publishes
      // nothing (D4 R4.3).
      if (
        previousContext?.status !== "skipped" &&
        nextContext.status === "skipped" &&
        nextContext.skipReason
      ) {
        events.push({
          type: "graph-workflow-context-skipped",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: context.id,
          edgeEvaluations: nextContext.skipReason.edgeEvaluations.map(
            (evaluation) => ({ ...evaluation }),
          ),
          skippedAt: nextContext.skipReason.at,
        } satisfies GraphWorkflowContextSkippedEvent);
      }

      if (
        !previousContext ||
        previousContext.status !== nextContext.status ||
        previousContext.completedTaskCount !== nextContext.completedTaskCount ||
        previousContext.iterationCount !== nextContext.iterationCount
      ) {
        events.push({
          type: "graph-workflow-context-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: context.id,
          status: nextContext.status,
          remainingTaskCount:
            nextContext.totalTaskCount - nextContext.completedTaskCount,
          iterationCount: nextContext.iterationCount,
        });
      }

      const previousLanding = previousContext?.landingIntent;
      const nextLanding = nextContext.landingIntent;
      if (
        nextLanding?.mode === "lane_commit" &&
        nextLanding.state === "landed" &&
        nextLanding.laneId !== null &&
        previousLanding?.state !== "landed"
      ) {
        events.push({
          type: "graph-workflow-lane-landed",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          laneId: nextLanding.laneId,
          contextId: context.id,
          ownedPathspec:
            context.placement.mode === "owned"
              ? [...context.placement.ownedPaths]
              : null,
          commitSha: nextLanding.headSha,
          landedAt: nextLanding.settledAt ?? getNow(deps),
        } satisfies GraphWorkflowLaneLandedEvent);
      }
    }

    for (const task of nextIndex.taskById.values()) {
      const previousTask = previousExecution?.taskStates[task.id] ?? null;
      const nextTask = nextExecution.taskStates[task.id];
      if (!nextTask) {
        continue;
      }

      if (
        !previousTask ||
        previousTask.status !== nextTask.status ||
        previousTask.order !== nextTask.order ||
        previousTask.contextId !== nextTask.contextId ||
        previousTask.lastConversationId !== nextTask.lastConversationId ||
        previousTask.startedAt !== nextTask.startedAt ||
        previousTask.completedAt !== nextTask.completedAt ||
        previousTask.summary !== nextTask.summary ||
        previousTask.failureMessage !== nextTask.failureMessage
      ) {
        events.push({
          type: "graph-workflow-task-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          taskId: task.id,
          contextId: nextTask.contextId,
          status: nextTask.status,
          source: getTaskSource(nextIndex, task.id) ?? "user",
          order: nextTask.order,
          lastConversationId: nextTask.lastConversationId,
          startedAt: nextTask.startedAt,
          completedAt: nextTask.completedAt,
          summary: nextTask.summary,
          failureMessage: nextTask.failureMessage,
        });
      }
    }

    const haltReason = nextExecution.haltReason;
    if (haltReason?.type === "circuit_breaker") {
      const previousHaltReason = previousExecution?.haltReason;
      if (
        previousHaltReason?.type !== "circuit_breaker" ||
        previousHaltReason.contextId !== haltReason.contextId ||
        previousHaltReason.failureCount !== haltReason.failureCount
      ) {
        events.push({
          type: "graph-workflow-circuit-breaker",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: haltReason.contextId,
          condition: haltReason.condition,
          failureCount:
            haltReason.failureCount ??
            nextExecution.contextStates[haltReason.contextId]
              ?.consecutiveFailureCount ??
            0,
          summary: haltReason.summary ?? null,
        } satisfies GraphWorkflowCircuitBreakerEvent);
      }
    }

    const previousPlanDefects = planDefectReasons(previousExecution);
    for (const reason of planDefectReasons(nextExecution)) {
      if (
        previousPlanDefects.some((previousReason) =>
          haltReasonsEqual(previousReason, reason),
        )
      ) {
        continue;
      }
      events.push({
        type: "graph-workflow-plan-defect-halted",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        contextId: reason.contextId,
        roundSeq: reason.roundSeq,
        defects: reason.planDefects.map((defect) => ({
          assignmentId: defect.assignmentId,
          title: defect.title,
          conflictingContract: defect.conflictingContract,
        })),
      } satisfies GraphWorkflowPlanDefectHaltedEvent);
    }

    const previousOwnershipViolations =
      ownershipViolationReasons(previousExecution);
    for (const reason of ownershipViolationReasons(nextExecution)) {
      if (
        previousOwnershipViolations.some((previousReason) =>
          haltReasonsEqual(previousReason, reason),
        )
      ) {
        continue;
      }
      events.push({
        type: "graph-workflow-lane-drift-halted",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        laneId: reason.laneId,
        contextId: reason.contextId,
        unattributedPaths: [...reason.unattributedPaths],
      } satisfies GraphWorkflowLaneDriftHaltedEvent);
    }

    for (const contextId of orderedContextIds) {
      const previousContext =
        previousExecution?.contextStates[contextId] ?? null;
      const nextContext = nextExecution.contextStates[contextId];
      if (!nextContext) continue;

      if (mergeFieldsChanged(previousContext, nextContext)) {
        events.push({
          type: "graph-workflow-merge-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId,
          branchName: nextContext.branchName,
          mergeStatus: nextContext.mergeStatus,
          cleanupStatus: nextContext.cleanupStatus,
          lastMergeError: nextContext.lastMergeError,
        } satisfies GraphWorkflowMergeStatusEvent);
      }
    }

    for (const [laneId, nextLane] of Object.entries(
      nextExecution.executionLanes,
    )) {
      const previousLane = previousExecution?.executionLanes[laneId];
      if (laneFieldsChanged(previousLane, nextLane)) {
        events.push({
          type: "graph-workflow-lane-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          laneId: nextLane.laneId,
          kind: nextLane.kind,
          status: nextLane.status,
          branchName: nextLane.branchName,
          worktreePath: nextLane.worktreePath,
          includedContextIds: [...nextLane.includedContextIds],
          lastCommittingContextId: nextLane.lastCommittingContextId,
        } satisfies GraphWorkflowLaneStatusEvent);
      }

      const previousSnapshots = new Set(
        (previousLane?.commitSnapshots ?? []).map(
          (snapshot) =>
            `${snapshot.contextId}\0${snapshot.sha}\0${snapshot.committedAt}`,
        ),
      );
      for (const snapshot of nextLane.commitSnapshots) {
        const snapshotKey = `${snapshot.contextId}\0${snapshot.sha}\0${snapshot.committedAt}`;
        if (previousSnapshots.has(snapshotKey)) continue;
        events.push({
          type: "graph-workflow-lane-commit",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: snapshot.contextId,
          laneId: nextLane.laneId,
          sha: snapshot.sha,
          committedAt: snapshot.committedAt,
        } satisfies GraphWorkflowLaneCommitEvent);
      }
    }

    for (const [joinId, nextJoin] of Object.entries(
      nextExecution.joins ?? {},
    )) {
      const previousJoin = previousExecution?.joins?.[joinId];
      if (!joinFieldsChanged(previousJoin, nextJoin)) continue;
      events.push({
        type: "graph-workflow-join-status",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        joinId: nextJoin.joinId,
        kind: nextJoin.kind,
        contextId: nextJoin.contextId,
        status: nextJoin.status,
        sourceLaneIds: [...nextJoin.sourceLaneIds],
        mergedSourceLaneIds: [...nextJoin.mergedSourceLaneIds],
        targetLaneId: nextJoin.targetLaneId,
        errorMessage: nextJoin.errorMessage,
        conflicts: nextJoin.conflicts,
        ...(nextJoin.resolvedConflicts !== undefined
          ? { resolvedConflicts: nextJoin.resolvedConflicts }
          : {}),
      } satisfies GraphWorkflowJoinStatusEvent);
    }

    if (
      !previousExecution ||
      JSON.stringify(previousExecution.sharedDocuments) !==
        JSON.stringify(nextExecution.sharedDocuments)
    ) {
      events.push({
        type: "graph-workflow-shared-documents-updated",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        documents: nextExecution.sharedDocuments,
      } satisfies GraphWorkflowSharedDocumentsUpdatedEvent);
    }

    if (boundaryKind !== null) {
      events.push(
        createGraphWorkflowBoundaryEvent({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: nextExecution,
          boundaryKind,
        }),
      );
    }

    const occurredAt = getNow(deps);
    return {
      events: buildEvents(occurredAt, events),
      pushes: derivePushNotifications(events, input, nextExecution, nextIndex),
    };
  }

  function publishValidationResult(
    input: PublishValidationResultInput,
  ): GraphWorkflowEventDelivery {
    const currentRound =
      input.execution.contextStates[input.contextId]?.validationRound;
    const reviewedRound =
      input.round && currentRound?.seq === input.round.seq
        ? currentRound
        : undefined;
    const event: GraphWorkflowValidationResultEvent = {
      type: "graph-workflow-validation-result",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      validatorType: input.validatorType,
      kind: input.kind ?? "context_validation",
      pass: input.pass,
      summary: input.summary,
      issues: [...(input.issues ?? [])],
      reopenTaskIds: input.reopenTaskIds ?? [],
      rejectedOutput: input.rejectedOutput ?? null,
      gateRepairAttempts: input.gateRepair?.attempts ?? null,
      gateRepairBudget: input.gateRepair?.maxAttempts ?? null,
      rejectedAgainstSchema: input.rejectedAgainstSchema ?? null,
      sessionRef: input.sessionRef ?? null,
      reviewArtifact: input.reviewArtifact ?? null,
      // Present only for a result a round produced. A publication with no round
      // — the structured-output gate's rejection above all — keeps the exact
      // field set it had before cohorts existed (D12).
      ...(input.round !== undefined
        ? {
            roundSeq: input.round.seq,
            specialists: [...input.round.specialists],
            ...(reviewedRound
              ? { reviewedCandidate: structuredClone(reviewedRound.candidate) }
              : {}),
            ...(reviewedRound?.outputCandidate
              ? {
                  reviewedOutput: structuredClone(
                    reviewedRound.outputCandidate.value,
                  ),
                }
              : {}),
          }
        : {}),
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishValidationSpecialistResult(
    input: PublishValidationSpecialistResultInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowValidationSpecialistResultEvent = {
      type: "graph-workflow-validation-specialist-result",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      roundSeq: input.roundSeq,
      specialist: input.specialist,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishValidationIncident(
    input: PublishValidationIncidentInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowValidationIncidentEvent = {
      type: "graph-workflow-validation-incident",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      incident: input.incident,
      roundSeq: input.roundSeq,
      stage: input.stage,
      assignmentId: input.assignmentId ?? null,
      attempts: input.attempts ?? 0,
      driftedComponents: input.driftedComponents,
      message: input.message,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishApprovalPending(
    input: PublishApprovalPendingInput,
  ): GraphWorkflowEventDelivery {
    const projectName = getProjectName(input.projectPath);
    const index = createExecutionIndex(
      input.execution.workingDefinition,
      input.execution,
    );
    const contextTitle = index.contextById.get(input.contextId)?.title ?? null;

    const event: GraphWorkflowApprovalPendingEvent = {
      type: "graph-workflow-approval-pending",
      projectName,
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      contextTitle,
      conversationId: input.conversationId,
      requestedAt: input.requestedAt,
    };

    return {
      events: buildEvents(getNow(deps), [
        event,
        createGraphWorkflowBoundaryEvent({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: input.execution,
          boundaryKind: "context_approval",
          contextId: input.contextId,
        }),
      ]),
      pushes: [
        {
          kind: "approval-pending",
          projectName,
          sessionName: input.sessionName,
          contextTitle: contextTitle ?? input.contextId,
        },
      ],
    };
  }

  function publishApprovalResolved(
    input: PublishApprovalResolvedInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowApprovalResolvedEvent = {
      type: "graph-workflow-approval-resolved",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      decision: input.decision,
      message: input.message,
      decidedAt: input.decidedAt,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishUserInputPending(
    input: PublishUserInputPendingInput,
  ): GraphWorkflowEventDelivery {
    const projectName = getProjectName(input.projectPath);
    const index = createExecutionIndex(
      input.execution.workingDefinition,
      input.execution,
    );
    const contextTitle = index.contextById.get(input.contextId)?.title ?? null;

    const event: GraphWorkflowUserInputPendingEvent = {
      type: "graph-workflow-user-input-pending",
      projectName,
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      contextTitle,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      requestedAt: input.requestedAt,
    };

    // No push here: the existing conversation ask-registration flow already
    // notifies the operator when the question batch registers (Req 2.4).
    return {
      events: buildEvents(getNow(deps), [
        event,
        createGraphWorkflowBoundaryEvent({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: input.execution,
          boundaryKind: "lane_question",
          contextId: input.contextId,
        }),
      ]),
      pushes: [],
    };
  }

  function publishUserInputResolved(
    input: PublishUserInputResolvedInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowUserInputResolvedEvent = {
      type: "graph-workflow-user-input-resolved",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      conversationId: input.conversationId,
      questionBatchId: input.questionBatchId,
      resolution: input.resolution,
      resolvedAt: input.resolvedAt,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishCharterRegistered(
    input: PublishCharterRegisteredInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowCharterRegisteredEvent = {
      type: "graph-workflow-charter-registered",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      definitionId: input.definitionId,
      definitionRevision: input.definitionRevision,
      charterHash: input.charterHash,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  function publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowCharterUpdatedEvent = {
      type: "graph-workflow-charter-updated",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution?.id ?? null,
      definitionId: input.definitionId,
      definitionRevision: input.definitionRevision,
      charterHash: input.charterHash,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  /**
   * Derive the mandatory live-edit event as an appendable row (doc 06, D16) —
   * the sole wire signal for a live edit that changes only config or future
   * structure and so produces no status/diff event. Pure: no logging, no
   * broadcast. The repository's extra-events path appends the returned rows to
   * `graph_workflow_events`; the mutation seam broadcasts them (and emits the
   * `live_edit.applied` observability log) post-commit via
   * {@link deliverGraphWorkflowEvents}.
   */
  function publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowLiveEditAppliedEvent = {
      type: "graph-workflow-live-edit-applied",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.executionId,
      liveRevision: input.liveRevision,
      operationCount: input.operationCount,
      affectedContextIds: input.affectedContextIds,
      source: input.source,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  /**
   * The audited amendment of a launched delivery-plan execution (design §11).
   * Appended in the SAME mutation as the working-definition change, so a
   * definition that no longer hashes to its approved candidate can never exist
   * without the row that explains it (`audited-transitions`).
   */
  function publishExecutionAmended(
    input: PublishExecutionAmendedInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowExecutionAmendedEvent = {
      type: "graph-workflow-execution-amended",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.executionId,
      liveRevision: input.liveRevision,
      reason: input.reason,
      actor: input.actor,
      policyBasis: input.policyBasis,
      previousWorkingDefinitionHash: input.previousWorkingDefinitionHash,
      workingDefinitionHash: input.workingDefinitionHash,
      addedContextIds: input.addedContextIds,
      addedTaskIds: input.addedTaskIds,
      addedEdgeIds: input.addedEdgeIds,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  /**
   * One runtime graph-expansion attempt (D4 R6). Pure derivation like every
   * other publisher here: an ACCEPTED expansion returns rows the accepting
   * mutation commits alongside the graph change, so the receipt and the change
   * are atomic; a REFUSED one has no mutation to ride, so its caller delivers
   * the row directly. No push — expansion is engine-internal progress, not
   * something the operator is asked to act on.
   */
  function publishGraphExpansion(
    input: PublishGraphExpansionInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowGraphExpandedEvent = {
      type: "graph-workflow-graph-expanded",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.executionId,
      invokerContextId: input.invokerContextId,
      requestId: input.requestId,
      outcome: input.outcome,
      addedContextIds: input.addedContextIds,
      addedTaskIds: input.addedTaskIds,
      rejoinContextIds: input.rejoinContextIds,
      refusalCode: input.refusalCode,
      occurredAt: input.occurredAt,
    };

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes: [],
    };
  }

  /**
   * One plan-repair round lifecycle step (docs/design/cc-cli/08). Two outcomes
   * are audit-only and never push: a superseded round (the user is already
   * acting on the execution) and an opening one (`started`) — the run has not
   * changed hands, and a push per round would announce an automatic mechanism
   * doing exactly what it is meant to.
   */
  function publishPlanRepairRound(
    input: PublishPlanRepairInput,
  ): GraphWorkflowEventDelivery {
    const event: GraphWorkflowPlanRepairEvent = {
      type: "graph-workflow-plan-repair",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.executionId,
      contextId: input.contextId,
      haltType: input.haltType,
      loopGroupId: input.loopGroupId,
      attempt: input.attempt,
      outcome: input.outcome,
      planningDefect: input.planningDefect,
      diagnosis: input.diagnosis,
      operationCount: input.operationCount,
      resumed: input.resumed,
      conversationId: input.conversationId,
    };

    const pushes: GraphWorkflowPushInfo[] =
      input.outcome === "superseded" || input.outcome === "started"
        ? []
        : [
            {
              kind: "plan-repair",
              projectName: event.projectName,
              sessionName: input.sessionName,
              contextTitle: input.contextId,
              planRepairOutcome: input.outcome,
              planRepairAttempt: input.attempt,
              planRepairDiagnosis: input.diagnosis,
            },
          ];

    return {
      events: buildEvents(getNow(deps), [event]),
      pushes,
    };
  }

  /**
   * Perform a derived delivery's external side effects (SSE broadcast + push
   * dispatch) using this publisher's deps. The mutation seam calls this only
   * after the mutation's transaction has committed; the rare standalone caller
   * that publishes post-commit (e.g. the user-input gate) calls it directly.
   */
  function deliver(delivery: GraphWorkflowEventDelivery): Promise<void> {
    return deliverGraphWorkflowEvents(deps, delivery);
  }

  return {
    publishExecutionUpdate,
    publishValidationResult,
    publishValidationSpecialistResult,
    publishValidationIncident,
    publishApprovalPending,
    publishApprovalResolved,
    publishUserInputPending,
    publishUserInputResolved,
    publishCharterRegistered,
    publishCharterUpdated,
    publishLiveEditApplied,
    publishExecutionAmended,
    publishGraphExpansion,
    publishPlanRepairRound,
    deliver,
  };
}
