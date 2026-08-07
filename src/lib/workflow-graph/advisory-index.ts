/**
 * The execution-level advisory index: which advisories outlive their round, and
 * how one seat's slice of the index is kept in step with what that seat reports.
 *
 * Maintained at the write that STAMPS a lane's advisories rather than at the
 * round's conclusion, because the index answers "what has anyone observed in
 * this run" — an observation a failing round raised is no less true for the
 * round having failed. That write can happen twice for one seat inside one round
 * (a lane re-dispatched after an infrastructure failure re-stamps ordinals
 * 1..n), so the update replaces the seat's slice instead of appending to it: the
 * seat's latest report is the whole truth about that seat.
 *
 * Pure. The record it projects from is the orchestrator's round record, and the
 * list it maintains lives on the execution.
 */

import type {
  GraphWorkflowAdvisoryIndexEntry,
  GraphWorkflowValidationAdvisory,
} from "@/lib/workflow-graph/schemas";

/**
 * The advisory kinds that outlive the round that raised them, expressed as the
 * one exclusion rather than as a list: an `implementation` advisory is about the
 * work under review and is disposed of inside that round, while everything else
 * is about something no task in the round owns and has nowhere else to be
 * recorded. Written this way so a new advisory kind fails to compile here until
 * someone decides whether it outlives its round.
 */
function toIndexEntry(
  advisory: GraphWorkflowValidationAdvisory,
  contextId: string,
): GraphWorkflowAdvisoryIndexEntry | null {
  if (advisory.kind === "implementation") return null;
  return {
    identity: { ...advisory.identity },
    kind: advisory.kind,
    title: advisory.title,
    contextId,
  };
}

/**
 * The index with ONE seat's entries replaced by what that seat now reports.
 *
 * Everything raised by another seat, another round, or another context is
 * carried through untouched and in order — the index is append-ordered so a
 * reader sees observations in the order the run made them.
 */
export function indexAdvisoriesForSeat(input: {
  index: readonly GraphWorkflowAdvisoryIndexEntry[];
  contextId: string;
  roundSeq: number;
  assignmentId: string;
  advisories: readonly GraphWorkflowValidationAdvisory[];
}): GraphWorkflowAdvisoryIndexEntry[] {
  const retained = input.index.filter(
    (entry) =>
      !(
        entry.contextId === input.contextId &&
        entry.identity.roundSeq === input.roundSeq &&
        entry.identity.assignmentId === input.assignmentId
      ),
  );
  const projected: GraphWorkflowAdvisoryIndexEntry[] = [];
  for (const advisory of input.advisories) {
    const entry = toIndexEntry(advisory, input.contextId);
    if (entry !== null) projected.push(entry);
  }
  return [...retained, ...projected];
}
