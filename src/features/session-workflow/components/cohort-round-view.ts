import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import type { GraphWorkflowValidationIncidentEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAdvisoryResponsePhase,
  GraphWorkflowValidationAdvisory,
  GraphWorkflowValidationRound,
  GraphWorkflowValidationSpecialist,
  GraphWorkflowValidationSpecialistState,
} from "@/lib/workflow-graph/schemas";

/**
 * Whether an outcome is somebody's judgement of the work, or something that
 * happened to the round instead.
 *
 * This is the axis R12 requires the inspector to make legible, and it is
 * derived from the round record and the incident stream — never from a tone.
 * `open` is the honest third answer for a lane that has not landed anywhere
 * yet: rendering it as either of the other two would invent a result.
 */
export type CohortOutcomeKind = "semantic" | "infrastructure" | "open";

/**
 * A roster seat's blocking power, as the round history can honestly state it.
 *
 * `unknown` is the third answer rather than a defaulted `advisory`, because
 * authority is read from the cohort as configured NOW — the same place the
 * engine reads it — and a retained round can outlive the seat that ran it. A
 * removed seat whose badge claimed "advisory" would tell the operator its
 * findings could never have failed the context, which nothing in the record
 * supports.
 */
export type CohortMemberAuthority = ValidatorAuthority | "unknown";

/**
 * What the implementer did with one advisory, or the fact that nothing has
 * been recorded. `pending` is not a promise that an answer is coming: an
 * advisory raised on a failing round is answered by that round's remediation
 * work and never carries a disposition (R6/D7).
 */
export type CohortAdvisoryDispositionState =
  | "pending"
  | "addressed"
  | "declined"
  | "deferred";

export interface CohortAdvisoryView {
  /** Stable across re-renders: the engine-stamped identity, flattened. */
  key: string;
  kind: GraphWorkflowValidationAdvisory["kind"];
  kindLabel: string;
  title: string;
  description: string;
  disposition: CohortAdvisoryDispositionState;
  dispositionLabel: string;
  /** The implementer's words, required on a decline and optional otherwise. */
  dispositionReason: string | null;
}

export interface CohortMemberView {
  assignmentId: string;
  /** `tier:id@revision`, read off the round's FROZEN roster seat. */
  profileLabel: string;
  state: GraphWorkflowValidationSpecialistState;
  stateLabel: string;
  outcomeKind: CohortOutcomeKind;
  authority: CohortMemberAuthority;
  authorityLabel: string;
  /**
   * Whether this lane's standing can gate the round. False for an advisory
   * seat, which is what keeps its infrastructure exhaustion legible as a
   * recorded fact rather than as a round-blocking failure (R9.5). An unknown
   * authority keeps the round-blocking presentation rather than quietly
   * downgrading a lane that may well have gated the round.
   */
  blocksRound: boolean;
  attempts: number;
  summary: string | null;
  /** Why this lane's most recent attempt was infrastructure, not a review. */
  infraFailureMessage: string | null;
  advisories: CohortAdvisoryView[];
  /** The lane conversation to open, when this lane rendered its verdict in one. */
  conversationId: string | null;
  backend: string | null;
}

export interface CohortIncidentView {
  key: string;
  incident: GraphWorkflowValidationIncidentEvent["incident"];
  label: string;
  assignmentId: string | null;
  /** False when the incident belongs to a seat that cannot gate the round. */
  blocksRound: boolean;
  message: string;
  occurredAt: string;
}

export type CohortRoundStep =
  | "script"
  | "specialists"
  | "concluded"
  | "advisory_response";

export interface CohortRoundStepView {
  step: CohortRoundStep;
  label: string;
  state: "done" | "current" | "upcoming";
}

export interface CohortRoundView {
  seq: number;
  phase: GraphWorkflowValidationRound["phase"];
  outcome: GraphWorkflowValidationRound["outcome"];
  candidateTreeHash: string;
  aggregateLabel: string;
  aggregateKind: CohortOutcomeKind;
  /**
   * The round's phases in order, with the one it currently sits in marked.
   * Carries the advisory-response step only when the context owes a response
   * turn for THIS round, so that phase is distinguishable from both an open
   * validation and a finished one (R6.3).
   */
  timeline: CohortRoundStepView[];
  members: CohortMemberView[];
  incidents: CohortIncidentView[];
}

const STATE_PRESENTATION: Record<
  GraphWorkflowValidationSpecialistState,
  { label: string; kind: CohortOutcomeKind }
> = {
  pending: { label: "Not started", kind: "open" },
  running: { label: "Reviewing", kind: "open" },
  verdict_pass: { label: "Passed", kind: "semantic" },
  verdict_fail: { label: "Rejected", kind: "semantic" },
  infra_failed: { label: "Infrastructure failure", kind: "infrastructure" },
  parked: { label: "Awaiting answer", kind: "open" },
};

