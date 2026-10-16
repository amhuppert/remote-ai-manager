import { z } from "zod";
import type {
  Candidate,
  CandidateProvenance,
  ContextFacts,
  RetirementReason,
} from "./schemas";

const reportOutputSchema = z.toJSONSchema(
  z.object({ summary: z.string() }).strict(),
);

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
  if (outputCaptureSchema(facts) === null) return false;
  const captured = facts.candidates.captured;
  return (
    captured === null || captured.workTurn !== facts.ledger.settledWorkTurns
  );
}

/** Advice formatting returns dispositions, so its revised report needs its own capture. */
export function outputCaptureSchema(
  facts: ContextFacts,
): Record<string, unknown> | null {
  return (
    facts.contract.current.outputSchema ??
    (facts.candidates.nextProvenance.kind === "advice_response"
      ? reportOutputSchema
      : null)
  );
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

/**
 * An admitted work turn may have changed files: the candidate it worked on is
 * no longer what was reviewed, and its output, capture, stability counts and
 * provenance start again with the new work.
 */
export function startWorkEpoch(facts: ContextFacts): ContextFacts {
  const retired = retireCurrent(facts, "reworked");
  return {
    ...retired,
    candidates: {
      ...retired.candidates,
      captured: null,
      captureFailures: null,
      unstableCount: 0,
      verifyPending: null,
      // New work is reviewed in full, even right after an advisory response.
      nextProvenance: { kind: "work" },
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
