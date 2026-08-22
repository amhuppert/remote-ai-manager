import {
  deriveGraphWorkflowValidationSpecialistUsage,
  type GraphWorkflowValidationIncidentEvent,
  type GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";
import type { ContextIterationReader } from "./conversation-history";
import type { Timestamped } from "./history-entries";

/**
 * History tab → Rounds (§11): each validation round as one row — which round,
 * which iteration, how it stands, the roster it froze, and what its artifacts
 * cost.
 *
 * A round is not one record. The context state keeps only the LATEST round with
 * per-seat detail, while a concluded round MAY leave a result event carrying
 * the aggregate. Both are indexed here by `seq` so a round that has both is one
 * row with two renderings rather than two rows claiming to be the same round.
 * Nothing about issue ownership or filtering is decided here — that stays with
 * the cards (README §2.3).
 *
 * Only what the execution still records is listed. A script-failed round
 * concludes through the execution log alone and an incident-concluded one
 * publishes no aggregate, so once a later round takes the context-state slot
 * nothing of them survives but their number. Those rounds are simply absent:
 * the card lists rounds, it does not reconstruct them, and a row assembled out
 * of the configuration standing now would describe a round that never happened.
 *
 * Rounds a context reset retired are out of scope entirely — the visible
 * history is the current attempt at the context.
 */

export type ValidationRoundStatus =
  | "in_flight"
  | "passed"
  | "rejected"
  | "infrastructure";

export interface ValidationRoundUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  apiTurns: number | null;
}

export interface ValidationRoundRow {
  seq: number;
  /** The iteration this round judged, read off the context's status stream. */
  iteration: number;
  status: ValidationRoundStatus;
  statusLabel: string;
  /**
   * The seats the round froze.
   *
   * The live record carries the roster itself. A concluded round does not: its
   * aggregate lists only the lanes that reported a verdict, so a seat the round
   * froze and then lost — exhausted on infrastructure, or dropped for answering
   * into a superseded round — is absent from it while having been every bit as
   * much a member. The incidents the round itself recorded name those seats, so
   * the two together are the roster as the round actually stood.
   */
  roster: readonly string[];
  /** Every review artifact the round produced, by reference. */
  references: readonly string[];
  /** The round's spend, summed over the artifacts that reported any. */
  usage: ValidationRoundUsage | null;
  /** The live round record, when this row has one. */
  live: GraphWorkflowValidationRound | null;
  /** The concluded aggregate, when this row has one. */
  record: Timestamped<GraphWorkflowValidationResultEvent> | null;
}

const STATUS_LABEL: Record<ValidationRoundStatus, string> = {
  in_flight: "in flight",
  passed: "passed",
  rejected: "rejected",
  infrastructure: "unsettled",
};

function statusOfOutcome(
  outcome: GraphWorkflowValidationRound["outcome"],
): ValidationRoundStatus {
  if (outcome === null) return "in_flight";
  if (outcome === "passed") return "passed";
  if (outcome === "failed" || outcome === "script_failed") return "rejected";
  // A candidate that moved or a roster that drifted is not a judgement of the
  // work, and calling it "rejected" would attribute a verdict nobody gave.
  return "infrastructure";
}

function addUsage(
  total: ValidationRoundUsage | null,
  artifact: GraphWorkflowValidationReviewArtifact | null | undefined,
): ValidationRoundUsage | null {
  const usage = deriveGraphWorkflowValidationSpecialistUsage(artifact ?? null);
  if (usage === null) return total;
  const base = total ?? {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    costUsd: null,
    apiTurns: null,
  };
  const sum = (left: number | null, right: number | null): number | null =>
    left === null && right === null ? null : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: sum(base.inputTokens, usage.inputTokens),
    cachedInputTokens: sum(base.cachedInputTokens, usage.cachedInputTokens),
    outputTokens: sum(base.outputTokens, usage.outputTokens),
    costUsd: sum(base.costUsd, usage.costUsd),
    apiTurns: sum(base.apiTurns, usage.apiTurns),
  };
}

function collectArtifacts(
  artifacts: readonly (GraphWorkflowValidationReviewArtifact | null)[],
): { references: string[]; usage: ValidationRoundUsage | null } {
  const references: string[] = [];
  let usage: ValidationRoundUsage | null = null;
  for (const artifact of artifacts) {
    if (artifact == null) continue;
    if (!references.includes(artifact.ref)) references.push(artifact.ref);
    usage = addUsage(usage, artifact);
  }
  return { references, usage };
}

/**
 * The roster of a concluded round: the seats that reported, then the seats an
 * incident says the round lost. Reporting order comes first because it is the
 * only order the record preserves; a seat that never reported has no place in
 * it and is named after, rather than left out.
 */
function rosterOfRecord(
  record: Timestamped<GraphWorkflowValidationResultEvent>,
  lostSeats: readonly string[],
): string[] {
  const roster = (record.specialists ?? []).map(
    (specialist) => specialist.assignmentId,
  );
  for (const seat of lostSeats) {
    if (!roster.includes(seat)) roster.push(seat);
  }
  return roster;
}

