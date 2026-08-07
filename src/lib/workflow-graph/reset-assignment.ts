/**
 * Per-assignment reset (R8.1/R8.3): take ONE cohort member back to a clean
 * slate without disturbing the context around it.
 *
 * The whole-context reset drops everything — every lane, every task state, the
 * context's own status. That is the wrong instrument when one reviewer's lane
 * is wedged: it discards the sibling verdicts that judged the same candidate
 * and the implementer's work along with them. This narrows the same primitives
 * to a single assignment.
 *
 * The one rule that is easy to get wrong: an open frozen round's roster entry
 * is returned to `pending`, never removed. The roster names who owns the
 * candidate, so removing a seat would let the round conclude on the remaining
 * validators alone — an all-of decision reached without the validator the
 * operator was trying to re-run.
 *
 * Pure, like every reducer that runs inside the write queue. The two effects a
 * reset implies but cannot perform — stopping the retired lane's conversation
 * actor and publishing the parked question's withdrawal — come back as data for
 * the caller to perform post-commit.
 */

import { laneStateKey } from "@/lib/workflow-graph/lane-identity";
import { releaseParkedContext } from "@/lib/workflow-graph/user-input-gate";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";

export class ResetAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetAssignmentError";
  }
}

const RESET_ELIGIBLE_STATUSES: ReadonlySet<GraphWorkflowExecution["status"]> =
  new Set(["paused", "halted"]);

export interface ResetAssignmentResult {
  execution: GraphWorkflowExecution;
  /**
   * The lane conversation this reset retired, for the caller to stop after the
   * mutation commits. Null when the lane held no CC conversation (a
   * task-strategy validator) or had no lane state at all.
   */
  retiredConversationId: string | null;
  /**
   * The parked question the reset invalidated. The lane that asked it is gone,
   * so an answer could never reach anyone; the caller publishes the withdrawal
   * post-commit. Null when the assignment was not parked.
   */
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
      `Resetting a validator assignment is only allowed when the workflow is paused or halted (current status: ${execution.status}).`,
    );
  }

  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new ResetAssignmentError(
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
      `Validator assignment "${assignmentId}" is not configured on execution context "${contextId}".`,
    );
  }

  const next = structuredClone(execution);
  const laneKey = laneStateKey("context_validator", assignmentId);

  const contextLanes = next.laneStates[contextId];
  const laneState = contextLanes?.[laneKey];
  const retiredConversationId = laneState?.workflowConversationId ?? null;
  if (contextLanes) {
    delete contextLanes[laneKey];
  }

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

  return { execution: next, retiredConversationId, withdrawnQuestion };
}