// A concluded round's outcome, in the reader's terms. `script_failed` is a
// SEMANTIC rejection: the script gate judged the candidate and refused it, which
// is a verdict on the work in exactly the way a tree that moved is not.
const OUTCOME_PRESENTATION: Record<
  NonNullable<GraphWorkflowValidationRound["outcome"]>,
  { label: string; kind: CohortOutcomeKind }
> = {
  passed: { label: "Cohort passed", kind: "semantic" },
  failed: { label: "Cohort rejected", kind: "semantic" },
  script_failed: { label: "Script gate failed", kind: "semantic" },
  candidate_mismatch: {
    label: "Candidate changed under the cohort",
    kind: "infrastructure",
  },
  roster_drift: {
    label: "Cohort roster drifted mid-round",
    kind: "infrastructure",
  },
};

const OPEN_PHASE_LABEL: Record<GraphWorkflowValidationRound["phase"], string> =
  {
    script: "Script gate running",
    specialists: "Cohort reviewing",
    // A concluded round always carries an outcome; this only covers a record
    // caught between the two writes.
    concluded: "Concluding",
  };

const INCIDENT_LABEL: Record<
  GraphWorkflowValidationIncidentEvent["incident"],
  string
> = {
  candidate_mismatch: "Candidate changed",
  roster_drift: "Roster drifted",
  infra_failure: "Infrastructure failure — retrying",
  infra_exhausted: "Infrastructure attempts exhausted",
  stale_result_rejected: "Stale result rejected",
  round_superseded: "Result dropped: round superseded",
};

const AUTHORITY_LABEL: Record<CohortMemberAuthority, string> = {
  blocking: "Blocking",
  advisory: "Advisory",
  unknown: "Authority unknown",
};

/** The seat's blocking power in words. Every authority badge states it. */
export function authorityLabel(authority: CohortMemberAuthority): string {
  return AUTHORITY_LABEL[authority];
}

/**
 * What happened to a round or a seat, in words. Shared with the surfaces that
 * name an incident outside a round's own card, so one incident is never
 * described two ways.
 */
export function incidentLabel(
  incident: GraphWorkflowValidationIncidentEvent["incident"],
): string {
  return INCIDENT_LABEL[incident];
}

/**
 * A seat's authority, read from the cohort as configured NOW — the same place
 * the engine reads it, so a live authority edit moves every badge with it.
 *
 * Shared by the live round view and by the specialist rows of a round that has
 * since been superseded: both name the same seat, and answering the question
 * two different ways would let one round's badge contradict another's.
 */
export function authorityOfSeat(
  assignments: readonly { id: string; authority: ValidatorAuthority }[],
  assignmentId: string,
): CohortMemberAuthority {
  return (
    assignments.find((assignment) => assignment.id === assignmentId)
      ?.authority ?? "unknown"
  );
}

const ADVISORY_KIND_LABEL: Record<
  GraphWorkflowValidationAdvisory["kind"],
  string
> = {
  implementation: "Implementation",
  plan: "Plan",
  out_of_scope: "Out of scope",
};

const DISPOSITION_LABEL: Record<CohortAdvisoryDispositionState, string> = {
  pending: "No disposition",
  addressed: "Addressed",
  declined: "Declined",
  deferred: "Deferred",
};

const STEP_LABEL: Record<CohortRoundStep, string> = {
  script: "Script gate",
  specialists: "Specialists",
  concluded: "Concluded",
  advisory_response: "Advisory response",
};

const ROUND_PHASE_ORDER: CohortRoundStep[] = [
  "script",
  "specialists",
  "concluded",
];

