import type { Candidate, ContextFacts } from "./schemas";

export type ApprovalStanding =
  | { kind: "not_required" }
  | { kind: "pending" }
  | { kind: "approved" }
  | { kind: "rejected"; notes: string | null };

/** A human decision applies only to the candidate and contract revision it names. */
export function approvalStanding(
  facts: ContextFacts,
  candidate: Candidate,
): ApprovalStanding {
  if (!facts.contract.current.humanApproval) return { kind: "not_required" };
  const decision = facts.approval.decisions
    .filter(
      (d) =>
        d.candidateId === candidate.id &&
        d.contractRevision === facts.contract.revision,
    )
    .at(-1);
  if (decision === undefined) return { kind: "pending" };
  return decision.decision === "approved"
    ? { kind: "approved" }
    : { kind: "rejected", notes: decision.notes ?? null };
}

export function recordDecision(
  facts: ContextFacts,
  input: {
    candidateId: string;
    decision: "approved" | "rejected";
    notes?: string;
    decidedAt: string;
  },
): ContextFacts {
  return {
    ...facts,
    approval: {
      ...facts.approval,
      decisions: [
        ...facts.approval.decisions,
        {
          candidateId: input.candidateId,
          contractRevision: facts.contract.revision,
          decision: input.decision,
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          decidedAt: input.decidedAt,
        },
      ],
    },
  };
}
