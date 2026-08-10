/**
 * The lane lifecycle: when a lane still accepts members, and when it has
 * committed to a landing and stopped (R10, decision D11).
 *
 * A group lane is one worktree and one branch shared by every member, landed by
 * one fan-in join. That makes membership a bounded thing: once a join intent
 * names the lane as a source it will consume, the lane's content has been
 * promised to a merge, and a context added afterwards would either miss the
 * merge entirely or reshape work already committed to it. So membership FREEZES
 * at join intent, and dynamic work — D4 expansion, live edits — that arrives
 * after the freeze targets a NEW lane instead. There is no reopen verb in v1.
 *
 * The loop exception is what makes that rule survive contact with D4 loops.
 * Later passes materialize only after the previous one runs, so a freeze that
 * could fire between two passes would strand pass K+1 outside the lane its
 * template authored. A lane holding an unconcluded loop body is therefore never
 * quiescent for join planning: it does not accept a join intent at all until the
 * loop concludes, and freeze-at-intent applies from conclusion onward. Pass
 * instances inherit the template's placement by cloning, so they need no
 * placement decision of their own — they join the lane that is still open.
 *
 * Closure is derived, never stamped: it is read off the join ledger and the lane
 * record, the two places that already witness a lane's commitment to land. A
 * separate flag would be a third source of truth to keep in sync across resume,
 * replay, and plan repair.
 */

import { executionLaneIdFor, SESSION_LANE_ID } from "./lane-identity";
import { findLoopBodyMembership } from "./loop-resolver";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The typed refusal a placement onto a closed lane is answered with, shared by
 * every mutation surface so a lane agent, an operator, and the plan-repair
 * supervisor all read the same code.
 */
export const LANE_CLOSED_CODE = "lane_closed";

/**
 * Why a lane stopped accepting members. All three are terminal for membership;
 * they differ only in what evidence closed it, which is what the refusal message
 * tells the caller so it can decide whether to wait or to target a new lane.
 *
 * `join_planned` — a join intent names the lane as a source and has not yet
 * consumed it (pending, running, or failed: a failed join is repaired and
 * retried against the same promised content, never abandoned).
 * `joined` — that join succeeded; the lane's work already lives in the target.
 * `disposed` — the lane's own record says it is retired.
 */
export type LaneClosureReason = "join_planned" | "joined" | "disposed";

export interface LaneClosure {
  /** The RUNTIME lane id, which differs from the authored name only for the session lane. */
  readonly laneId: string;
  readonly reason: LaneClosureReason;
}

/**
 * Whether `laneName` — an AUTHORED placement lane — still accepts new members,
 * and why not when it does not.
 *
 * The join's own TARGET is deliberately not closed by its own intent. A target
 * is where the merged work is delivered TO and where the downstream context then
 * runs; its content is still growing, and closing it would freeze the lane every
 * fan-in converges on, which is exactly where an expanding agent's follow-up
 * work belongs. `planContextJoin` lists the target among `sourceLaneIds` so busy
 * checks can see it, so the comparison here is against `targetLaneId` rather
 * than against membership in that array.
 */
export function laneClosure(
  execution: GraphWorkflowExecution,
  laneName: string,
): LaneClosure | null {
  return laneClosureFromPin(execution, pinLaneClosure(execution, laneName));
}

/**
 * The DEFINITION-derived half of the closure above: which unconcluded loops
 * claim this lane's membership. Deriving it walks the loop templates and the
 * context list, so a caller that has already fenced the definition — the
 * mutation staging seam, which must re-derive closure inside the write queue —
 * pins this once outside the lock and re-checks in O(this lane's loop groups).
 *
 * Only the group IDS are pinned, never the verdict. A group open when pinned can
 * conclude before the check; a concluded one never reopens, so re-reading the
 * pinned groups' activation reproduces {@link openLoopLanes} exactly for this
 * lane, without the walk.
 */
export interface LaneClosurePin {
  /** The AUTHORED lane name, kept for the refusal message. */
  readonly lane: string;
  /** The RUNTIME lane id, which differs from the authored name only for the session lane. */
  readonly laneId: string;
  /** Loops that were unconcluded at pin time and place a body member on this lane. */
  readonly loopGroupIds: readonly string[];
}

export function pinLaneClosure(
  execution: GraphWorkflowExecution,
  laneName: string,
): LaneClosurePin {
  const laneId = executionLaneIdFor(laneName);
  return {
    lane: laneName,
    laneId,
    loopGroupIds: openLoopLanes(execution)
      .byGroup.filter((group) => group.laneIds.has(laneId))
      .map((group) => group.loopGroupId),
  };
}

/**
 * The RUNTIME half: read a lane's closure against a pin. Same verdict as
 * {@link laneClosure}, which is defined in terms of it — there is one lifecycle
 * policy, not two.
 */