// A roster seat the round froze but never dispatched. The seat is still part of
// the cohort that must all pass, so it is listed rather than hidden.
const UNDISPATCHED: GraphWorkflowValidationSpecialist = {
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

function advisoryView(
  advisory: GraphWorkflowValidationAdvisory,
): CohortAdvisoryView {
  const { roundSeq, assignmentId, ordinal } = advisory.identity;
  const disposition = advisory.disposition?.outcome ?? "pending";
  return {
    key: `${roundSeq}:${assignmentId}:${ordinal}`,
    kind: advisory.kind,
    kindLabel: ADVISORY_KIND_LABEL[advisory.kind],
    title: advisory.title,
    description: advisory.description,
    disposition,
    dispositionLabel: DISPOSITION_LABEL[disposition],
    dispositionReason: advisory.disposition?.reason ?? null,
  };
}

/**
 * How a lane's state reads once its authority is known.
 *
 * Only infrastructure exhaustion branches: an advisory seat that never got to
 * answer costs the round nothing, so presenting it in the same terms as a
 * blocking seat's exhaustion would overstate a fact the round already ruled on
 * (R9.5). A verdict reads the same either way — what a reviewer decided does
 * not change with what that decision was allowed to do.
 */
function statePresentation(
  state: GraphWorkflowValidationSpecialistState,
  blocksRound: boolean,
): { label: string; kind: CohortOutcomeKind } {
  if (state === "infra_failed" && !blocksRound) {
    return {
      label: "Infrastructure failure — recorded",
      kind: "infrastructure",
    };
  }
  return STATE_PRESENTATION[state];
}

function memberView(
  seat: GraphWorkflowValidationRound["roster"][number],
  specialist: GraphWorkflowValidationSpecialist,
  authority: CohortMemberAuthority,
): CohortMemberView {
  const blocksRound = authority !== "advisory";
  const presentation = statePresentation(specialist.state, blocksRound);
  const sessionRef = specialist.sessionRef;
  return {
    assignmentId: seat.assignmentId,
    profileLabel: `${formatAgentProfileRef(seat.profileRef)}@${seat.revision}`,
    state: specialist.state,
    stateLabel: presentation.label,
    outcomeKind: presentation.kind,
    authority,
    authorityLabel: authorityLabel(authority),
    blocksRound,
    attempts: specialist.attempts,
    summary: specialist.summary,
    infraFailureMessage: specialist.lastInfraFailure?.message ?? null,
    advisories: specialist.advisories.map(advisoryView),
    conversationId: sessionRef?.workflowConversationId ?? null,
    backend: sessionRef?.backend ?? null,
  };
}

/**
 * The round's phases in order, with the advisory-response step appended only
 * when the context owes a response turn for THIS round.
 *
 * A phase belonging to an earlier round is not this round's business: the two
 * are told apart by `roundSeq`, which is exactly what that field is for.
 */
function timelineView(
  round: GraphWorkflowValidationRound,
  advisoryResponse: GraphWorkflowAdvisoryResponsePhase | null,
): CohortRoundStepView[] {
  const owed =
    advisoryResponse !== null && advisoryResponse.roundSeq === round.seq
      ? advisoryResponse
      : null;
  const phaseIndex = ROUND_PHASE_ORDER.indexOf(round.phase);
  // A response turn is owed only after the round concluded, so the concluded
  // step is behind the reader rather than where they are.
  const currentIndex =
    owed?.phase === "awaiting_response" ? ROUND_PHASE_ORDER.length : phaseIndex;

  const steps: CohortRoundStepView[] = ROUND_PHASE_ORDER.map((step, index) => ({
    step,
    label: STEP_LABEL[step],
    state:
      index < currentIndex
        ? "done"
        : index === currentIndex
          ? "current"
          : ("upcoming" as const),
  }));

  if (owed === null) return steps;
  return [
    ...steps,
    {
      step: "advisory_response",
      label: STEP_LABEL.advisory_response,
      // `recertifying` means the turn already ran and moved the candidate; the
      // work it created belongs to the re-certification round, not to this one.
      state: owed.phase === "awaiting_response" ? "current" : "done",
    },
  ];
}

/**
 * The context's latest validation round as the inspector renders it: the frozen
 * roster in configured order, each seat's lane standing, and the round's own
 * incidents.
 *
 * Identity comes from the ROSTER rather than the live cohort config, because
 * the roster is what actually reviewed the candidate — a config edit after the
 * round opened must show up as a different seat, not silently relabel this one.
 * Authority is the one exception, read from the live cohort exactly as the
 * engine reads it: a seat holds the blocking power it holds now, not one
 * reconstructed from an earlier round.
 */
export function deriveCohortRoundView({
  round,
  incidents,
  assignments = [],
  advisoryResponse = null,
}: {
  round: GraphWorkflowValidationRound | null | undefined;
  incidents: readonly (GraphWorkflowValidationIncidentEvent & {
    occurredAt: string;
  })[];
  /** The cohort as configured now; a seat missing from it reads as unknown. */
  assignments?: readonly { id: string; authority: ValidatorAuthority }[];
  advisoryResponse?: GraphWorkflowAdvisoryResponsePhase | null;
}): CohortRoundView | null {
  if (!round) return null;

  const authorityOf = (assignmentId: string): CohortMemberAuthority =>
    authorityOfSeat(assignments, assignmentId);

  const outcome = round.outcome
    ? OUTCOME_PRESENTATION[round.outcome]
    : { label: OPEN_PHASE_LABEL[round.phase], kind: "open" as const };

  return {
    seq: round.seq,
    phase: round.phase,
    outcome: round.outcome,
    candidateTreeHash: round.candidate.candidateTreeHash,
    aggregateLabel: outcome.label,
    aggregateKind: outcome.kind,
    timeline: timelineView(round, advisoryResponse),
    members: round.roster.map((seat) =>
      memberView(
        seat,
        round.specialists[seat.assignmentId] ?? UNDISPATCHED,
        authorityOf(seat.assignmentId),
      ),
    ),
    incidents: incidents
      .filter((incident) => incident.roundSeq === round.seq)
      .map((incident, index) => ({
        key: `${incident.incident}-${index}-${incident.occurredAt}`,
        incident: incident.incident,
        label: INCIDENT_LABEL[incident.incident],
        assignmentId: incident.assignmentId,
        // A round-level incident (no assignment) is always the round's own
        // business; a lane's is the lane's, and inherits its blocking power.
        blocksRound:
          incident.assignmentId === null ||
          authorityOf(incident.assignmentId) !== "advisory",
        message: incident.message,
        occurredAt: incident.occurredAt,
      })),
  };
}
