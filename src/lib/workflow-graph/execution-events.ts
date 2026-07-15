import path from "node:path";
import { createLogger } from "@/lib/logging";
import { assertNever } from "@/lib/shared/assert-never";
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
  GraphWorkflowExecutionEvent,
  GraphWorkflowJoinStatusEvent,
  GraphWorkflowLaneStatusEvent,
  GraphWorkflowLiveEditAppliedEvent,
  GraphWorkflowMergeStatusEvent,
  GraphWorkflowPendingHaltReasonEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowStatusEvent,
  GraphWorkflowUserInputPendingEvent,
  GraphWorkflowUserInputResolvedEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationEventSessionRef,
  GraphWorkflowValidationReviewArtifact,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowValidatorType,
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";

const logger = createLogger("workflow.live-edit");

function defaultBroadcast(event: GraphWorkflowSSEEvent): void {
  publishEvent(event);
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
  pass: boolean;
  summary: string;
  issues?: WorkflowValidatorIssue[];
  reopenTaskIds?: string[];
  sessionRef?: GraphWorkflowValidationEventSessionRef | null;
  reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
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

interface PublishCharterUpdatedInput {
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

interface GraphWorkflowPushInfo {
  kind:
    | "workflow-completed"
    | "workflow-halted"
    | "circuit-breaker"
    | "context-completed"
    | "approval-pending";
  projectName: string;
  sessionName: string;
  contextTitle?: string;
  completedContexts?: number;
  totalContexts?: number;
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

function publishEvents(
  deps: GraphWorkflowExecutionEventPublisherDeps,
  events: GraphWorkflowSSEEvent[],
): void {
  const send = deps.broadcast ?? defaultBroadcast;
  for (const event of events) {
    send(event);
  }
}

function dispatchPushNotifications(
  deps: GraphWorkflowExecutionEventPublisherDeps,
  events: GraphWorkflowSSEEvent[],
  input: PublishExecutionUpdateInput,
  nextExecution: GraphWorkflowExecution,
  index: ExecutionIndex,
): void {
  if (!deps.dispatchPush) return;

  const projectName = getProjectName(input.projectPath);
  const { sessionName } = input;

  const hasCircuitBreaker = events.some(
    (e) => e.type === "graph-workflow-circuit-breaker",
  );

  for (const event of events) {
    if (event.type === "graph-workflow-status") {
      if (event.workflowStatus === "completed") {
        deps.dispatchPush({
          kind: "workflow-completed",
          projectName,
          sessionName,
        });
      } else if (event.workflowStatus === "halted" && !hasCircuitBreaker) {
        // Circuit-breaker events send their own, more specific push —
        // skip the generic halt push to avoid duplicate notifications.
        deps.dispatchPush({
          kind: "workflow-halted",
          projectName,
          sessionName,
        });
      }
    }

    if (event.type === "graph-workflow-circuit-breaker") {
      const contextDef = index.contextById.get(event.contextId);
      deps.dispatchPush({
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

      deps.dispatchPush({
        kind: "context-completed",
        projectName,
        sessionName,
        contextTitle: contextDef?.title ?? event.contextId,
        completedContexts,
        totalContexts,
      });
    }
  }
}

export function createGraphWorkflowExecutionEventPublisher(
  deps: GraphWorkflowExecutionEventPublisherDeps = {},
) {
  function publishExecutionUpdate(
    input: PublishExecutionUpdateInput,
  ): GraphWorkflowExecutionEvent[] {
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

    for (const context of nextIndex.contextById.values()) {
      const previousContext =
        previousExecution?.contextStates[context.id] ?? null;
      const nextContext = nextExecution.contextStates[context.id];
      if (!nextContext) {
        continue;
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
      if (!laneFieldsChanged(previousLane, nextLane)) continue;
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
    publishEvents(deps, events);
    dispatchPushNotifications(deps, events, input, nextExecution, nextIndex);
    return buildEvents(occurredAt, events);
  }

  function publishValidationResult(
    input: PublishValidationResultInput,
  ): GraphWorkflowExecutionEvent[] {
    const event: GraphWorkflowValidationResultEvent = {
      type: "graph-workflow-validation-result",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      validatorType: input.validatorType,
      pass: input.pass,
      summary: input.summary,
      issues: input.issues ?? [],
      reopenTaskIds: input.reopenTaskIds ?? [],
      sessionRef: input.sessionRef ?? null,
      reviewArtifact: input.reviewArtifact ?? null,
    };

    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  function publishApprovalPending(
    input: PublishApprovalPendingInput,
  ): GraphWorkflowExecutionEvent[] {
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

    publishEvents(deps, [event]);
    deps.dispatchPush?.({
      kind: "approval-pending",
      projectName,
      sessionName: input.sessionName,
      contextTitle: contextTitle ?? input.contextId,
    });
    return buildEvents(getNow(deps), [event]);
  }

  function publishApprovalResolved(
    input: PublishApprovalResolvedInput,
  ): GraphWorkflowExecutionEvent[] {
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

    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  function publishUserInputPending(
    input: PublishUserInputPendingInput,
  ): GraphWorkflowExecutionEvent[] {
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
    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  function publishUserInputResolved(
    input: PublishUserInputResolvedInput,
  ): GraphWorkflowExecutionEvent[] {
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

    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  function publishCharterRegistered(
    input: PublishCharterRegisteredInput,
  ): GraphWorkflowExecutionEvent[] {
    const event: GraphWorkflowCharterRegisteredEvent = {
      type: "graph-workflow-charter-registered",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      definitionId: input.definitionId,
      definitionRevision: input.definitionRevision,
      charterHash: input.charterHash,
    };

    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  function publishCharterUpdated(
    input: PublishCharterUpdatedInput,
  ): GraphWorkflowExecutionEvent[] {
    const event: GraphWorkflowCharterUpdatedEvent = {
      type: "graph-workflow-charter-updated",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution?.id ?? null,
      definitionId: input.definitionId,
      definitionRevision: input.definitionRevision,
      charterHash: input.charterHash,
    };

    publishEvents(deps, [event]);
    return buildEvents(getNow(deps), [event]);
  }

  /**
   * Broadcast the mandatory live-edit event AND return it as an appendable row
   * (doc 06, D16). A live edit may change only config or future structure and
   * so produce no status/diff event; broadcasting here is the sole wire signal.
   * The repository's extra-events path only appends returned rows to
   * `graph_workflow_events` — it never broadcasts — so the route calls this and
   * includes the returned rows in the mutation's events (broadcast + persisted).
   */
  function publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowExecutionEvent[] {
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

    publishEvents(deps, [event]);
    logger.info("live_edit.applied", {
      executionId: input.executionId,
      liveRevision: input.liveRevision,
      source: input.source,
      operationCount: input.operationCount,
      affectedContextIds: input.affectedContextIds,
    });
    return buildEvents(getNow(deps), [event]);
  }

  return {
    publishExecutionUpdate,
    publishValidationResult,
    publishApprovalPending,
    publishApprovalResolved,
    publishUserInputPending,
    publishUserInputResolved,
    publishCharterRegistered,
    publishCharterUpdated,
    publishLiveEditApplied,
  };
}
