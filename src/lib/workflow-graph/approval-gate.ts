import { refused, type ExecutionMutationOutcome } from "./execution-mutation";
import type { ExecutionMutationDecision } from "@/lib/workflow-graph/execution-mutation";
import { changed } from "@/lib/workflow-graph/execution-mutation";
import { createLogger } from "@/lib/logging";
import { transitionContextStatus } from "@/lib/workflow-graph/context-transitions";
import type {
  GraphWorkflowApprovalDecision,
  GraphWorkflowApprovalScope,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowTaskDefinition } from "@/lib/workflow-graph/definition-schemas";
import { holdsActionableGate } from "@/lib/workflow-graph/lifecycle-classifier";

const logger = createLogger("workflow-graph.approval-gate");

const NO_ACTIVE_EXECUTION_MESSAGE =
  "Session does not have an active graph workflow execution";

export interface ApprovalGateServiceDeps {
  mutateActive<Value = void, Refusal = never>(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => ExecutionMutationDecision<Value, Refusal>,
  ): Promise<ExecutionMutationOutcome<Value, Refusal>>;
  now(): string;
}

export type ApprovalGateDecisionInput =
  | { type: "approved" }
  | { type: "rejected"; message: string };

export type RecordDecisionGuardFailureReason =
  | "no_active_execution"
  | "not_awaiting_approval"
  | "already_decided"
  | "execution_not_running";

export type RecordDecisionResult =
  | { ok: true; execution: GraphWorkflowExecution }
  | { ok: false; reason: RecordDecisionGuardFailureReason };

/**
 * The observability payload of an applied approval decision. `applyApprovedDecision`
 * and `applyRejectedDecision` run INSIDE a `mutateActive` reducer (the write-queue
 * critical section), so they are pure — they return this inert DATA instead of
 * logging. The caller emits `gate.applied` AFTER the mutation commits
 * (`no-slow-work-in-critical-section`).
 */
export type AppliedApprovalDecision =
  | { decisionType: "approved" }
  | {
      decisionType: "rejected";
      remediationTaskId: string;
      rejectionMessageLength: number;
    };

/**
 * The observability payload of parking a context for human approval.
 * `enterAwaitingApproval` runs inside a `mutateActive` reducer, so it returns
 * this DATA and the caller emits `gate.pending` post-commit.
 */
export interface EnteredAwaitingApproval {
  conversationId: string;
  requestedAt: string;
}

export interface RecordDecisionInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  decision: ApprovalGateDecisionInput;
}

export interface ApprovalGateService {
  /**
   * Draft-level: mutates the execution inside the caller's active
   * `mutateActive` callback so the status flip and pending record land in the
   * same mutation as the caller's other writes. Pure — returns the observability
   * payload; the caller publishes the approval-pending event and logs
   * `gate.pending` after its mutation commits (`no-slow-work-in-critical-section`).
   */
  enterAwaitingApproval(
    execution: GraphWorkflowExecution,
    input: {
      contextId: string;
      conversationId: string;
      /**
       * How this gate's approval view is scoped, frozen here for the life of
       * the pending record (R15.2). Required rather than defaulted, so every
       * caller states which scope the human is deciding under instead of
       * inheriting the whole-tree view by omission — for an enveloped member
       * the whole-tree delta of a shared lane worktree is partly a sibling's
       * in-progress work.
       */
      approvalScope: GraphWorkflowApprovalScope;
    },
  ): EnteredAwaitingApproval;

  /**
   * Atomic check-and-set: all guards run inside one `mutateActive` mutation
   * (serialized via the write queue), so the first decision wins and
   * concurrent submissions observe `already_decided`.
   */
  recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult>;

  /**
   * Draft-level: clears the pending record after an approved decision.
   * Completion and merge stay with the loop's finalization path, which sets
   * the context status in the same mutation. Pure: returns the observability
   * payload; the caller logs `gate.applied` post-commit.
   */
  applyApprovedDecision(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): AppliedApprovalDecision;

  /**
   * Draft-level: clears the pending record after a rejected decision,
   * appends a remediation task carrying the operator's message, returns the
   * context to `running`, and updates the task counts. Never modifies
   * `consecutiveFailureCount` — human rejections do not count toward the
   * validation circuit breaker (requirement 5.5). Pure: returns the
   * observability payload; the caller logs `gate.applied` post-commit.
   */
  applyRejectedDecision(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): AppliedApprovalDecision;

