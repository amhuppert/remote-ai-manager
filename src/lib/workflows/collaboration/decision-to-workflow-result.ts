/**
 * Pure translator that maps a terminal `CollaborationPolicyDecision` to a
 * structured `WorkflowCollaborationResult`.
 *
 * Mapping table — single source of truth, per research.md §10.1:
 *
 *   final                                       → converged
 *   ask_user / objective_disagreement           → objective_disagreement
 *   ask_user / rounds_exhausted_above_threshold → rounds_exhausted
 *   ask_user / threshold_none_with_remaining    → requires_user_input
 *   ask_user / explicit_ask_user                → requires_user_input
 *   fail                                        → requires_user_input
 *   continue_negotiation                        → (not terminal — throws)
 *
 * `fail` and `explicit_ask_user` collapse to `requires_user_input` because
 * the agent-invoked flow has no actionable distinction between "agent asked
 * to pause" and "agent chose to fail" — both signal non-autonomous
 * convergence and require operator follow-up.
 */

import {
  workflowCollaborationResultSchema,
  type WorkflowCollaborationOpenConflict,
  type WorkflowCollaborationResult,
  type WorkflowCollaborationStatus,
} from "@/lib/workflows/schemas";
import type { CollaborationPolicyDecision } from "./policy";

export interface DecisionToWorkflowResultInput {
  decision: CollaborationPolicyDecision;
  finalAnswer: string | null;
  openConflicts: ReadonlyArray<WorkflowCollaborationOpenConflict>;
}

export function decisionToWorkflowResult(
  input: DecisionToWorkflowResultInput,
): WorkflowCollaborationResult {
  const status = mapDecisionToStatus(input.decision);
  return workflowCollaborationResultSchema.parse({
    status,
    finalAnswer: input.finalAnswer,
    openConflicts: [...input.openConflicts],
  });
}

function mapDecisionToStatus(
  decision: CollaborationPolicyDecision,
): WorkflowCollaborationStatus {
  switch (decision.kind) {
    case "final":
      return "converged";
    case "ask_user":
      switch (decision.reason) {
        case "objective_disagreement":
          return "objective_disagreement";
        case "rounds_exhausted_above_threshold":
          return "rounds_exhausted";
        case "threshold_none_with_remaining":
        case "explicit_ask_user":
          return "requires_user_input";
      }
      // Defensive: TS exhaustiveness ensures every reason is handled above.
      return assertUnreachable(
        decision.reason as never,
        "unreachable ask_user reason",
      );
    case "fail":
      return "requires_user_input";
    case "continue_negotiation":
      throw new Error(
        "decisionToWorkflowResult was given continue_negotiation, which is non-terminal and must be resolved by the envelope before translation",
      );
  }
}

function assertUnreachable(_value: never, message: string): never {
  throw new Error(message);
}
