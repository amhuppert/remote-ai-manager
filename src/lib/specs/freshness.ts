import type {
  EvidenceEvaluatedState,
  EvidenceKind,
  SpecExecutionState,
} from "./schemas";

export interface GitProbes {
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
  relevantTreeHash(
    commitSha: string,
    relevantPaths: readonly string[],
  ): Promise<string>;
}

export interface CandidateState {
  commitSha: string;
}

export interface LaterVerdictApplicability {
  verdictId: string;
  candidateSha: string;
}

export interface FreshnessEvidence {
  id: string;
  kind: EvidenceKind;
  evaluatedState: EvidenceEvaluatedState;
  producingExecutionState: SpecExecutionState;
  laterVerdictApplicability?: LaterVerdictApplicability;
}

export interface CandidateValidationFact {
  validationRef: string;
  validatedSha: string;
  validatedTreeHash: string;
  commandIdentity: string;
  outcome: "pass" | "fail";
}

export type FreshnessBasis =
  | "candidate_history"
  | "identical_relevant_tree"
  | "pre_merge_candidate_validation";

export type StaleReason =
  | "abandoned_run_applicability_unestablished"
  | "missing_commit_state"
  | "not_in_candidate_history"
  | "relevant_tree_changed"
  | "candidate_validation_failed"
  | "candidate_validation_not_for_candidate"
  | "candidate_validation_tree_changed";

export type FreshnessResult =
  | { status: "valid"; basis: FreshnessBasis }
  | { status: "stale"; reason: StaleReason; action: string };

const ATTACH_CANDIDATE_EVIDENCE =
  "produce evidence that resolves into the delivery candidate";
const RERUN_VALIDATION = "rerun validation against the delivery candidate";
const RERUN_DETERMINISTIC_VALIDATION =
  "rerun deterministic validation against the delivery candidate";

function abandonedRunApplicability(
  evidence: FreshnessEvidence,
  candidate: CandidateState,
): FreshnessResult | undefined {
  if (evidence.producingExecutionState !== "abandoned") {
    return undefined;
  }
  if (
    evidence.laterVerdictApplicability?.candidateSha === candidate.commitSha
  ) {
    return undefined;
  }

  return {
    status: "stale",
    reason: "abandoned_run_applicability_unestablished",
    action:
      "establish applicability to this candidate in a later proof verdict",
  };
}

async function evaluateHistoryEvidence(
  evidence: FreshnessEvidence,
  candidate: CandidateState,
  probes: GitProbes,
): Promise<FreshnessResult> {
  const evidenceCommitSha = evidence.evaluatedState.commitSha;
  if (!evidenceCommitSha) {
    return {
      status: "stale",
      reason: "missing_commit_state",
      action: ATTACH_CANDIDATE_EVIDENCE,
    };
  }

  if (await probes.isAncestor(evidenceCommitSha, candidate.commitSha)) {
    return { status: "valid", basis: "candidate_history" };
  }

  return {
    status: "stale",
    reason: "not_in_candidate_history",
    action: ATTACH_CANDIDATE_EVIDENCE,
  };
}

async function evaluateTreeEvidence(
  evidence: FreshnessEvidence,
  evaluatedTreeHash: string,
  candidate: CandidateState,
  probes: GitProbes,
): Promise<FreshnessResult> {
  const candidateTreeHash = await probes.relevantTreeHash(
    candidate.commitSha,
    evidence.evaluatedState.relevantPaths,
  );
  if (candidateTreeHash === evaluatedTreeHash) {
    return { status: "valid", basis: "identical_relevant_tree" };
  }

  return {
    status: "stale",
    reason: "relevant_tree_changed",
    action: RERUN_VALIDATION,
  };
}

export async function evaluateEvidenceFreshness(
  evidence: FreshnessEvidence,
  candidate: CandidateState,
  probes: GitProbes,
): Promise<FreshnessResult> {
  const abandonedApplicability = abandonedRunApplicability(evidence, candidate);
  if (abandonedApplicability) {
    return abandonedApplicability;
  }

  switch (evidence.kind) {
    case "commit":
      return evaluateHistoryEvidence(evidence, candidate, probes);
    case "test_run":
    case "validator_verdict": {
      // Merge-time candidate validation stamps a relevant tree hash and keeps
      // the strong tree-identity check. Ingested in-run machine evidence only
      // carries the lane commit it validated; ancestry into the candidate is
      // the same standard commit evidence already meets. Rows with neither
      // (legacy sha-less ingests) stay honestly stale via missing_commit_state.
      const evaluatedTreeHash = evidence.evaluatedState.relevantTreeHash;
      return evaluatedTreeHash !== undefined
        ? evaluateTreeEvidence(evidence, evaluatedTreeHash, candidate, probes)
        : evaluateHistoryEvidence(evidence, candidate, probes);
    }
  }
}

export async function evaluateDeterministicValidatorCredit(
  validation: CandidateValidationFact,
  candidate: CandidateState,
  probes: GitProbes,
): Promise<FreshnessResult> {
  if (validation.outcome !== "pass") {
    return {
      status: "stale",
      reason: "candidate_validation_failed",
      action: RERUN_DETERMINISTIC_VALIDATION,
    };
  }

  const candidateTreeHash = await probes.relevantTreeHash(
    candidate.commitSha,
    [],
  );
  if (candidateTreeHash !== validation.validatedTreeHash) {
    return {
      status: "stale",
      reason: "candidate_validation_tree_changed",
      action: RERUN_DETERMINISTIC_VALIDATION,
    };
  }

  return { status: "valid", basis: "pre_merge_candidate_validation" };
}
