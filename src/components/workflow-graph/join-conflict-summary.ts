import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import { remainingSourceLanes } from "@/lib/workflow-graph/lane-join";
import { laneDisplayName } from "@/lib/workflow-graph/lane-bands";

/**
 * What a failed join looks like from the operator's side (E2's join card).
 *
 * A join failure is a RUNTIME state, not an approval: the recovery surface has
 * to say which members already landed, which one is blocked and why, so the
 * reader can tell "the merge needs a hand" from "the work was rejected".
 *
 * Per-source progress lives on `execution.joins[joinId]` and nowhere else —
 * `mergedSourceLaneIds` for what landed, `sourceLaneContextIds` for the frozen
 * membership, `errorMessage`/`conflicts` for why the runner stopped. The
 * per-CONTEXT merge fields cannot answer any of it: a `context_merge` join
 * stamps `joinId` on the downstream target alone and a `final_publish` join
 * stamps no context at all, so a summary read from context state reports a real
 * failure's source members as pending and finds no blocked member to navigate
 * to. The roster is therefore lane-first, expanded to the contexts each lane
 * carries because that is what the operator recognises.
 */

export type JoinMemberStatus = "merged" | "blocked" | "pending";

export interface JoinConflictMember {
  /** The source lane this member merged from — the unit the join tracks. */
  laneId: string;
  /**
   * The context to name and to navigate to. Null only when neither the frozen
   * membership map nor live lane state knows what the lane carried, in which
   * case the row falls back to naming the lane itself.
   */
  contextId: string | null;
  title: string;
  status: JoinMemberStatus;
  /** Why the runner stopped, on the blocked member. */
  detail: string | null;
}

export interface JoinConflictSummary {
  joinId: string;
  /**
   * The lane the members were merging INTO, by its DISPLAY name — what the
   * band header calls it. A final publish targets the session lane, whose id
   * (`__session__`) is not its name, and the canvas matches a band on this
   * value, so the raw id would both misname the lane and miss its band.
   */
  laneLabel: string;
  members: JoinConflictMember[];
  mergedCount: number;
  /**
   * The one member a recovery surface both NAMES and acts on.
   *
   * A blocked lane can carry several contexts, and the roster reports every one
   * of them blocked because none of them landed — but only one is worth sending
   * the operator to. Handing out the whole member rather than an id is what
   * keeps the sentence and the buttons on the same context: a surface that
   * looked the subject up for itself would pick the first blocked member while
   * navigating to this one.
   *
   * Null only when the join failed with no source lane to attribute it to.
   * `contextId` is null in the narrower case where the lane is known but
   * nothing can say what it carried; the title is then the lane's own id, and
   * there is no destination to offer.
   */
  blockedMember: JoinConflictMember | null;
  conflictFiles: string[];
}

/**
 * The contexts a source lane brought to this join.
 *
 * The join's own frozen map is authoritative — it proves which members the
 * original intent covered, while a lane's `includedContextIds` keeps changing —
 * and live lane state is the fallback for a join planned before the map existed.
 */
function laneContextIds(
  execution: GraphWorkflowExecution,
  join: GraphWorkflowExecutionJoinState | null,
  laneId: string,
): string[] {
  const frozen = join?.sourceLaneContextIds?.[laneId];
  if (frozen !== undefined && frozen.length > 0) return frozen;
  return execution.executionLanes[laneId]?.includedContextIds ?? [];
}

export function deriveJoinConflictSummary(
  execution: GraphWorkflowExecution,
  reason: GraphWorkflowHaltReason,
): JoinConflictSummary | null {
  if (reason.type !== "join_failure") return null;

  const join = execution.joins[reason.joinId] ?? null;
  const targetLaneId = join?.targetLaneId ?? reason.targetLaneId;
  // A lane can be both a source and the target of its own join; it has nothing
  // to merge into itself, so it is not a member the operator can act on.
  const sourceLaneIds = (join?.sourceLaneIds ?? reason.sourceLaneIds).filter(
    (laneId) => laneId !== targetLaneId,
  );
  const mergedLaneIds = new Set(join?.mergedSourceLaneIds ?? []);
  // The runner merges the remaining lanes in order and stops at the first
  // refusal, so exactly one lane is blocked and the ones behind it were never
  // attempted. `remainingSourceLanes` is that ordering's owner.
  const blockedLaneId =
    join === null
      ? (sourceLaneIds[0] ?? null)
      : (remainingSourceLanes(join)[0] ?? null);
  const blockedDetail = join?.errorMessage ?? join?.conflicts?.message ?? null;

  const members: JoinConflictMember[] = [];
  for (const laneId of sourceLaneIds) {
    const status: JoinMemberStatus = mergedLaneIds.has(laneId)
      ? "merged"
      : laneId === blockedLaneId
        ? "blocked"
        : "pending";
    const detail = status === "blocked" ? blockedDetail : null;
    const contextIds = laneContextIds(execution, join, laneId);
    if (contextIds.length === 0) {
      members.push({ laneId, contextId: null, title: laneId, status, detail });
      continue;
    }
    for (const contextId of contextIds) {
      const context = execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === contextId,
      );
      members.push({
        laneId,
        contextId,
        title: context?.title ?? contextId,
        status,
        detail,
      });
    }
  }

  // The context that last wrote into the blocked lane is the one whose worktree
  // holds the conflicting bytes and whose owned paths are worth narrowing; the
  // lane's last member is the fallback when nothing committed yet. The
  // lane-only member — no context id at all — is the last resort, so a surface
  // still has a subject to name even where it has nowhere to navigate.
  const blocked = members.filter((member) => member.status === "blocked");
  const navigable = blocked.filter((member) => member.contextId !== null);
  const lastCommitting =
    blockedLaneId === null
      ? null
      : (execution.executionLanes[blockedLaneId]?.lastCommittingContextId ??
        null);
  const blockedMember =
    navigable.find((member) => member.contextId === lastCommitting) ??
    navigable[navigable.length - 1] ??
    blocked[0] ??
    null;

  return {
    joinId: reason.joinId,
    laneLabel: laneDisplayName(targetLaneId),
    members,
    mergedCount: members.filter((member) => member.status === "merged").length,
    blockedMember,
    // The join's own record is the live one: a halt reason is a snapshot taken
    // when the run stopped, and a later resolution attempt rewrites the files.
    conflictFiles:
      join?.conflicts?.files !== undefined && join.conflicts.files.length > 0
        ? [...join.conflicts.files]
        : [...reason.conflictFiles],
  };
}
