import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
type ReadinessDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

/**
 * A context's output is "committed to a lane" when its work has been recorded
 * somewhere downstream consumers can observe. Three shapes are recognized:
 *
 *  - Legacy session isolation: status === "completed" and no laneId. Work
 *    landed directly on the session worktree at completion time.
 *  - Legacy per-context worktree merge: status === "completed", no laneId,
 *    mergeStatus === "merged-success". Squash-merge already landed in session.
 *  - Lane-aware: status === "completed", laneId set, lane has the context in
 *    its includedContextIds (lane-commit hook appends both a snapshot and
 *    the context id when committing or when there were no changes to commit).
 *
 * Pure — no side effects, safe to call from any layer.
 */
export function isContextOutputCommittedToLane(
  state: GraphWorkflowExecutionContextState,
  execution: GraphWorkflowExecution,
): boolean {
  if (state.status !== "completed") return false;

  if (state.laneId === null) {
    if (state.isolation === "session") return true;
    return state.mergeStatus === "merged-success";
  }

  const lane = execution.executionLanes[state.laneId];
  if (!lane) return false;
  return lane.includedContextIds.includes(state.contextId);
}

/**
 * Upstream output is visible to a downstream context when its commits are
 * reachable from the downstream's lane. Visibility holds via:
 *
 *  - Same-lane ancestry: upstream and downstream share a laneId and the
 *    upstream output is committed.
 *  - Joined-lane: a succeeded join has merged the upstream's lane (or any
 *    ancestor lane) into the downstream's lane.
 *  - Session-lane output (legacy): upstream landed on the session worktree
 *    and downstream has no lane assignment (it would also target session).
 */
export function isUpstreamVisibleToDownstream(
  upstreamId: string,
  downstreamId: string,
  execution: GraphWorkflowExecution,
): boolean {
  const upstream = execution.contextStates[upstreamId];
  const downstream = execution.contextStates[downstreamId];
  if (!upstream || !downstream) return false;
  if (!isContextOutputCommittedToLane(upstream, execution)) return false;

  // Fork ancestry: a downstream lane forked from the upstream's lane carries
  // the upstream's committed output in its own branch history, recorded as the
  // upstream context id in the fork lane's includedContextIds. This visibility
  // is established at fork time and does not depend on any later join — without
  // it, an interrupted forked context reset to `ready` is wrongly judged
  // dependency-blocked and stranded as ineligible, so the scheduler never
  // reschedules it and the loop completes with the work unfinished.
  if (downstream.laneId !== null) {
    const downstreamLane = execution.executionLanes[downstream.laneId];
    if (downstreamLane?.includedContextIds.includes(upstreamId)) {
      return true;
    }
  }

  if (upstream.laneId === null) {
    return downstream.laneId === null;
  }

  const upstreamReachable = reachableLanesFrom(upstream.laneId, execution);

  if (downstream.laneId === null) {
    for (const reachedId of upstreamReachable) {
      if (execution.executionLanes[reachedId]?.kind === "session") return true;
    }
    return false;
  }

  if (upstream.laneId === downstream.laneId) return true;

  return upstreamReachable.has(downstream.laneId);
}

export function reachableLanesFrom(
  laneId: string,
  execution: GraphWorkflowExecution,
): Set<string> {
  const visited = new Set<string>([laneId]);
  const queue: string[] = [laneId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const join of Object.values(execution.joins ?? {})) {
      if (join.status !== "succeeded") continue;
      if (!join.sourceLaneIds.includes(current)) continue;
      if (!visited.has(join.targetLaneId)) {
        visited.add(join.targetLaneId);
        queue.push(join.targetLaneId);
      }
    }
  }

  return visited;
}

/**
 * Every context whose committed output is present in this lane's branch: the
 * contexts that ran on the lane, plus the contexts a succeeded join has
 * already merged into it, transitively through chained merges.
 *
 * A join moves commits into its target branch but never writes the merged
 * contexts into the target lane's `includedContextIds` — that field records
 * only what RAN on the lane. Reachability covers the gap in the source →
 * target direction, so a context still on the source lane can see the target.
 * It does not help a lane FORKED from the target afterwards: the fork's branch
 * carries the merged work, but it is neither a source nor a target of any
 * join, so nothing connects it to the merged upstream. Seeding a fork's
 * included set from this function closes that hole at fork time, when the
 * answer is a fact about the branch being copied.
 */
