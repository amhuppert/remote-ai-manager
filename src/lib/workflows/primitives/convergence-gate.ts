/**
 * Convergence gate for the workflow primitive layer.
 *
 * Decides whether a multi-lane workflow has reached agreement based on each
 * lane's latest accept/reject vote. Today the only convergence policy is
 * "all voters must accept in the same round" — the canonical Collaboration
 * Mode condition. The shape is deliberately small:
 *
 *  - All voters accepted → `pass`.
 *  - Any voter rejected → `fail`, with the rejecting voters surfaced in
 *    `details.rejectors` so an owning workflow can route a follow-up round.
 *  - No voters supplied → `fail`, since "convergence among nobody" is never
 *    a valid pass and almost always points at a wiring bug in the caller.
 *
 * The gate is pure: callers are responsible for collecting the votes from
 * lane outputs (typically the structured per-round response schema from
 * Collaboration Mode) and feeding them in.
 */

import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

export type ConvergenceDecision = "accept" | "reject";

export interface ConvergenceVote {
  voter: string;
  decision: ConvergenceDecision;
  reason?: string;
}

export interface RunConvergenceGateInput {
  votes: readonly ConvergenceVote[];
}

export type ConvergenceGateResult = GatePassResult | GateFailResult;

export function runConvergenceGate(
  input: RunConvergenceGateInput,
): ConvergenceGateResult {
  const votes = input.votes;
  const voterCount = votes.length;

  if (voterCount === 0) {
    return gateFail({
      kind: "convergence",
      reason:
        "convergence requires at least one voter, but the votes list was empty",
      details: { voterCount: 0, acceptCount: 0, rejectCount: 0 },
    });
  }

  const rejectors = votes
    .filter((vote) => vote.decision === "reject")
    .map((vote) => ({
      voter: vote.voter,
      ...(vote.reason !== undefined ? { reason: vote.reason } : {}),
    }));

  const acceptCount = voterCount - rejectors.length;
  const rejectCount = rejectors.length;

  if (rejectCount === 0) {
    return gatePass({
      kind: "convergence",
      details: { voterCount, acceptCount, rejectCount },
    });
  }

  const rejectorNames = rejectors.map((r) => r.voter).join(", ");
  return gateFail({
    kind: "convergence",
    reason: `convergence not reached: ${rejectorNames} rejected`,
    details: {
      voterCount,
      acceptCount,
      rejectCount,
      rejectors,
    },
  });
}
