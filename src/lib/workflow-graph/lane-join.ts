import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { routeUpstreamContextIds } from "./execution-routes";
import {
  isUpstreamVisibleToLane,
  landGatedPublishSettlement,
  reachableLanesFrom,
} from "./lane-readiness";
import { executionLaneIdFor } from "./lane-identity";
import { joinLeavesOpenLoop, openLoopLanes } from "./lane-lifecycle";
import type { RoutePublishSettlement } from "./route-projection";

type PlanningDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export interface PlanContextJoinInput {
  contextId: string;
  execution: GraphWorkflowExecution;
  definition?: PlanningDefinition;
  now(): string;
  generateJoinId(): string;
}

export interface PlanFinalPublishJoinInput {
  execution: GraphWorkflowExecution;
  sessionLaneId: string;
  now(): string;
  generateJoinId(): string;
}

export interface MaterializeSessionLaneInput {
  sessionLaneId: string;
  branchName: string;
  worktreePath: string;
  now(): string;
}

function freezeSourceLaneContextIds(
  execution: GraphWorkflowExecution,
  sourceLaneIds: readonly string[],
): Record<string, string[]> {
  return Object.fromEntries(
    sourceLaneIds.map((laneId) => [
      laneId,
      [...new Set(execution.executionLanes[laneId]?.includedContextIds ?? [])],
    ]),
  );
}

/**
 * Which lane a join merges INTO.
 *
 * The authored target when the downstream's lane already exists: placement is
 * the lane authority, so the join's job is to deliver the upstream work where
 * the downstream is going to run, not to pick a convenient branch. Recency used
 * to decide this, and recency is not an authority — it made the destination a
 * function of when lanes happened to be touched (decision D5).
 *
 * When the authored lane has no record yet there is nothing to merge into, so
 * the sources converge on one of themselves and the new lane forks from the
 * result. That choice is by lane id ascending, deterministic so a resume and a
 * replay converge on the same answer.
 */
export function pickJoinTarget(
  sourceLaneIds: readonly string[],
  execution: GraphWorkflowExecution,
  authoredTargetLaneId?: string,
): string {
  if (sourceLaneIds.length === 0) {
    throw new Error("pickJoinTarget requires at least one source lane id");
  }
  if (
    authoredTargetLaneId !== undefined &&
    execution.executionLanes[authoredTargetLaneId] !== undefined
  ) {
    return authoredTargetLaneId;
  }
  const candidates = sourceLaneIds
    .map((laneId) => ({
      laneId,
      lane: execution.executionLanes[laneId],
    }))
    .filter(
      (
        entry,
      ): entry is { laneId: string; lane: GraphWorkflowExecutionLaneState } =>
        entry.lane !== undefined,
    );
  if (candidates.length === 0) return sourceLaneIds[0]!;

  candidates.sort((a, b) =>
    a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0,
  );
  return candidates[0]!.laneId;
}

/**
 * Plan the join that makes a downstream's upstream work reachable from the lane
 * it was AUTHORED onto (decision D5). Returns null when no merge is owed.
 *
 * Defined relative to the target, not to the count of sources. For an existing
 * target lane, every upstream lane whose work is not already visible from that
 * exact lane is a source — including a single one, which the old two-source
 * minimum silently dropped, stranding a downstream whose one upstream ran
 * somewhere else. An upstream that ran ON the target lane is already in the
 * shared worktree and is never a source (R3.2): merging a branch into itself
 * would buy the downstream nothing but a wait.
 *
 * For a target lane that does not exist yet, a join is owed only when several
 * unmerged sources have to converge before the lane can fork from a branch that
 * carries all of them; a single source is simply the fork base.
 *
 * Terminal downstreams (contexts with no outgoing graph edges) receive a
 * context_merge like any other fan-in, so their work runs on the converged
 * worktree lane BEFORE the final publish. This supersedes accepted design
 * decision 9 ("final verification runs after publish"), which predates the
 * delivery gate: final publish is the delivery point, so deferring a
 * terminal context until after publish lets a candidate that structurally
 * excludes that context's work merge (ticket #28 / F25).
 */