export function contextsPresentInLane(
  laneId: string,
  execution: GraphWorkflowExecution,
): string[] {
  const present = new Set<string>();
  const visitedLanes = new Set<string>([laneId]);
  const queue: string[] = [laneId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const contextId of execution.executionLanes[current]
      ?.includedContextIds ?? []) {
      present.add(contextId);
    }
    for (const join of Object.values(execution.joins ?? {})) {
      if (join.targetLaneId !== current) continue;
      for (const sourceLaneId of join.mergedSourceLaneIds) {
        if (visitedLanes.has(sourceLaneId)) continue;
        visitedLanes.add(sourceLaneId);
        queue.push(sourceLaneId);
      }
    }
  }

  return [...present];
}

export type ContextSchedulability =
  | {
      kind: "schedulable";
      targetLaneId: string | null;
      requiresFork: boolean;
    }
  | { kind: "wait-for-join"; sourceLaneIds: string[] }
  | { kind: "wait-for-lane"; laneId: string }
  | { kind: "wait-for-capacity" }
  | { kind: "dependency-blocked"; unmetUpstreamIds: string[] };

export interface ClassifySchedulabilityInput {
  contextId: string;
  definition: ReadinessDefinition;
  execution: GraphWorkflowExecution;
  options?: ClassifySchedulabilityOptions;
}

interface ClassifySchedulabilityOptions {
  /**
   * Remaining concurrency budget for new contexts. When 0, the classifier
   * returns wait-for-capacity even if dependencies are otherwise ready.
   * When omitted, capacity is treated as unbounded.
   */
  capacityRemaining?: number;
  /**
   * Whether the downstream is permitted to target the session worktree.
   * Defaults to `false` (session-lane participation is opt-in per the
   * accepted orchestration design). When omitted or `false`, dependency-ready
   * contexts that would otherwise land on the session lane are routed to a
   * forked worktree lane instead.
   */
  sessionLaneEnabled?: boolean;
}

/**
 * Decide whether a single context can be scheduled now and, if so, what lane
 * target the scheduler should use. Pure: no I/O, no mutation of execution
 * state.
 *
 * The classifier separates dependency-readiness (all upstream output is
 * visible to the downstream's lane) from schedulability (the chosen lane is
 * idle, any required join has succeeded, and concurrency capacity allows it).
 *
 * `targetLaneId` is the existing lane to consume (or `null` to use the
 * session worktree). `requiresFork` indicates that the context cannot share
 * the session worktree even though its upstream targets it — either because
 * session-lane participation is disabled by the caller or because another
 * worktree lane still has unpublished work that would conflict with
 * concurrent session activity. When `requiresFork` is true with
 * `targetLaneId === null`, the caller must provision a fresh worktree lane.
 */
