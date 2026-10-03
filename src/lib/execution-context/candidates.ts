import type {
  Candidate,
  CandidateProvenance,
  ContextFacts,
  RetirementReason,
} from "./schemas";

/**
 * The candidate whose proof is current: frozen at the current contract and
 * task revisions and not retired. Certification, approval and acceptance bind
 * to its id, so they lapse when it stops being current; nothing deletes them.
 */
export function currentCandidate(facts: ContextFacts): Candidate | null {
  const retired = new Set(facts.candidates.retired.map((r) => r.candidateId));
  const latest = facts.candidates.items.at(-1);
  if (latest === undefined || retired.has(latest.id)) return null;
  if (
    latest.contractRevision !== facts.contract.revision ||
    latest.taskRevision !== facts.ledger.revision
  ) {
    return null;
  }
  return latest;
}

export function captureExhausted(facts: ContextFacts): boolean {
  const failures = facts.candidates.captureFailures;
  return (
    failures !== null &&
    failures.workTurn === facts.ledger.settledWorkTurns &&
    failures.count > facts.policy.captureRepairLimit
  );
}

export function candidateUnstable(facts: ContextFacts): boolean {
  return facts.candidates.unstableCount >= facts.policy.instabilityLimit;
}

/** Whether output for the current work epoch still needs a capture turn. */
export function needsOutputCapture(facts: ContextFacts): boolean {
  if (facts.contract.current.outputSchema === null) return false;
  const captured = facts.candidates.captured;
  return captured === null || captured.workTurn !== facts.ledger.settledWorkTurns;
}

export function retireCurrent(
  facts: ContextFacts,
  reason: RetirementReason,
): ContextFacts {
  const current = currentCandidate(facts);
  if (current === null) return facts;
  return {
    ...facts,
    candidates: {
      ...facts.candidates,
      retired: [
        ...facts.candidates.retired,
        { candidateId: current.id, reason },
      ],
      unstableCount:
        reason === "changed"
          ? facts.candidates.unstableCount + 1
          : facts.candidates.unstableCount,
    },
  };
}

export function freezeCandidate(
  facts: ContextFacts,
  input: { contextId: string; evidence: string },
): ContextFacts {
  const sequence = facts.candidates.sequence + 1;
  const output =
    facts.candidates.captured?.output ??
    (facts.contract.current.outputSchema === null
      ? { summary: facts.ledger.lastSummary }
      : null);
  const provenance: CandidateProvenance = facts.candidates.nextProvenance;
  const candidate: Candidate = {
    id: `${input.contextId}:candidate:${sequence}`,
    contractRevision: facts.contract.revision,
    taskRevision: facts.ledger.revision,
    output,
    evidence: input.evidence,
    provenance,
  };
  return {
    ...facts,
    candidates: {
      ...facts.candidates,
      sequence,
      items: [...facts.candidates.items, candidate],
      captured: null,
      nextProvenance: { kind: "work" },
    },
  };
}
