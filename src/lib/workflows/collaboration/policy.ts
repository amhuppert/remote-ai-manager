/**
 * Asymmetric Collaboration Mode policy edges.
 *
 * `decideCollaborationNextStep` is a pure decision function the asymmetric
 * slice consults after each round to decide whether to:
 *
 *  - `final` — Agent One declared agreement (or no remaining disagreements
 *    bar the autonomous threshold) so the run can synthesize the final
 *    answer.
 *  - `continue_negotiation` — Implementation disagreements remain and
 *    negotiation rounds remain; loop into another round.
 *  - `ask_user` — Either an objective disagreement remains (these always
 *    halt regardless of threshold), the autonomous threshold rejects the
 *    remaining implementation disagreements, or rounds are exhausted with
 *    disagreements above threshold.
 *  - `fail` — Agent One explicitly chose `fail`. Surface to the user as a
 *    failed run; do not synthesize a final answer.
 *
 * Severity ordering used by the threshold check:
 *
 *   none < minor < major < blocking
 *
 * `autonomousResolutionThreshold` is the highest severity Agent One is
 * allowed to resolve autonomously. Anything strictly above the threshold
 * forces `ask_user`. With `none`, any remaining disagreement halts.
 */

import type {
  CollaborationArtifactDisagreement,
  CollaborationAutonomousResolutionThreshold,
  CollaborationDisagreementSeverity,
  CollaborationResolutionDecisionOutput,
} from "./types";

export type CollaborationPolicyDecision =
  | { kind: "final" }
  | { kind: "continue_negotiation" }
  | { kind: "ask_user"; reason: PolicyAskUserReason }
  | { kind: "fail" };

export type PolicyAskUserReason =
  | "explicit_ask_user"
  | "objective_disagreement"
  | "rounds_exhausted_above_threshold"
  | "threshold_none_with_remaining";

export interface CollaborationPolicyInput {
  decision: CollaborationResolutionDecisionOutput;
  autonomousResolutionThreshold: CollaborationAutonomousResolutionThreshold;
  /**
   * The number of remaining negotiation rounds AFTER the round whose
   * `decision` is being interpreted. When this is `0`, the slice has used up
   * its budget: continuing is no longer an option.
   */
  negotiationRoundsRemaining: number;
}

const SEVERITY_RANK: Record<CollaborationDisagreementSeverity, number> = {
  minor: 1,
  major: 2,
  blocking: 3,
};

const THRESHOLD_RANK: Record<
  CollaborationAutonomousResolutionThreshold,
  number
> = {
  none: 0,
  minor: 1,
  major: 2,
  blocking: 3,
};

function hasObjectiveDisagreement(
  disagreements: ReadonlyArray<CollaborationArtifactDisagreement>,
): boolean {
  return disagreements.some((d) => d.category === "objective");
}

function severityExceedsThreshold(
  severity: CollaborationDisagreementSeverity,
  threshold: CollaborationAutonomousResolutionThreshold,
): boolean {
  return SEVERITY_RANK[severity] > THRESHOLD_RANK[threshold];
}

function anyImplementationExceedsThreshold(
  disagreements: ReadonlyArray<CollaborationArtifactDisagreement>,
  threshold: CollaborationAutonomousResolutionThreshold,
): boolean {
  return disagreements.some(
    (d) =>
      d.category === "implementation" &&
      severityExceedsThreshold(d.severity, threshold),
  );
}

function hasImplementationDisagreement(
  disagreements: ReadonlyArray<CollaborationArtifactDisagreement>,
): boolean {
  return disagreements.some((d) => d.category === "implementation");
}

export function decideCollaborationNextStep(
  input: CollaborationPolicyInput,
): CollaborationPolicyDecision {
  const {
    decision,
    autonomousResolutionThreshold,
    negotiationRoundsRemaining,
  } = input;
  const remaining = decision.remainingDisagreements;

  if (decision.nextAction === "fail") {
    return { kind: "fail" };
  }

  if (hasObjectiveDisagreement(remaining)) {
    return { kind: "ask_user", reason: "objective_disagreement" };
  }

  if (decision.nextAction === "ask_user") {
    return { kind: "ask_user", reason: "explicit_ask_user" };
  }

  if (autonomousResolutionThreshold === "none" && remaining.length > 0) {
    return { kind: "ask_user", reason: "threshold_none_with_remaining" };
  }

  // Loop discipline: while implementation disagreements remain AND
  // negotiation rounds remain, continue regardless of `nextAction`.
  // Threshold-based finalization or escalation applies only after rounds
  // are exhausted.
  if (
    hasImplementationDisagreement(remaining) &&
    negotiationRoundsRemaining > 0
  ) {
    return { kind: "continue_negotiation" };
  }

  // Rounds are exhausted (or no implementation disagreements remain).
  if (
    anyImplementationExceedsThreshold(remaining, autonomousResolutionThreshold)
  ) {
    return { kind: "ask_user", reason: "rounds_exhausted_above_threshold" };
  }

  return { kind: "final" };
}