export function classifyContextSchedulability(
  input: ClassifySchedulabilityInput,
): ContextSchedulability {
  const { contextId, definition, execution, options } = input;
  // Default off: session-lane participation is opt-in per the accepted
  // orchestration design. The default rollout keeps every parallel chain on
  // its own worktree lane and merges into the session branch only at final
  // publish. Callers that have validated dirty-worktree + concurrent-job
  // preconditions can opt in by passing `sessionLaneEnabled: true`.
  const sessionLaneEnabled = options?.sessionLaneEnabled ?? false;
  const capacityRemaining = options?.capacityRemaining;

  const downstream = execution.contextStates[contextId];
  const downstreamPlaced = downstream?.laneId ?? null;

  const upstreamIds = definition.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => edge.sourceContextId);

  // Phase 1: every upstream must have committed output somewhere. If the
  // downstream has already been pinned to a lane, the upstream must also be
  // visible from that lane; otherwise the scheduler is still free to pick a
  // placement that makes the upstream visible.
  const unmetUpstreamIds: string[] = [];
  for (const upstreamId of upstreamIds) {
    const upstream = execution.contextStates[upstreamId];
    if (!upstream || !isContextOutputCommittedToLane(upstream, execution)) {
      unmetUpstreamIds.push(upstreamId);
      continue;
    }
    if (
      downstreamPlaced !== null &&
      !isUpstreamVisibleToDownstream(upstreamId, contextId, execution)
    ) {
      unmetUpstreamIds.push(upstreamId);
    }
  }
  if (unmetUpstreamIds.length > 0) {
    return { kind: "dependency-blocked", unmetUpstreamIds };
  }

  if (capacityRemaining !== undefined && capacityRemaining <= 0) {
    return { kind: "wait-for-capacity" };
  }

  // Phase 2: pick a target lane.
  if (downstreamPlaced !== null) {
    if (isLaneBusy(downstreamPlaced, execution, contextId)) {
      return { kind: "wait-for-lane", laneId: downstreamPlaced };
    }
    return {
      kind: "schedulable",
      targetLaneId: downstreamPlaced,
      requiresFork: false,
    };
  }

  const sourceLaneIds = collectSourceLaneIds(upstreamIds, execution);
  const workTreeSourceLaneIds = sourceLaneIds.filter(
    (laneId): laneId is string => laneId !== null,
  );

  if (workTreeSourceLaneIds.length >= 2) {
    const commonTargets = intersectReachableLanes(
      workTreeSourceLaneIds,
      execution,
    );
    if (commonTargets.length === 0) {
      return { kind: "wait-for-join", sourceLaneIds: workTreeSourceLaneIds };
    }
    const idle = commonTargets.find(
      (laneId) => !isLaneBusy(laneId, execution, contextId),
    );
    if (idle === undefined) {
      return { kind: "wait-for-lane", laneId: commonTargets[0]! };
    }
    return { kind: "schedulable", targetLaneId: idle, requiresFork: false };
  }

  if (workTreeSourceLaneIds.length === 1) {
    const laneId = workTreeSourceLaneIds[0]!;
    if (isLaneBusy(laneId, execution, contextId)) {
      return { kind: "wait-for-lane", laneId };
    }
    return { kind: "schedulable", targetLaneId: laneId, requiresFork: false };
  }

  // No worktree source lanes — all upstreams (if any) landed in session.
  const requiresFork =
    !sessionLaneEnabled || hasUnpublishedUnrelatedWorktreeWork(execution);
  return { kind: "schedulable", targetLaneId: null, requiresFork };
}

function collectSourceLaneIds(
  upstreamIds: string[],
  execution: GraphWorkflowExecution,
): Array<string | null> {
  const seen = new Set<string | null>();
  const ordered: Array<string | null> = [];
  for (const upstreamId of upstreamIds) {
    const upstream = execution.contextStates[upstreamId];
    if (!upstream) continue;
    const key = upstream.laneId;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

function intersectReachableLanes(
  laneIds: string[],
  execution: GraphWorkflowExecution,
): string[] {
  if (laneIds.length === 0) return [];
  const sets = laneIds.map((laneId) => reachableLanesFrom(laneId, execution));
  const [first, ...rest] = sets;
  if (!first) return [];
  const result: string[] = [];
  for (const candidate of first) {
    if (rest.every((set) => set.has(candidate))) {
      result.push(candidate);
    }
  }
  return result;
}

function isLaneBusy(
  laneId: string,
  execution: GraphWorkflowExecution,
  excludingContextId?: string,
): boolean {
  for (const [contextId, state] of Object.entries(execution.contextStates)) {
    if (contextId === excludingContextId) continue;
    if (state.laneId !== laneId) continue;
    if (state.status === "running" || state.status === "ready") return true;
  }
  return false;
}

/**
 * Returns true when a worktree context exists whose output has not been
 * published to the session worktree. In the lane-aware model, publication
 * means: the context's lane (or some transitively joined ancestor lane) is
 * session-kind. Legacy per-context worktrees publish via squash merge
 * (`mergeStatus === "merged-success"`) when no lane is assigned.
 */
function hasUnpublishedUnrelatedWorktreeWork(
  execution: GraphWorkflowExecution,
): boolean {
  for (const state of Object.values(execution.contextStates)) {
    if (state.isolation !== "worktree") continue;
    if (isPublishedToSessionLane(state, execution)) continue;
    return true;
  }
  return false;
}

function isPublishedToSessionLane(
  state: GraphWorkflowExecutionContextState,
  execution: GraphWorkflowExecution,
): boolean {
  if (state.laneId === null) {
    return state.mergeStatus === "merged-success";
  }
  const reachable = reachableLanesFrom(state.laneId, execution);
  for (const reachedId of reachable) {
    if (execution.executionLanes[reachedId]?.kind === "session") return true;
  }
  return false;
}
