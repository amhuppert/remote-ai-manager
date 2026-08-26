import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionJoinState,
} from "@/lib/workflow-graph/schemas";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import { incomingRoutes } from "@/lib/workflow-graph/route-projection";
import {
  isContextOutputCommittedToLane,
  isUpstreamVisibleToLane,
} from "@/lib/workflow-graph/lane-readiness";
import { laneDisplayName } from "@/lib/workflow-graph/lane-bands";
import { openPlanRepairRoundFor } from "./derive-plan-repair-activity";
import type {
  CascadeWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
type WaitStateDefinition =
  | WorkflowSemanticDefinition
  | CascadeWorkflowSemanticDefinition;

export type ContextWaitState =
  | {
      kind: "dependency-blocked";
      unmetDependencyIds: string[];
      /** True when an unmet upstream is parked at a human approval gate. */
      blockedByApproval: boolean;
    }
  | { kind: "waiting-for-lane"; laneId: string }
  | { kind: "waiting-for-join"; joinId: string }
  | { kind: "waiting-for-capacity" }
  | { kind: "ready" }
  | { kind: "running" }
  | { kind: "validating" }
  /**
   * Blocking validation passed and the implementer owes the round's advisories
   * one non-binding turn (R6.3). Distinct from `validating` because the cohort
   * has already released the candidate, and from `completed` because the
   * context may not finish until the turn lands.
   */
  | { kind: "advisory-response" }
  | { kind: "awaiting-approval" }
  | { kind: "awaiting-user-input" }
  | { kind: "merging"; targetBranch: string | null }
  /**
   * Committed to its lane and certified, waiting for the lane merge that will
   * carry it into the session worktree. Distinct from `completed` because the
   * work is not where the operator will look for it yet, and from `published`
   * because the merge has not run.
   */
  | { kind: "awaiting-merge"; targetLaneName: string | null }
  | { kind: "completed" }
  /**
   * `repairInFlight` is what keeps a halt under automatic repair from reading
   * as an abandoned one: the plan-repair supervisor's round leaves the context
   * halted for the whole of its agent's turn, so the card's own state cannot
   * tell the two apart.
   */
  | { kind: "halted"; repairInFlight: boolean }
  | { kind: "published" }
  /** Terminal: an incoming route resolved false, so this branch never runs. */
  | { kind: "skipped" };

export function deriveContextWaitState(input: {
  contextId: string;
  definition: WaitStateDefinition;
  execution: GraphWorkflowExecution;
}): ContextWaitState | undefined {
  const { contextId, definition, execution } = input;
  const ctxState = execution.contextStates[contextId];
  if (!ctxState) return undefined;

  // Terminal and settled with nothing (D4 R4) — checked before the wait ladder
  // below, which would otherwise report a skipped context as Ready or blocked
  // on upstreams it will never consume.
  if (ctxState.status === "skipped") {
    return { kind: "skipped" };
  }

  if (ctxState.status === "halted") {
    return {
      kind: "halted",
      repairInFlight: openPlanRepairRoundFor(execution, contextId) !== null,
    };
  }

  if (ctxState.mergeStatus === "in-progress") {
    return { kind: "merging", targetBranch: ctxState.branchName };
  }

  if (ctxState.status === "completed") {
    return settledWaitState(contextId, definition, execution, ctxState);
  }

  if (ctxState.status === "running") {
    // Ahead of the task-count check, which would otherwise read a certified
    // context as still under review. `recertifying` deliberately falls through:
    // the response turn moved the candidate, so a blocking round IS what runs
    // next.
    if (ctxState.advisoryResponse?.phase === "awaiting_response") {
      return { kind: "advisory-response" };
    }
    if (
      ctxState.totalTaskCount > 0 &&
      ctxState.completedTaskCount >= ctxState.totalTaskCount
    ) {
      return { kind: "validating" };
    }
    return { kind: "running" };
  }

  if (ctxState.status === "awaiting_approval") {
    return { kind: "awaiting-approval" };
  }

  if (ctxState.status === "awaiting_user_input") {
    return { kind: "awaiting-user-input" };
  }

  const unmetDependencyIds = getUnmetDependencyIds(
    contextId,
    definition,
    execution,
  );
  if (unmetDependencyIds.length > 0) {
    const blockedByApproval = unmetDependencyIds.some(
      (id) => execution.contextStates[id]?.status === "awaiting_approval",
    );
    return {
      kind: "dependency-blocked",
      unmetDependencyIds,
      blockedByApproval,
    };
  }

  if (ctxState.laneId) {
    const lane = execution.executionLanes?.[ctxState.laneId];
    if (lane && lane.status === "pending") {
      return { kind: "waiting-for-lane", laneId: ctxState.laneId };
    }
  }

  if (ctxState.joinId) {
    const join = execution.joins?.[ctxState.joinId];
    if (join && join.status === "pending") {
      return { kind: "waiting-for-join", joinId: ctxState.joinId };
    }
  }

  return { kind: "ready" };
}

/**
 * How far a COMPLETED context's work has travelled toward the session worktree:
 * still in its lane, mid-merge, or landed.
 *
 * "Landed" is `isUpstreamVisibleToLane(…, null, …)` — the same predicate
 * `authored-context-outcome` calls `write_result_integrated` and the scheduler
 * uses to gate dependents. Reading it here rather than re-deriving reachability
 * is what keeps the canvas from holding a second opinion about whether work
 * arrived: a lane reachable from the session proves the LANE merged, but only
 * the composed predicate also proves this context ever committed to it.
 *
 * Two grades never reach the ladder at all, because neither owes a merge: a
 * read-only member writes nothing, and a session-isolation context already
 * wrote into the session worktree. Both are settled the moment they complete,
 * and reporting them as waiting-to-merge would invent a debt.
 */
function settledWaitState(
  contextId: string,
  definition: WaitStateDefinition,
  execution: GraphWorkflowExecution,
  ctxState: GraphWorkflowExecutionContextState,
): ContextWaitState {
  const placementMode = definition.executionContexts.find(
    (context) => context.id === contextId,
  )?.placement?.mode;
  if (placementMode === "readOnly") return { kind: "completed" };
  if (ctxState.laneId === null && ctxState.isolation === "session") {
    return { kind: "completed" };
  }

  // Not committed anywhere yet — including a landing that failed. The work is
  // finished but nowhere a consumer can see it, which is what `completed`
  // already meant.
  if (!isContextOutputCommittedToLane(ctxState, execution)) {
    return { kind: "completed" };
  }

  const inFlight = laneMergeInFlight(ctxState.laneId, execution);
  if (inFlight) {
    return {
      kind: "merging",
      targetBranch:
        execution.executionLanes?.[inFlight.targetLaneId]?.branchName ??
        ctxState.branchName,
    };
  }

  if (isUpstreamVisibleToLane(contextId, null, execution)) {
    return { kind: "published" };
  }

  return {
    kind: "awaiting-merge",
    targetLaneName: pendingMergeTargetName(ctxState.laneId, execution),
  };
}

/**
 * The join currently carrying this lane into its target, or null.
 *
 * A lane already in `mergedSourceLaneIds` is NOT the one in flight: a
 * multi-source join merges its sources one at a time, so the ledger is what
 * distinguishes the lane being merged right now from the ones already done.
 */
function laneMergeInFlight(
  laneId: string | null,
  execution: GraphWorkflowExecution,
): GraphWorkflowExecutionJoinState | null {
  if (laneId === null) return null;
  return (
    Object.values(execution.joins ?? {}).find(
      (join) =>
        join.status === "running" &&
        join.sourceLaneIds.includes(laneId) &&
        !join.mergedSourceLaneIds.includes(laneId),
    ) ?? null
  );
}

/** The lane a still-owed join will deliver this lane into, named for display. */
function pendingMergeTargetName(
  laneId: string | null,
  execution: GraphWorkflowExecution,
): string | null {
  if (laneId === null) return null;
  const owed = Object.values(execution.joins ?? {}).find(
    (join) =>
      join.status !== "succeeded" && join.sourceLaneIds.includes(laneId),
  );
  return owed ? laneDisplayName(owed.targetLaneId) : null;
}

function getUnmetDependencyIds(
  contextId: string,
  definition: WaitStateDefinition,
  execution: GraphWorkflowExecution,
): string[] {
  // Projection-resolved (decision D1). Reading the raw authored sources would
  // show a context as blocked by a branch the routing already declined — the
  // node would say "waiting for X" about work that is never going to run.
  // Unresolved edges keep their logical source, which is what a not-yet-decided
  // dependency should read as.
  const projection = projectExecutionRoutes(execution, definition);
  return incomingRoutes(projection, contextId)
    .filter((edge) => edge.resolution.kind !== "omitted")
    .map((edge) => edge.effectiveSourceId ?? edge.logicalSourceId)
    .filter((upstreamId, index, ids) => ids.indexOf(upstreamId) === index)
    .filter((upstreamId) => {
      const upstream = execution.contextStates[upstreamId];
      return !upstream || upstream.status !== "completed";
    });
}
