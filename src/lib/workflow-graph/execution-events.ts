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
  GraphWorkflowCharterRegisteredEvent,
  GraphWorkflowCharterUpdatedEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowContextSkippedEvent,
  GraphWorkflowRouteResolvedEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowJoinStatusEvent,
  GraphWorkflowLaneCommitEvent,
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

const logger = createLogger("workflow.live-edit");

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
  definitionId: string;
  definitionRevision: number;
  charterHash: string;
}

export interface PublishCharterUpdatedInput {
  projectPath: string;
  sessionName: string;
  definitionId: string;
  definitionRevision: number;
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
    JSON.stringify(previous.conflicts) !== JSON.stringify(next.conflicts)
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
): void {
  const send = deps.broadcast ?? defaultBroadcast;
  for (const row of delivery.events) {
    send(row.event);
    if (row.event.type === "graph-workflow-live-edit-applied") {
      logger.info("live_edit.applied", {
        executionId: row.event.executionId,
        liveRevision: row.event.liveRevision,
        source: row.event.source,
        operationCount: row.event.operationCount,
        affectedContextIds: row.event.affectedContextIds,
      });
    }
  }
  if (deps.dispatchPush) {
    for (const push of delivery.pushes) {
      deps.dispatchPush(push);
    }
  }
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

    const occurredAt = getNow(deps);
    return {
      events: buildEvents(occurredAt, events),
      pushes: derivePushNotifications(events, input, nextExecution, nextIndex),
    };
  }

  function publishValidationResult(
    input: PublishValidationResultInput,
  ): GraphWorkflowEventDelivery {
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
      events: buildEvents(getNow(deps), [event]),
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
      events: buildEvents(getNow(deps), [event]),
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
   * One plan-repair round conclusion (docs/design/cc-cli/08). Superseded
   * rounds are audit-only (the user is already acting on the execution), so
   * they append the event but never push.
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
      input.outcome === "superseded"
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
  function deliver(delivery: GraphWorkflowEventDelivery): void {
    deliverGraphWorkflowEvents(deps, delivery);
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
    publishGraphExpansion,
    publishPlanRepairRound,
    deliver,
  };
}