export function planContextJoin(
  input: PlanContextJoinInput,
): GraphWorkflowExecutionJoinState | null {
  const { contextId, execution, now, generateJoinId } = input;
  const definition = input.definition ?? execution.workingDefinition;

  // Projection-resolved, not raw edges (decision D1): the lanes that have to
  // converge are the lanes of the ACTIVE incoming edges' EFFECTIVE sources. A
  // skipped branch contributes no merge input (R4), so counting its lane would
  // plan a join over work that is never going to arrive.
  const upstreamIds = routeUpstreamContextIds(execution, contextId, definition);

  const authoredLane = definition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement.lane;
  const authoredTargetLaneId =
    authoredLane === undefined ? undefined : executionLaneIdFor(authoredLane);
  const targetExists =
    authoredTargetLaneId !== undefined &&
    execution.executionLanes[authoredTargetLaneId] !== undefined;

  const sourceLaneIds = new Set<string>();
  for (const upstreamId of upstreamIds) {
    const upstream = execution.contextStates[upstreamId];
    if (!upstream || upstream.laneId === null) continue;
    if (targetExists) {
      // Reachable-lane intersection is a VISIBILITY predicate now, never a
      // placement chooser: it says whether this source's work already sits in
      // the target's history, and nothing about where the downstream runs.
      if (upstream.laneId === authoredTargetLaneId) continue;
      if (
        isUpstreamVisibleToLane(upstreamId, authoredTargetLaneId, execution)
      ) {
        continue;
      }
    }
    sourceLaneIds.add(upstream.laneId);
  }
  if (sourceLaneIds.size === 0) return null;

  const laneIdsArray = [...sourceLaneIds];
  if (!targetExists) {
    // No lane to merge into: a single source is the fork base, so nothing is
    // owed. Several sources converge only if no succeeded join already gives
    // them a common reachable target for the fork to branch from.
    if (laneIdsArray.length < 2) return null;
    const [first, ...rest] = laneIdsArray;
    if (!first) return null;
    const firstReachable = reachableLanesFrom(first, execution);
    for (const candidate of firstReachable) {
      if (
        rest.every((laneId) =>
          reachableLanesFrom(laneId, execution).has(candidate),
        )
      ) {
        return null;
      }
    }
  }

  const targetLaneId = pickJoinTarget(
    laneIdsArray,
    execution,
    authoredTargetLaneId,
  );

  // A lane holding an unconcluded loop body is not quiescent (lwp R10, decision
  // D11): later passes materialize onto it after this scheduling pass, so
  // merging its work AWAY now would consume a branch the loop is still writing,
  // and the membership freeze the intent stamps would leave those passes with
  // nowhere to land. Deferring is safe: loop conclusion is driven by the loop's
  // own settlement, never by this join, so it is planned on a later pass.
  //
  // Scoped to joins that leave the loop. A body member on one lane feeding a
  // body member on another needs a real merge on every pass, and refusing that
  // would deadlock the loop on its own dataflow.
  if (joinLeavesOpenLoop(execution, targetLaneId, laneIdsArray)) {
    return null;
  }

  // The target is one of the join's own sources: `remainingSourceLanes` filters
  // it back out for the merge itself, while `findBusyJoinSourceLaneIds` still
  // sees it — a target holding a live turn must defer the merge like any other
  // busy lane.
  if (!laneIdsArray.includes(targetLaneId)) laneIdsArray.push(targetLaneId);
  const timestamp = now();
  return {
    joinId: generateJoinId(),
    kind: "context_merge" satisfies GraphWorkflowExecutionJoinKind,
    contextId,
    targetLaneId,
    sourceLaneIds: laneIdsArray,
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    sourceLaneContextIds: freezeSourceLaneContextIds(execution, laneIdsArray),
    validationEvidence: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

/**
 * Contexts whose planned work has not fully run: fewer completed tasks than
 * total tasks. Task-based on purpose — a context whose status lags behind its
 * finished tasks (e.g. parked awaiting collaboration delivery) is legitimately
 * done, while a never-started context holds unfinished work no lane can carry
 * yet. This is the same predicate the execution loop's completion invariant
 * uses to refuse `completed`, so publish-safety and completion-safety cannot
 * drift apart.
 *
 * A route-skipped context is exempt (D4 R4.1): its branch was not taken, so its
 * tasks are not unfinished work — they are work the routing decided never
 * happens. Counting them would hold every conditional execution open forever on
 * a debt nothing can ever pay.
 *
 * The exemption is READ OFF the LAND-GATED publish settlement, not off the
 * persisted status (decision D1): between a guard resolving false and the
 * settlement pass that persists the skip — across a restart, say — the routing
 * has already decided, and a status-only reading would strand the run on a
 * context that never executes. It is land-gated because the reverse error is
 * just as real: a source whose fan-in merge is pending or failed blocks its
 * dependents rather than skipping them (R2.5), so exempting them before the
 * merge resolves would let the run converge around a branch still in play.
 */
export function findContextsWithUnfinishedTasks(
  execution: GraphWorkflowExecution,
  publish: RoutePublishSettlement = landGatedPublishSettlement(execution),
): GraphWorkflowExecutionContextState[] {
  const skipped = new Set(publish.skippedContextIds);
  return Object.values(execution.contextStates).filter(
    (state) =>
      !skipped.has(state.contextId) &&
      state.completedTaskCount < state.totalTaskCount,
  );
}

/**
 * Collect lanes that contain partial or unvalidated context work. This
 * join/publication safety predicate is intentionally broader than the
 * scheduler's lane-busy check: every unsettled context blocks a merge,
 * including parked and halted contexts that do not have a live agent turn.
 *
 * "Unsettled" is the land-gated publish settlement (decision D1): a context is
 * settled when it contributed (completed) or when the routing declined it AND
 * the source of that decision landed. A settled-declined context owes no task,
 * validator, approval or output debt and contributes no merge input, so it can
 * never be the reason a lane holds partial work — including in the window
 * before its skip is persisted.
 */
function collectLanesWithIncompleteContextWork(
  execution: GraphWorkflowExecution,
  publish: RoutePublishSettlement,
): Set<string> {
  const settled = new Set([
    ...publish.contributingContextIds,
    ...publish.skippedContextIds,
  ]);
  const laneIds = new Set<string>();
  for (const state of Object.values(execution.contextStates)) {
    if (state.laneId === null) continue;
    if (settled.has(state.contextId)) continue;
    laneIds.add(state.laneId);
  }
  return laneIds;
}

/**
 * Return the join's source lanes that cannot be merged without consuming
 * partial or unvalidated context work.
 */
export function findBusyJoinSourceLaneIds(
  join: GraphWorkflowExecutionJoinState,
  execution: GraphWorkflowExecution,
): string[] {
  const incompleteLaneIds = collectLanesWithIncompleteContextWork(
    execution,
    landGatedPublishSettlement(execution),
  );
  const seen = new Set<string>();
  const busyLaneIds: string[] = [];

  for (const laneId of join.sourceLaneIds) {
    if (seen.has(laneId)) continue;
    seen.add(laneId);
    if (incompleteLaneIds.has(laneId)) {
      busyLaneIds.push(laneId);
    }
  }

  return busyLaneIds;
}

/**
 * Plan the final publish join over the *terminal* unpublished worktree lanes.
 *
 * A non-session lane is **terminal** when no succeeded context_merge join has
 * consumed it as a source into a different target lane. Once `lane-b -> lane-a`
 * succeeds, lane-b's output already lives on lane-a, so the final publish
 * publishes only lane-a — re-merging lane-b would replay already-consumed work.
 *
 * A terminal lane is **unpublished** when it does not reach the session lane
 * via a succeeded prior join (final or context).
 *
 * Returns null when nothing terminal remains to publish, and refuses to plan
 * at all while any context still has unfinished tasks: the final publish is
 * the delivery point, so publishing around outstanding work would deliver a
 * candidate that structurally excludes it (ticket #28 / F25). A stuck context
 * then surfaces through the loop's completion invariant as a halt instead of
 * an incomplete delivery.
 *
 * Both refusals read the SAME land-gated publish settlement, derived once here
 * (D4 R4.1/R2.5, decision D1), so what the publish waits on and what it
 * excludes cannot disagree.
 */
export function planFinalPublishJoin(
  input: PlanFinalPublishJoinInput,
): GraphWorkflowExecutionJoinState | null {
  const { execution, sessionLaneId, now, generateJoinId } = input;
  const publish = landGatedPublishSettlement(execution);

  if (findContextsWithUnfinishedTasks(execution, publish).length > 0) {
    return null;
  }

  const consumedLaneIds = new Set<string>();
  for (const join of Object.values(execution.joins ?? {})) {
    if (join.status !== "succeeded") continue;
    if (join.kind !== "context_merge") continue;
    for (const sourceLaneId of join.sourceLaneIds) {
      if (sourceLaneId === join.targetLaneId) continue;
      consumedLaneIds.add(sourceLaneId);
    }
  }

  // An interrupted parallel wave reset to `ready` still occupies its forked
  // lane; publishing it would land half-finished work and let the loop
  // converge to completion with the context's remaining tasks dropped.
  const lanesWithIncompleteWork = collectLanesWithIncompleteContextWork(
    execution,
    publish,
  );

  // Between two passes every materialized context reads complete, so the
  // unfinished-task guard above cannot see a loop that is about to unroll again.
  // The lane it will unroll onto is not quiescent until the loop concludes (lwp
  // R10, decision D11). Unscoped here, unlike the context join above: the final
  // publish always leaves every loop, so a loop-open lane is never publishable.
  const loopOpen = openLoopLanes(execution).all;

  const unpublishedSources: string[] = [];
  for (const lane of Object.values(execution.executionLanes)) {
    if (lane.laneId === sessionLaneId) continue;
    if (lane.kind === "session") continue;
    if (consumedLaneIds.has(lane.laneId)) continue;
    if (lanesWithIncompleteWork.has(lane.laneId)) continue;
    if (loopOpen.has(lane.laneId)) continue;
    const reachable = reachableLanesFrom(lane.laneId, execution);
    if (reachable.has(sessionLaneId)) continue;
    unpublishedSources.push(lane.laneId);
  }
  if (unpublishedSources.length === 0) return null;

  unpublishedSources.sort();
  const timestamp = now();
  return {
    joinId: generateJoinId(),
    kind: "final_publish" satisfies GraphWorkflowExecutionJoinKind,
    contextId: null,
    targetLaneId: sessionLaneId,
    sourceLaneIds: unpublishedSources,
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    sourceLaneContextIds: freezeSourceLaneContextIds(
      execution,
      unpublishedSources,
    ),
    validationEvidence: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}

export function appendPendingJoin(
  execution: GraphWorkflowExecution,
  join: GraphWorkflowExecutionJoinState,
): GraphWorkflowExecution {
  // Link the pending join back onto the downstream context state so UI wait
  // derivation can recognize "waiting-for-join" without the join target
  // having to inspect every join record. Only context_merge joins have a
  // specific target context; final_publish joins have `contextId === null`
  // and so do not project onto any single context's joinId field.
  const contextStates =
    join.contextId !== null && execution.contextStates[join.contextId]
      ? {
          ...execution.contextStates,
          [join.contextId]: {
            ...execution.contextStates[join.contextId]!,
            joinId: join.joinId,
          },
        }
      : execution.contextStates;

  return {
    ...execution,
    joins: {
      ...execution.joins,
      [join.joinId]: join,
    },
    contextStates,
  };
}

export function findActiveJoin(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecutionJoinState | null {
  for (const join of Object.values(execution.joins ?? {})) {
    if (join.status === "pending" || join.status === "running") {
      return join;
    }
  }
  return null;
}

export function remainingSourceLanes(
  join: GraphWorkflowExecutionJoinState,
): string[] {
  const merged = new Set(join.mergedSourceLaneIds);
  return join.sourceLaneIds.filter(
    (laneId) => laneId !== join.targetLaneId && !merged.has(laneId),
  );
}

/**
 * Resolve the conversation a join merge's agent sub-turns (conflict
 * resolution, validation fixes) should bind to for a source lane: the
 * implementer conversation of the lane's most recent context. That
 * conversation is idle by the time the lane joins (its contexts completed)
 * and its actor is already bound to the lane's worktree — unlike the
 * session's most-recently-active conversation, which in a parallel workflow
 * may belong to a different lane that is still running, dispatching the
 * resolver into the wrong worktree.
 *
 * Candidate contexts are checked most-recent-first: the lane's last
 * committing context, then `includedContextIds` newest-first. Per context the
 * implementer lane state's `workflowConversationId` wins; task states'
 * `lastConversationId` (highest order first) is the fallback. Returns null
 * when the lane recorded no conversation — callers fall back to the session
 * heuristic.
 */
export function resolveLaneConversationId(
  execution: GraphWorkflowExecution,
  laneId: string,
): string | null {
  const lane = execution.executionLanes[laneId];
  if (!lane) return null;

  const candidateContextIds: string[] = [];
  if (lane.lastCommittingContextId) {
    candidateContextIds.push(lane.lastCommittingContextId);
  }
  for (const contextId of [...lane.includedContextIds].reverse()) {
    if (!candidateContextIds.includes(contextId)) {
      candidateContextIds.push(contextId);
    }
  }

  for (const contextId of candidateContextIds) {
    const laneStatesByKind = execution.laneStates[contextId];
    if (laneStatesByKind) {
      for (const state of Object.values(laneStatesByKind)) {
        if (state.lane === "implementer" && state.workflowConversationId) {
          return state.workflowConversationId;
        }
      }
    }

    const taskConversationId = Object.values(execution.taskStates)
      .filter(
        (task) =>
          task.contextId === contextId && task.lastConversationId !== null,
      )
      .sort((a, b) => b.order - a.order)[0]?.lastConversationId;
    if (taskConversationId) return taskConversationId;
  }

  return null;
}

export function materializeSessionLane(
  execution: GraphWorkflowExecution,
  input: MaterializeSessionLaneInput,
): GraphWorkflowExecution {
  if (execution.executionLanes[input.sessionLaneId]) return execution;
  const timestamp = input.now();
  const lane: GraphWorkflowExecutionLaneState = {
    laneId: input.sessionLaneId,
    kind: "session",
    status: "active",
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    // The session lane admits only read-only members, which write nothing and
    // land nothing, so no drift check ever consults this.
    ignoredBaseline: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ...execution,
    executionLanes: {
      ...execution.executionLanes,
      [input.sessionLaneId]: lane,
    },
  };
}