export function laneClosureFromPin(
  execution: GraphWorkflowExecution,
  pin: LaneClosurePin,
): LaneClosure | null {
  const { laneId } = pin;

  // The loop exception: freeze-at-intent applies from loop CONCLUSION onward.
  // A loop body's lanes exchange work through intra-loop joins on every pass, so
  // letting one of those stamp the lane closed would strand every later pass.
  if (pin.loopGroupIds.some((groupId) => isLoopGroupOpen(execution, groupId))) {
    return null;
  }

  // Read the ledger before the lane record: a consuming join is the earlier and
  // more specific evidence, and it is what distinguishes "promised to a merge"
  // from "already merged" in the message the caller is refused with.
  for (const join of Object.values(execution.joins ?? {})) {
    if (join.targetLaneId === laneId) continue;
    if (!join.sourceLaneIds.includes(laneId)) continue;
    return {
      laneId,
      reason: join.status === "succeeded" ? "joined" : "join_planned",
    };
  }

  // `halted` is deliberately absent: a halted lane is resumed or repaired in
  // place, so its membership question is still open.
  if (execution.executionLanes[laneId]?.status === "merged") {
    return { laneId, reason: "disposed" };
  }

  return null;
}

/**
 * Whether a loop may still write another pass. `unstarted` counts as open: a
 * loop whose activation path has not been decided has passes ahead of it.
 */
function isLoopGroupOpen(
  execution: GraphWorkflowExecution,
  loopGroupId: string,
): boolean {
  const activation =
    execution.loopStates[loopGroupId]?.activation ?? "unstarted";
  return activation !== "concluded" && activation !== "skipped";
}

export interface OpenLoopLaneGroup {
  readonly loopGroupId: string;
  readonly laneIds: ReadonlySet<string>;
}

export interface OpenLoopLanes {
  /**
   * One lane set per unconcluded loop. Kept PER LOOP rather than flattened
   * because the interesting question is directional: whether a join stays inside
   * one loop's lanes or carries its work out of them.
   */
  readonly byGroup: readonly OpenLoopLaneGroup[];
  /** The union — every lane an unconcluded loop may still write another pass to. */
  readonly all: ReadonlySet<string>;
}

/**
 * The lanes holding a loop body whose loop has not concluded.
 *
 * Both spellings of a body member count. The TEMPLATE contexts are the authority
 * (every pass clones their placement), and the materialized `__p<K>__` instances
 * are read too so a placement a live edit moved on a live instance is honoured
 * rather than silently overruled by the template it forked from.
 *
 * A loop is open until its `until` predicate is satisfied (`concluded`) or its
 * activation path is declined (`skipped`). `unstarted` counts as open: a lane
 * whose loop may still activate has passes ahead of it that must land there.
 */
export function openLoopLanes(
  execution: GraphWorkflowExecution,
): OpenLoopLanes {
  const groups = execution.workingDefinition.loopGroups ?? [];
  const empty: OpenLoopLanes = { byGroup: [], all: new Set() };
  if (groups.length === 0) return empty;

  const openGroups = groups.filter((group) =>
    isLoopGroupOpen(execution, group.id),
  );
  if (openGroups.length === 0) return empty;

  const byGroupId = new Map<string, Set<string>>(
    openGroups.map((group) => [group.id, new Set<string>()]),
  );
  for (const group of openGroups) {
    const lanes = byGroupId.get(group.id);
    for (const context of group.template.contexts) {
      lanes?.add(executionLaneIdFor(context.placement.lane));
    }
  }
  for (const context of execution.workingDefinition.executionContexts) {
    const membership = findLoopBodyMembership(context.id, openGroups);
    if (membership === null) continue;
    byGroupId
      .get(membership.loopGroupId)
      ?.add(executionLaneIdFor(context.placement.lane));
  }

  // The session worktree is never a group lane and never lands through a join,
  // so it has no membership to hold open — and holding it open would defer the
  // final publish forever on a loop whose body reads from it.
  const byGroup: OpenLoopLaneGroup[] = [];
  const all = new Set<string>();
  for (const [loopGroupId, laneIds] of byGroupId) {
    laneIds.delete(SESSION_LANE_ID);
    byGroup.push({ loopGroupId, laneIds });
    for (const laneId of laneIds) all.add(laneId);
  }
  return { byGroup, all };
}

/**
 * Whether a join into `targetLaneId` would carry an unconcluded loop's work OUT
 * of that loop's own lanes.
 *
 * This is the distinction that keeps the lifecycle from deadlocking a loop whose
 * body spans several lanes. A body member on lane A feeding one on lane B needs
 * a real merge on EVERY pass, and that join is internal: both lanes belong to
 * the same open loop, and neither has finished being written. The join that must
 * wait is the one delivering the loop's result somewhere else — that is the
 * lane's landing join, and planning it before the last pass exists would consume
 * a branch the loop is still writing to.
 */
export function joinLeavesOpenLoop(
  execution: GraphWorkflowExecution,
  targetLaneId: string,
  sourceLaneIds: readonly string[],
): boolean {
  return openLoopLanes(execution).byGroup.some(
    ({ laneIds }) =>
      !laneIds.has(targetLaneId) &&
      sourceLaneIds.some(
        (laneId) => laneId !== targetLaneId && laneIds.has(laneId),
      ),
  );
}