  /**
   * Builds the remediation task delivering the operator's rejection message
   * as human-reviewer feedback. The ID is derived from contextId + rejection
   * ordinal and skips ordinals already present in `existingTaskIds`, so
   * repeated rejections never collide. The caller assigns `order` (next
   * order within the context).
   */
  buildRejectionRemediationTask(
    contextId: string,
    message: string,
    existingTaskIds: string[],
    order: number,
  ): GraphWorkflowTaskDefinition;
}

function isNoActiveExecutionError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === NO_ACTIVE_EXECUTION_MESSAGE
  );
}

/**
 * Invariant guard for decision application: the loop only calls the apply
 * methods after observing a recorded decision, so a missing record or
 * mismatched decision type is a programming error — throw, matching how
 * sibling engine code treats impossible states.
 */
function requireRecordedDecision(
  execution: GraphWorkflowExecution,
  contextId: string,
): {
  contextState: GraphWorkflowExecutionContextState;
  decision: GraphWorkflowApprovalDecision;
} {
  const contextState = execution.contextStates[contextId];
  if (!contextState) {
    throw new Error(
      `Cannot apply approval decision: unknown context "${contextId}"`,
    );
  }
  if (
    contextState.status !== "awaiting_approval" ||
    contextState.pendingApproval === null
  ) {
    throw new Error(
      `Cannot apply approval decision: context "${contextId}" is not awaiting approval`,
    );
  }
  const decision = contextState.pendingApproval.decision;
  if (decision === null) {
    throw new Error(
      `Cannot apply approval decision: context "${contextId}" has no recorded decision`,
    );
  }
  return { contextState, decision };
}

function buildRejectionRemediationInstructions(message: string): string {
  return [
    "The human reviewer rejected this context's work at the approval gate.",
    "",
    "Reviewer feedback:",
    message,
    "",
    "Address the feedback above. When you believe it is resolved, mark this task complete; every enabled validator will run again before the work returns for human review.",
  ].join("\n");
}

