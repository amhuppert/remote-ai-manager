/**
 * The validation round: the durable record of WHAT a cohort is reviewing and
 * WHO is reviewing it, frozen before any validator runs.
 *
 * Determinism in a cohort is a claim about identity, not about scheduling: every
 * specialist must judge the same candidate, and a verdict that arrives for a
 * candidate that has since moved must be rejected rather than recorded. This
 * module owns that identity — how it is computed, how it is frozen, and how a
 * later observation is compared against the frozen one. The engine consults it
 * at exactly three points (after the script phase, before accepting a
 * specialist's result, before publishing an aggregate), so the rule lives in one
 * place instead of being re-derived at each.
 *
 * Everything here is pure. The one part that cannot be — reading git — is the
 * caller's, which is why {@link freezeValidationCandidate} takes an already
 * resolved tree rather than a worktree path.
 */

import { createHash } from "node:crypto";
import type {
  SeededValidatorAssignment,
  ValidatorAuthority,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowHaltReason,
  GraphWorkflowTaskState,
  GraphWorkflowValidationCandidate,
  GraphWorkflowValidationRosterEntry,
  GraphWorkflowValidationRound,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";

/**
 * The git half of a candidate identity, as read from a worktree.
 *
 * `identityScope` travels with the two hashes rather than being inferred later:
 * the resolver knows which reading it took, and a consumer holding only the
 * hashes could not tell a whole-tree object id from an owned-subset digest.
 */
export interface ValidationCandidateTree {
  identityScope: GraphWorkflowValidationCandidate["identityScope"];
  headSha: string;
  candidateTreeHash: string;
}

/**
 * What a worktree probe yielded. Unavailability is carried as its own case
 * rather than as null components: a round whose candidate has no tree identity
 * cannot make the claim a round exists to make, so the caller must conclude on
 * infrastructure grounds instead of quietly reviewing on task state alone.
 */
export type ValidationCandidateTreeResolution =
  | ({ kind: "resolved" } & ValidationCandidateTree)
  | { kind: "unavailable"; reason: string };

/**
 * The task-state generation of one context: a hash over the tuples a validator
 * is shown for each of the context's tasks.
 *
 * Sorted by task id so the hash is a function of content rather than of record
 * insertion order, and scoped to the context so a sibling context's progress
 * cannot invalidate this context's round.
 */
export function computeTaskStateHash(
  taskStates: Readonly<Record<string, GraphWorkflowTaskState>>,
  contextId: string,
): string {
  const tuples = Object.values(taskStates)
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map((task) => [
      task.taskId,
      String(task.order),
      task.status,
      task.summary ?? "",
    ]);

  // Length-prefixed join: no field value can forge a record separator, so two
  // different task sets cannot collide by embedding the delimiter in a summary.
  const canonical = tuples
    .map((fields) => fields.map((field) => `${field.length}:${field}`).join(""))
    .join("\n");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Freeze the identity of the candidate a round will review: the resolved tree
 * plus the context's task-state generation.
 */
export function freezeValidationCandidate(input: {
  tree: ValidationCandidateTree;
  taskStates: Readonly<Record<string, GraphWorkflowTaskState>>;
  contextId: string;
}): GraphWorkflowValidationCandidate {
  return {
    identityScope: input.tree.identityScope,
    headSha: input.tree.headSha,
    candidateTreeHash: input.tree.candidateTreeHash,
    taskStateHash: computeTaskStateHash(input.taskStates, input.contextId),
  };
}

/**
 * The roster, in cohort order. Order is preserved because the cohort's authored
 * order is its identity: a roster read back later must describe the cohort the
 * author configured, not an arbitrary permutation of it.
 */
export function buildValidationRoundRoster(
  assignments: readonly SeededValidatorAssignment[],
): GraphWorkflowValidationRosterEntry[] {
  return assignments.map((assignment) => ({
    assignmentId: assignment.id,
    profileRef: assignment.profile,
    revision: assignment.profileSnapshot.revision,
    resolvedInstructionHash: assignment.profileSnapshot.resolvedInstructionHash,
    strategy: assignment.strategy,
  }));
}

/**
 * The cohort a re-certification round runs: the blocking lanes, and nothing else
 * (R8.2).
 *
 * A filter over the runnable assignments rather than a rule applied when the
 * verdicts are weighed, so the advisory lanes are absent from the ROSTER — the
 * round's own record of who reviewed the candidate. They never dispatch, never
 * appear as seats a reader could mistake for reviewers that stayed silent, and
 * never raise advisories a second response turn would have to answer. A
 * re-certification asks one question — is the changed candidate still certified
 * — and only a lane that can answer "no" has anything to contribute to it.
 *
 * An empty result is legal and means exactly what it says: an advisory-only
 * cohort has nothing that could refuse the changed candidate, so its
 * re-certification is the script gate alone, or nothing at all.
 */
export function selectRecertificationAssignments<
  T extends { authority: ValidatorAuthority },
>(assignments: readonly T[]): T[] {
  return assignments.filter(
    (assignment) => assignment.authority === "blocking",
  );
}

function buildPendingSpecialist(): GraphWorkflowValidationSpecialist {
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

/**
 * Open a round: freeze the candidate and the roster together, with every
 * specialist still pending and the round in its script phase.
 *
 * Both freezes happen here, in one construction, because a roster frozen after
 * the first validator ran would not be the roster that reviewed the candidate.
 * `seq` continues the context's own numbering so a stale result can be told
 * apart from a current one even when two rounds happen to freeze the same tree.
 */
export function openValidationRound(input: {
  previousRound: GraphWorkflowValidationRound | null;
  candidate: GraphWorkflowValidationCandidate;
  assignments: readonly SeededValidatorAssignment[];
  startedAt: string;
}): GraphWorkflowValidationRound {
  return {
    seq: (input.previousRound?.seq ?? 0) + 1,
    candidate: input.candidate,
    roster: buildValidationRoundRoster(input.assignments),
    specialists: Object.fromEntries(
      input.assignments.map((assignment) => [
        assignment.id,
        buildPendingSpecialist(),
      ]),
    ),
    phase: "script",
    outcome: null,
    startedAt: input.startedAt,
  };
}

/** The round after the script phase admitted the cohort. */
export function admitSpecialists(
  round: GraphWorkflowValidationRound,
): GraphWorkflowValidationRound {
  return { ...round, phase: "specialists" };
}

/**
 * The round after an operator resumed the halt it caused: every lane that never
 * reached a verdict gets its attempt budget back.
 *
 * This is the ONLY thing that clears an attempt count, and it is reachable only
 * through {@link contextIdsResumingInfraHalt}. The count lives in the round
 * record so it survives a crash — a restart that silently reset it would hand a
 * broken provider three fresh dispatches every time the server bounced, and the
 * fixed bound of three would bound nothing (D5). Resuming an infrastructure halt
 * is the opposite case: a human has looked at the infrastructure and decided it
 * is worth trying again, so the budget is genuinely new.
 *
 * Verdicts already collected are untouched. They judged this same candidate and
 * re-running their reviewers would re-review work that was already reviewed.
 */
export function resetValidationRoundAttempts(
  round: GraphWorkflowValidationRound,
): GraphWorkflowValidationRound {
  const specialists: Record<string, GraphWorkflowValidationSpecialist> = {};
  for (const [assignmentId, specialist] of Object.entries(round.specialists)) {
    const settled =
      specialist.state === "verdict_pass" ||
      specialist.state === "verdict_fail" ||
      specialist.state === "parked";
    specialists[assignmentId] = settled
      ? specialist
      : {
          ...specialist,
          // `running` is a claim about a process that is gone; the lane is
          // waiting to be dispatched again, which is what pending means.
          state: "pending",
          attempts: 0,
          lastInfraFailure: null,
        };
  }
  return { ...round, specialists };
}

/**
 * The contexts a resume is giving attempt budget back to: exactly the ones an
 * infrastructure halt named.
 *
 * Resume has two callers that look identical at the execution level and are not.
 * One is an operator clearing a `validator_infra_error` halt — a human decided
 * the provider is worth another try. The other is the restart path, where
 * `normalizeAfterRestart` pauses a still-running execution with no halt reason
 * at all and the operator resumes that pause; nobody looked at anything there,
 * so a reset would let a crash loop buy three fresh dispatches per bounce.
 *
 * Scoped per context because halt reasons are: a sibling context's open round is
 * not what the operator resolved.
 */
export function contextIdsResumingInfraHalt(
  haltReasons: readonly (GraphWorkflowHaltReason | null | undefined)[],
): ReadonlySet<string> {
  const contextIds = new Set<string>();
  for (const reason of haltReasons) {
    if (reason?.type === "validator_infra_error") {
      contextIds.add(reason.contextId);
    }
  }
  return contextIds;
}

/**
 * The round after it ended. Retained rather than erased: `seq` has to outlive
 * the round it numbers or the next round cannot be told apart from it.
 */
export function concludeValidationRound(
  round: GraphWorkflowValidationRound,
  outcome: ValidationRoundOutcome | null,
): GraphWorkflowValidationRound {
  return { ...round, phase: "concluded", outcome };
}

/** Whether a cohort currently owns the candidate — the implementer's lockout. */
export function isValidationRoundOpen(
  round: GraphWorkflowValidationRound | null | undefined,
): boolean {
  return round !== null && round !== undefined && round.phase !== "concluded";
}

/** The frozen roster resolved back to runnable assignments, or why it cannot be. */
export type ValidationRosterReconciliation =
  | { kind: "ok"; assignments: SeededValidatorAssignment[] }
  | { kind: "drift"; detail: string };

/**
 * Resolve the frozen roster against the cohort the definition declares NOW.
 *
 * This is what makes the persisted roster execution-authoritative rather than
 * observational: dispatch order comes from the roster, and any divergence —
 * a seat removed, its delivered instructions rewritten, a reviewer added — is
 * refused outright rather than silently running a cohort other than the one
 * recorded as owning the candidate. Config edits are legal; they simply belong
 * to the next round, which will freeze them.
 */
export function reconcileValidationRoster(
  roster: readonly GraphWorkflowValidationRosterEntry[],
  assignments: readonly SeededValidatorAssignment[],
): ValidationRosterReconciliation {
  const byId = new Map(assignments.map((entry) => [entry.id, entry]));
  const resolved: SeededValidatorAssignment[] = [];
  const drifted: string[] = [];

  for (const seat of roster) {
    const assignment = byId.get(seat.assignmentId);
    if (assignment === undefined) {
      drifted.push(`${seat.assignmentId} (no longer configured)`);
      continue;
    }
    byId.delete(seat.assignmentId);
    // Every field the roster records is compared, profile reference included:
    // two profiles can render byte-identical text at the same revision, so
    // hash equality is not identity. The roster names WHO reviewed the
    // candidate, and a seat repointed at another profile makes that name wrong
    // even when the delivered instructions are indistinguishable.
    if (
      assignment.strategy !== seat.strategy ||
      assignment.profile.tier !== seat.profileRef.tier ||
      assignment.profile.id !== seat.profileRef.id ||
      assignment.profileSnapshot.revision !== seat.revision ||
      assignment.profileSnapshot.resolvedInstructionHash !==
        seat.resolvedInstructionHash
    ) {
      drifted.push(`${seat.assignmentId} (redefined since the freeze)`);
      continue;
    }
    resolved.push(assignment);
  }

  for (const added of byId.keys()) {
    drifted.push(`${added} (added after the freeze)`);
  }

  return drifted.length > 0
    ? { kind: "drift", detail: drifted.join(", ") }
    : { kind: "ok", assignments: resolved };
}

/**
 * Which components decide identity, per scope.
 *
 * `identityScope` is compared under both, and first: the two identity forms are
 * not comparable, so a scope that changed under an open round is drift, never a
 * pair of hashes to weigh. `headSha` is absent from the `owned` set for the
 * reason the schema records — a same-lane sibling landing its own work moves the
 * base commit without touching anything this context owns, and a round that
 * called that drift could never complete while a sibling was still landing.
 */
const CANDIDATE_COMPONENTS = {
  wholeTree: ["identityScope", "headSha", "candidateTreeHash", "taskStateHash"],
  owned: ["identityScope", "candidateTreeHash", "taskStateHash"],
} as const satisfies Record<
  GraphWorkflowValidationCandidate["identityScope"],
  readonly (keyof GraphWorkflowValidationCandidate)[]
>;

function driftedComponents(
  frozen: GraphWorkflowValidationCandidate,
  observed: GraphWorkflowValidationCandidate,
): string[] {
  // Keyed off the FROZEN scope: the round's own claim about what it is reviewing
  // is what an observation has to answer, and a mismatched observed scope is
  // caught by the `identityScope` component every set contains.
  return CANDIDATE_COMPONENTS[frozen.identityScope].filter(
    (component) => frozen[component] !== observed[component],
  );
}

/**
 * Whether an observation is still the frozen candidate. Strict equality per
 * component; every component is present by construction, so there is no
 * "unknown equals unknown" case for a round to pass through.
 */
export function candidateIdentityMatches(
  frozen: GraphWorkflowValidationCandidate,
  observed: GraphWorkflowValidationCandidate,
): boolean {
  return driftedComponents(frozen, observed).length === 0;
}

/** The moved components, for the incident record an operator reads. */
export function describeCandidateDrift(
  frozen: GraphWorkflowValidationCandidate,
  observed: GraphWorkflowValidationCandidate,
): string {
  return driftedComponents(frozen, observed).join(", ");
}

/**
 * How a round ended. The two infrastructure outcomes are deliberately NOT
 * verdicts: neither charges a validation iteration nor a consecutive failure,
 * because in neither case did a validator judge the work.
 */
export type ValidationRoundOutcome =
  /** The deterministic script validator failed; zero specialists were launched. */
  | "script_failed"
  /** The candidate moved out from under the round. */
  | "candidate_mismatch"
  /** The cohort that owned the candidate is not the cohort now configured. */
  | "roster_drift"
  /** Every required specialist passed the frozen candidate. */
  | "passed"
  /** A required specialist rejected the frozen candidate. */
  | "failed";
