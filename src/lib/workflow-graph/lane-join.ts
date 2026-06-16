import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import { reachableLanesFrom } from "./lane-readiness";

/**
 * Stable identifier for the implicit "session" lane that represents the
 * session worktree itself. We materialize a lane record under this id when
 * planning final publish joins so the graph's lane-reachability machinery
 * uniformly recognizes the session worktree as a join target.
 */
export const SESSION_LANE_ID = "__session__";

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

export interface ApplyJoinProgressPatch {
  status?: GraphWorkflowExecutionJoinState["status"];
  addMergedSourceLaneId?: string;
  errorMessage?: string | null;
  conflicts?: GraphWorkflowExecutionJoinState["conflicts"];
}

/**
 * Decide which existing source lane should become the target lane of a join.
 * The picker is deterministic so resumes and replays converge on the same
 * answer:
 *
 *  1. Prefer the source lane whose `updatedAt` is the most recent (we are
 *     most likely to find its worktree warm and its branch ahead).
 *  2. Break ties on lane id ascending.
 *
 * Source lanes without a corresponding execution lane record are skipped.
 * Returns the first source lane id when nothing else applies.
 */
export function pickJoinTarget(
  sourceLaneIds: readonly string[],
  execution: GraphWorkflowExecution,
): string {
  if (sourceLaneIds.length === 0) {
    throw new Error("pickJoinTarget requires at least one source lane id");
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

  candidates.sort((a, b) => {
    if (a.lane.updatedAt < b.lane.updatedAt) return 1;
    if (a.lane.updatedAt > b.lane.updatedAt) return -1;
    return a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0;
  });
  return candidates[0]!.laneId;
}

/**
 * Plan a context-level join. Returns a pending join record when the
 * downstream context has two or more distinct upstream source lanes that do
 * not already reach a common target via a succeeded join. Returns null when
 * no join is required.
 *
 * Terminal downstreams (contexts with no outgoing graph edges) never receive
 * a context_merge: per accepted design decision 9, a final verification
 * context that depends on multiple worktree lanes must run against the
 * post-publish session lane, not on a worktree target lane chosen by a
 * context_merge. Returning null here lets the loop fall through to
 * `planFinalPublishJoin`, which converges the unpublished worktree lanes
 * onto the session lane first.
 */
export function planContextJoin(
  input: PlanContextJoinInput,
): GraphWorkflowExecutionJoinState | null {
  const { contextId, execution, now, generateJoinId } = input;
  const definition = input.definition ?? execution.workingDefinition;

  const upstreamIds = definition.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => edge.sourceContextId);

  const sourceLaneIds = new Set<string>();
  for (const upstreamId of upstreamIds) {
    const upstream = execution.contextStates[upstreamId];
    if (!upstream || upstream.laneId === null) continue;
    sourceLaneIds.add(upstream.laneId);
  }
  if (sourceLaneIds.size < 2) return null;

  const hasOutgoingEdge = definition.edges.some(
    (edge) => edge.sourceContextId === contextId,
  );
  if (!hasOutgoingEdge) return null;

  // If the source lanes already reach a common target via succeeded joins
  // there is nothing to plan.
  const laneIdsArray = [...sourceLaneIds];
  const [first, ...rest] = laneIdsArray;
  if (!first) return null;
  const firstReachable = reachableLanesFrom(first, execution);
  const intersection = new Set<string>();
  for (const candidate of firstReachable) {
    if (
      rest.every((laneId) =>
        reachableLanesFrom(laneId, execution).has(candidate),
      )
    ) {
      intersection.add(candidate);
    }
  }
  if (intersection.size > 0) return null;

  const targetLaneId = pickJoinTarget(laneIdsArray, execution);
  const timestamp = now();
  return {
    joinId: generateJoinId(),
    kind: "context_merge" satisfies GraphWorkflowExecutionJoinKind,
    contextId,
    targetLaneId,
    sourceLaneIds: laneIdsArray,
    mergedSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
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
 * Returns null when nothing terminal remains to publish.
 */
export function planFinalPublishJoin(
  input: PlanFinalPublishJoinInput,
): GraphWorkflowExecutionJoinState | null {
  const { execution, sessionLaneId, now, generateJoinId } = input;

  const consumedLaneIds = new Set<string>();
  for (const join of Object.values(execution.joins ?? {})) {
    if (join.status !== "succeeded") continue;
    if (join.kind !== "context_merge") continue;
    for (const sourceLaneId of join.sourceLaneIds) {
      if (sourceLaneId === join.targetLaneId) continue;
      consumedLaneIds.add(sourceLaneId);
    }
  }

  // A lane whose currently-assigned context has not completed holds partial,
  // unvalidated work and must never be folded into the session via the final
  // publish. An interrupted parallel wave reset to `ready` still occupies its
  // forked lane; publishing it would land half-finished work and let the loop
  // converge to completion with the context's remaining tasks dropped.
  const lanesWithIncompleteWork = new Set<string>();
  for (const state of Object.values(execution.contextStates)) {
    if (state.laneId === null) continue;
    if (state.status === "completed") continue;
    lanesWithIncompleteWork.add(state.laneId);
  }

  const unpublishedSources: string[] = [];
  for (const lane of Object.values(execution.executionLanes)) {
    if (lane.laneId === sessionLaneId) continue;
    if (lane.kind === "session") continue;
    if (consumedLaneIds.has(lane.laneId)) continue;
    if (lanesWithIncompleteWork.has(lane.laneId)) continue;
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
    status: "pending",
    errorMessage: null,
    conflicts: null,
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

export function applyJoinProgress(
  execution: GraphWorkflowExecution,
  joinId: string,
  now: string,
  patch: ApplyJoinProgressPatch,
): GraphWorkflowExecution {
  const join = execution.joins[joinId];
  if (!join) {
    throw new Error(
      `applyJoinProgress: join ${JSON.stringify(joinId)} not found`,
    );
  }
  const mergedSourceLaneIds =
    patch.addMergedSourceLaneId &&
    !join.mergedSourceLaneIds.includes(patch.addMergedSourceLaneId)
      ? [...join.mergedSourceLaneIds, patch.addMergedSourceLaneId]
      : join.mergedSourceLaneIds;

  const status = patch.status ?? join.status;
  const completedAt =
    status === "succeeded" || status === "failed" || status === "conflicts"
      ? now
      : join.completedAt;

  return {
    ...execution,
    joins: {
      ...execution.joins,
      [joinId]: {
        ...join,
        status,
        mergedSourceLaneIds,
        errorMessage:
          patch.errorMessage !== undefined
            ? patch.errorMessage
            : join.errorMessage,
        conflicts:
          patch.conflicts !== undefined ? patch.conflicts : join.conflicts,
        updatedAt: now,
        completedAt,
      },
    },
  };
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