export function createApprovalGateService(
  deps: ApprovalGateServiceDeps,
): ApprovalGateService {
  function enterAwaitingApproval(
    execution: GraphWorkflowExecution,
    input: {
      contextId: string;
      conversationId: string;
      approvalScope: GraphWorkflowApprovalScope;
    },
  ): EnteredAwaitingApproval {
    const contextState = execution.contextStates[input.contextId];
    if (!contextState) {
      throw new Error(
        `Cannot enter awaiting approval: unknown context "${input.contextId}"`,
      );
    }

    const requestedAt = deps.now();
    transitionContextStatus(execution, input.contextId, "awaiting_approval", {
      reason: "approval_gate.enter_awaiting_approval",
    });
    contextState.pendingApproval = {
      conversationId: input.conversationId,
      requestedAt,
      decision: null,
      approvalScope: input.approvalScope,
    };

    // Pure: return the observability payload. The caller logs `gate.pending`
    // after its mutation commits (this runs inside the write-queue lock).
    return { conversationId: input.conversationId, requestedAt };
  }

  async function recordDecision(
    input: RecordDecisionInput,
  ): Promise<RecordDecisionResult> {
    let mutation: ExecutionMutationOutcome<
      void,
      RecordDecisionGuardFailureReason
    >;

    try {
      mutation = await deps.mutateActive(
        input.projectPath,
        input.sessionName,
        (draft) => {
          // A decision is recordable while the run still holds the lease.
          // `paused` and a resumable `halted` are the deferred path: the
          // decision persists and the gate wait applies it after the execution
          // resumes (requirements 7.1, 7.5). A halt that can never resume — or
          // an abandoned one — has no such future, so recording against it
          // would persist a decision nothing will ever apply.
          if (
            !holdsActionableGate(
              draft.status,
              draft.haltReason,
              draft.abandonment,
            )
          ) {
            return refused("execution_not_running");
          }

          const contextState = draft.contextStates[input.contextId];
          if (
            !contextState ||
            contextState.status !== "awaiting_approval" ||
            contextState.pendingApproval === null
          ) {
            return refused("not_awaiting_approval");
          }

          if (contextState.pendingApproval.decision !== null) {
            return refused("already_decided");
          }

          const decidedAt = deps.now();
          contextState.pendingApproval.decision =
            input.decision.type === "approved"
              ? { type: "approved", decidedAt }
              : {
                  type: "rejected",
                  message: input.decision.message,
                  decidedAt,
                };
          return changed(draft);
        },
      );
    } catch (error) {
      if (isNoActiveExecutionError(error)) {
        logger.warn("gate.decision_guard_failed", {
          sessionName: input.sessionName,
          contextId: input.contextId,
          decisionType: input.decision.type,
          reason: "no_active_execution",
        });
        return { ok: false, reason: "no_active_execution" };
      }
      throw error;
    }

    const execution = mutation.execution;
    if (mutation.kind === "refused") {
      const guardFailure = mutation.refusal;
      logger.warn("gate.decision_guard_failed", {
        executionId: execution.id,
        executionStatus: execution.status,
        sessionName: input.sessionName,
        contextId: input.contextId,
        decisionType: input.decision.type,
        reason: guardFailure,
      });
      return { ok: false, reason: guardFailure };
    }

    logger.info("gate.decision_recorded", {
      executionId: execution.id,
      executionStatus: execution.status,
      sessionName: input.sessionName,
      contextId: input.contextId,
      decisionType: input.decision.type,
      rejectionMessageLength:
        input.decision.type === "rejected"
          ? input.decision.message.length
          : null,
      deferred: execution.status !== "running",
    });
    return { ok: true, execution };
  }

  function applyApprovedDecision(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): AppliedApprovalDecision {
    const { contextState, decision } = requireRecordedDecision(
      execution,
      contextId,
    );
    if (decision.type !== "approved") {
      throw new Error(
        `Cannot apply approved decision: context "${contextId}" recorded a ${decision.type} decision`,
      );
    }

    contextState.pendingApproval = null;

    // Pure: caller logs `gate.applied` post-commit (this runs inside the lock).
    return { decisionType: "approved" };
  }

  function buildRejectionRemediationTask(
    contextId: string,
    message: string,
    existingTaskIds: string[],
    order: number,
  ): GraphWorkflowTaskDefinition {
    const takenIds = new Set(existingTaskIds);
    let ordinal = 1;
    while (takenIds.has(`task-${contextId}-rejection-${ordinal}`)) {
      ordinal += 1;
    }

    return {
      id: `task-${contextId}-rejection-${ordinal}`,
      contextId,
      order,
      title: "Address human review feedback",
      instructions: buildRejectionRemediationInstructions(message),
      source: "user",
      metadata: { origin: "human_rejection" },
    };
  }

  function applyRejectedDecision(
    execution: GraphWorkflowExecution,
    contextId: string,
  ): AppliedApprovalDecision {
    const { contextState, decision } = requireRecordedDecision(
      execution,
      contextId,
    );
    if (decision.type !== "rejected") {
      throw new Error(
        `Cannot apply rejected decision: context "${contextId}" recorded a ${decision.type} decision`,
      );
    }

    const tasks = execution.workingDefinition.tasks;
    const order =
      tasks
        .filter((task) => task.contextId === contextId)
        .reduce((currentMax, task) => Math.max(currentMax, task.order), 0) + 1;
    const remediationTask = buildRejectionRemediationTask(
      contextId,
      decision.message,
      tasks.map((task) => task.id),
      order,
    );

    contextState.pendingApproval = null;
    transitionContextStatus(execution, contextId, "running", {
      reason: "approval_gate.apply_rejected_decision",
    });

    // A captured structured output (D2) describes the work the human just
    // refused. The capture step is skipped whenever an output already exists,
    // so keeping it would let the context re-complete after remediation while
    // still carrying the pre-rejection payload. Dropping it makes the
    // remediated work satisfy the declared contract again.
    if (execution.contextOutputs[contextId] !== undefined) {
      const remaining = { ...execution.contextOutputs };
      delete remaining[contextId];
      execution.contextOutputs = remaining;
    }

    tasks.push(remediationTask);
    execution.taskStates[remediationTask.id] = {
      taskId: remediationTask.id,
      contextId,
      order,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      failureMessage: null,
      failureHistory: [],
    };
    contextState.totalTaskCount = tasks.filter(
      (task) => task.contextId === contextId,
    ).length;

    // Pure: caller logs `gate.applied` post-commit (this runs inside the lock).
    return {
      decisionType: "rejected",
      remediationTaskId: remediationTask.id,
      rejectionMessageLength: decision.message.length,
    };
  }

  return {
    enterAwaitingApproval,
    recordDecision,
    applyApprovedDecision,
    applyRejectedDecision,
    buildRejectionRemediationTask,
  };
}