/**
 * The seats each round is known to have frozen but that never reported, keyed
 * by seq. A round-level incident names no seat, so it contributes nothing.
 *
 * A `round_superseded` incident contributes nothing either, whatever seat it
 * names. Every other incident is written INTO the round record — the engine
 * folds it in only after finding that record still carrying the seq, which is
 * what makes the seq name one round rather than a number. `round_superseded` is
 * the incident published when that check FAILS: the record has moved on, and
 * the seq the incident carries is the one the lane set out with, not the one
 * the record now wears. A context reset is that failure at its widest — it
 * clears the record and the attempt restarts the numbering, so a validator
 * still running from before the reset answers into a seq now worn by a round it
 * was never on. Reading it as roster evidence would seat a retired round's
 * reviewer on a current round, and nothing in the record can tell the two
 * apart.
 */
function seatsLostByRound(
  incidentEvents: readonly Timestamped<GraphWorkflowValidationIncidentEvent>[],
): Map<number, string[]> {
  const lost = new Map<number, string[]>();
  for (const incident of incidentEvents) {
    if (incident.incident === "round_superseded") continue;
    const assignmentId = incident.assignmentId;
    if (assignmentId === null) continue;
    const seats = lost.get(incident.roundSeq);
    if (seats === undefined) lost.set(incident.roundSeq, [assignmentId]);
    else if (!seats.includes(assignmentId)) seats.push(assignmentId);
  }
  return lost;
}

/**
 * Whether this row is the round that raised an advisory — asked of the record,
 * never of the number.
 *
 * An advisory's identity names a round by seq, and a seq names a round only
 * inside one attempt at the context: a reset restarts the numbering, and the
 * record carries no attempt identity to tell the two round 1s apart. What CAN
 * be told apart is the advisory itself. The round that raised it is holding it,
 * in the aggregate that concluded it or in the live record; a round that is not
 * holding it did not raise it, whatever number it wears.
 */
export function roundRaisedAdvisory(
  row: ValidationRoundRow,
  advisory: WorkflowAdvisoryIdentity,
): boolean {
  const isTheOne = (candidate: { identity: WorkflowAdvisoryIdentity }) =>
    candidate.identity.roundSeq === advisory.roundSeq &&
    candidate.identity.assignmentId === advisory.assignmentId &&
    candidate.identity.ordinal === advisory.ordinal;

  const raisedInAggregate = (row.record?.specialists ?? []).some((seat) =>
    seat.advisories.some(isTheOne),
  );
  if (raisedInAggregate) return true;
  if (row.live === null) return false;
  return Object.values(row.live.specialists).some((seat) =>
    seat.advisories.some(isTheOne),
  );
}

export function deriveValidationRoundRows({
  execution,
  contextId,
  validationEvents,
  incidentEvents = [],
  iteration,
}: {
  execution: GraphWorkflowExecution;
  contextId: string;
  /** Concluded aggregates for this context, newest first. */
  validationEvents: readonly Timestamped<GraphWorkflowValidationResultEvent>[];
  /** This context's validation incidents, used to recover lost roster seats. */
  incidentEvents?: readonly Timestamped<GraphWorkflowValidationIncidentEvent>[];
  /**
   * The context's iteration timeline, from the conversation history model — the
   * same reader the rows above use, so a round and the conversation that hosted
   * it can never name different iterations.
   */
  iteration: ContextIterationReader;
}): readonly ValidationRoundRow[] {
  const lostSeats = seatsLostByRound(incidentEvents);
  const rows = new Map<number, ValidationRoundRow>();

  const live = execution.contextStates[contextId]?.validationRound ?? null;
  if (live !== null) {
    const status = statusOfOutcome(live.outcome);
    const { references, usage } = collectArtifacts(
      live.roster.map(
        (seat) => live.specialists[seat.assignmentId]?.reviewArtifact ?? null,
      ),
    );
    rows.set(live.seq, {
      seq: live.seq,
      // The live round is runtime state: it has no place in the log, so it is
      // read at the iteration standing now.
      iteration: iteration.now(),
      status,
      statusLabel: STATUS_LABEL[status],
      roster: live.roster.map((seat) => seat.assignmentId),
      references,
      usage,
      live,
      record: null,
    });
  }

  for (const record of validationEvents) {
    // A publication that belongs to no round (an output-schema refusal, a row
    // written before rounds existed) has no round to file under; it is shown by
    // the cards, not counted as a round here.
    const seq = record.roundSeq;
    if (seq == null) continue;
    const existing = rows.get(seq);
    if (existing !== undefined) {
      // One round, one row. A round that concluded twice — a seat reset and
      // re-run under the same seq — is the same round judged again, and the
      // newest telling of it is the one the caller listed first.
      if (existing.record === null) existing.record = record;
      continue;
    }
    const { references, usage } = collectArtifacts([
      record.reviewArtifact ?? null,
      ...(record.specialists ?? []).map(
        (specialist) => specialist.reviewArtifact,
      ),
    ]);
    rows.set(seq, {
      seq,
      iteration: iteration.atLogIndex(record.logIndex),
      status: record.pass ? "passed" : "rejected",
      statusLabel: record.pass ? STATUS_LABEL.passed : STATUS_LABEL.rejected,
      roster: rosterOfRecord(record, lostSeats.get(seq) ?? []),
      references,
      usage,
      live: null,
      record,
    });
  }

  // Newest first; inside one attempt at the context seq IS chronological.
  return [...rows.values()].sort((left, right) => right.seq - left.seq);
}
