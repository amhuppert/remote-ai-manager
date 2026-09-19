/**
 * Reset one validator's pending review while preserving its conversation and
 * sibling verdicts. A frozen round keeps its roster: removing the seat would
 * let the remaining validators conclude without the reviewer being retried.
 *
 * This reducer runs inside the write queue. Question withdrawal is returned as
 * data for the caller to publish after commit.
 */

import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import { releaseParkedContext } from "@/lib/workflow-graph/user-input-gate";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";

export class ResetAssignmentError extends Error {
  constructor(
    readonly code:
      | "invalid_execution_status"
      | "context_missing"
      | "assignment_missing",
    message: string,
  ) {
    super(message);
    this.name = "ResetAssignmentError";
  }
}

const RESET_ELIGIBLE_STATUSES: ReadonlySet<GraphWorkflowExecution["status"]> =
  new Set(["paused", "halted"]);

export interface ResetAssignmentResult {
  execution: GraphWorkflowExecution;
  /** The parked question invalidated by restarting this review. */
  withdrawnQuestion: { conversationId: string; questionBatchId: string } | null;
}

function freshSpecialist(): GraphWorkflowValidationSpecialist {
  return {
    state: "pending",
    attempts: 0,
    summary: null,
    issues: [],
    advisories: [],
    questionToken: null,
    sessionRef: null,
    reviewArtifact: null,
    lastInfraFailure: null,
  };
}

export function resetExecutionContextAssignment(
  execution: GraphWorkflowExecution,
  input: { contextId: string; assignmentId: string },
): ResetAssignmentResult {
  const { contextId, assignmentId } = input;

  if (!RESET_ELIGIBLE_STATUSES.has(execution.status)) {
    throw new ResetAssignmentError(
      "invalid_execution_status",
      `Resetting a validator assignment is only allowed when the workflow is paused or halted (current status: ${execution.status}).`,
    );
  }

  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new ResetAssignmentError(
      "context_missing",
      `Execution context "${contextId}" not found.`,
    );
  }

  // A dormant member of a disabled cohort is still configuration to reset; the
  // whole authored cohort is searched rather than only the runnable selection.
  const configured = context.contextValidator.assignments.some(
    (assignment) => assignment.id === assignmentId,
  );
  if (!configured) {
    throw new ResetAssignmentError(
      "assignment_missing",
      `Validator assignment "${assignmentId}" is not configured on execution context "${contextId}".`,
    );
  }

  const next = structuredClone(execution);
  const laneKey = laneStateKey("context_validator", assignmentId);

  let withdrawnQuestion: ResetAssignmentResult["withdrawnQuestion"] = null;
  const contextState = next.contextStates[contextId];
  if (contextState) {
    const parked = contextState.pendingUserInputs[laneKey];
    if (parked) {
      withdrawnQuestion = {
        conversationId: parked.conversationId,
        questionBatchId: parked.questionBatchId,
      };
      delete contextState.pendingUserInputs[laneKey];
      // Only when no sibling lane is still waiting — a cohort parks per lane.
      releaseParkedContext(
        next,
        contextId,
        "ready",
        "reset_assignment.withdrew_question",
      );
    }

    const round = contextState.validationRound;
    if (
      round &&
      round.phase !== "concluded" &&
      round.roster.some((seat) => seat.assignmentId === assignmentId)
    ) {
      round.specialists[assignmentId] = freshSpecialist();
    }
  }

  return { execution: next, withdrawnQuestion };
}
