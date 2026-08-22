import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import { incomingRoutes } from "@/lib/workflow-graph/route-projection";
import {
  isContextOutputCommittedToLane,
  reachableLanesFrom,
} from "@/lib/workflow-graph/lane-readiness";
import { SESSION_LANE_ID } from "@/lib/workflow-graph/lane-identity";
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
  | { kind: "completed" }
  | { kind: "halted" }
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
    return { kind: "halted" };
  }

  if (ctxState.mergeStatus === "in-progress") {
    return { kind: "merging", targetBranch: ctxState.branchName };
  }

  if (ctxState.status === "completed") {
    if (
      ctxState.isolation === "worktree" &&
      ctxState.mergeStatus === "merged-success" &&
      hasReachedSessionWorktree(execution, ctxState)
    ) {
      return { kind: "published" };
    }
    return { kind: "completed" };
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
 * Whether this context's work has reached the session worktree. Called only
 * for a completed, worktree-isolated context whose merge succeeded, so both
 * branches answer the narrower question: did that merge land in the session?
 *
 * A LANE-BEARING context publishes by REACHABILITY to the session lane through
 * succeeded joins — not by its own merge into its lane, which only proves it
 * landed among its band mates while the run may still owe the publish. And not
 * by "a final_publish names my lane" either: final-publish planning drops every
 * lane a succeeded `context_merge` already consumed, so in a fan-in topology
 * the publish lists only the join target and every context upstream of a join
 * would stall on completed forever.
 *
 * A LANELESS context is the legacy per-context worktree shape, which predates
 * lanes: its squash-merge landed the work directly in the session worktree, so
 * there is no lane to reach the session from and no join that will ever name
 * it. `isContextOutputCommittedToLane` is where that shape is defined, and
 * deferring to it keeps this from drifting into a second opinion about which
 * historical states count as landed.
 */
function hasReachedSessionWorktree(
  execution: GraphWorkflowExecution,
  ctxState: GraphWorkflowExecutionContextState,
): boolean {
  if (ctxState.laneId === null) {
    return isContextOutputCommittedToLane(ctxState, execution);
  }
  return reachableLanesFrom(ctxState.laneId, execution).has(SESSION_LANE_ID);
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
