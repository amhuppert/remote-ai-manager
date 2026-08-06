import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { GraphWorkflowValidationIncidentEvent } from "@/lib/workflow-graph/event-schemas";
import type {
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

export interface CohortMemberView {
  assignmentId: string;
  /** `tier:id@revision`, read off the round's FROZEN roster seat. */
  profileLabel: string;
  strategy: "conversation" | "task";
  state: GraphWorkflowValidationSpecialistState;
  stateLabel: string;
  outcomeKind: CohortOutcomeKind;
  attempts: number;
  summary: string | null;
  /** Why this lane's most recent attempt was infrastructure, not a review. */
  infraFailureMessage: string | null;
  /** The lane conversation to open, when this lane rendered its verdict in one. */
  conversationId: string | null;
  backend: string | null;
}

export interface CohortIncidentView {
  key: string;
  incident: GraphWorkflowValidationIncidentEvent["incident"];
  label: string;
  assignmentId: string | null;
  message: string;
  occurredAt: string;
}

export interface CohortRoundView {
  seq: number;
  phase: GraphWorkflowValidationRound["phase"];
  outcome: GraphWorkflowValidationRound["outcome"];
  candidateTreeHash: string;
  aggregateLabel: string;
  aggregateKind: CohortOutcomeKind;
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

// A roster seat the round froze but never dispatched. The seat is still part of
// the cohort that must all pass, so it is listed rather than hidden.
const UNDISPATCHED: GraphWorkflowValidationSpecialist = {
  state: "pending",
  attempts: 0,
  summary: null,
  issues: [],
  questionToken: null,
  sessionRef: null,
  reviewArtifact: null,
  lastInfraFailure: null,
};

function memberView(
  seat: GraphWorkflowValidationRound["roster"][number],
  specialist: GraphWorkflowValidationSpecialist,
): CohortMemberView {
  const presentation = STATE_PRESENTATION[specialist.state];
  const sessionRef = specialist.sessionRef;
  return {
    assignmentId: seat.assignmentId,
    profileLabel: `${formatAgentProfileRef(seat.profileRef)}@${seat.revision}`,
    strategy: seat.strategy,
    state: specialist.state,
    stateLabel: presentation.label,
    outcomeKind: presentation.kind,
    attempts: specialist.attempts,
    summary: specialist.summary,
    infraFailureMessage: specialist.lastInfraFailure?.message ?? null,
    conversationId: sessionRef?.workflowConversationId ?? null,
    backend: sessionRef?.backend ?? null,
  };
}

/**
 * The context's latest validation round as the inspector renders it: the frozen
 * roster in configured order, each seat's lane standing, and the round's own
 * incidents.
 *
 * Identity comes from the ROSTER rather than the live cohort config, because
 * the roster is what actually reviewed the candidate — a config edit after the
 * round opened must show up as a different seat, not silently relabel this one.
 */
export function deriveCohortRoundView({
  round,
  incidents,
}: {
  round: GraphWorkflowValidationRound | null | undefined;
  incidents: readonly (GraphWorkflowValidationIncidentEvent & {
    occurredAt: string;
  })[];
}): CohortRoundView | null {
  if (!round) return null;

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
    members: round.roster.map((seat) =>
      memberView(seat, round.specialists[seat.assignmentId] ?? UNDISPATCHED),
    ),
    incidents: incidents
      .filter((incident) => incident.roundSeq === round.seq)
      .map((incident, index) => ({
        key: `${incident.incident}-${index}-${incident.occurredAt}`,
        incident: incident.incident,
        label: INCIDENT_LABEL[incident.incident],
        assignmentId: incident.assignmentId,
        message: incident.message,
        occurredAt: incident.occurredAt,
      })),
  };
}
