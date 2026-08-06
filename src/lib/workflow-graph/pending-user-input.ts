/**
 * Reading a context's parked questions.
 *
 * The parked records are keyed by lane key because a cohort's validators ask
 * independently — several lanes can be waiting on the human at once, and an
 * answer belongs to the lane that asked it. Every consumer that used to read a
 * single slot now has to say WHICH of those questions it means, so the two
 * questions worth asking about a park live here rather than being re-derived at
 * each reader: which lanes are still waiting, and whether the wait is over.
 *
 * Deliberately pure and dependency-free: the graph inspector reads these in the
 * browser, and the engine reads them inside write-queue reducers.
 */

import { parseLaneStateKey } from "@/lib/workflow-graph/lane-identity";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowLaneKind,
  GraphWorkflowPendingUserInput,
} from "@/lib/workflow-graph/schemas";

/** One lane's parked record, with the identity its key encodes. */
export interface PendingUserInputEntry {
  laneKey: string;
  lane: GraphWorkflowLaneKind;
  /** Null for the implementer, whose lane is not assignment-scoped. */
  assignmentId: string | null;
  record: GraphWorkflowPendingUserInput;
}

/**
 * Every parked record on a context, in lane-key order.
 *
 * Sorted rather than left in insertion order so two contexts that parked the
 * same cohort in a different sequence present their questions identically —
 * the operator's list of questions is not a record of who happened to ask first.
 */
export function pendingUserInputEntries(
  contextState: Pick<GraphWorkflowExecutionContextState, "pendingUserInputs">,
): PendingUserInputEntry[] {
  const entries: PendingUserInputEntry[] = [];
  for (const [laneKey, record] of Object.entries(
    contextState.pendingUserInputs,
  )) {
    const identity = parseLaneStateKey(laneKey);
    if (identity === null) continue;
    entries.push({
      laneKey,
      lane: identity.lane,
      assignmentId: identity.assignmentId,
      record,
    });
  }
  return entries.sort((left, right) =>
    left.laneKey.localeCompare(right.laneKey),
  );
}

/** The lanes still waiting on the human — parked with no answers recorded. */
export function unansweredPendingUserInputs(
  contextState: Pick<GraphWorkflowExecutionContextState, "pendingUserInputs">,
): PendingUserInputEntry[] {
  return pendingUserInputEntries(contextState).filter(
    (entry) => entry.record.answers === null,
  );
}

/**
 * The lanes whose answers have landed and are waiting to be delivered.
 *
 * An answer resumes its OWN lane the moment it arrives: a cohort's lanes review
 * independently, so holding an answered lane until every sibling has also been
 * answered would make the slowest question the pace of the whole cohort (R9.1).
 */
export function answeredPendingUserInputs(
  contextState: Pick<GraphWorkflowExecutionContextState, "pendingUserInputs">,
): PendingUserInputEntry[] {
  return pendingUserInputEntries(contextState).filter(
    (entry) => entry.record.answers !== null,
  );
}

/** Conversations holding a parked question, across every context. */
export function parkedQuestionConversationIds(
  execution: Pick<GraphWorkflowExecution, "contextStates">,
): Set<string> {
  const ids = new Set<string>();
  for (const contextState of Object.values(execution.contextStates)) {
    for (const entry of pendingUserInputEntries(contextState)) {
      ids.add(entry.record.conversationId);
    }
  }
  return ids;
}
