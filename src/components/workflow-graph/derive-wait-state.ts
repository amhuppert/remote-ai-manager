import type {
  GraphWorkflowExecution,
  ResolvedWorkflowSemanticDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
type WaitStateDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

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
  | { kind: "awaiting-approval" }
  | { kind: "awaiting-user-input" }
  | { kind: "merging"; targetBranch: string | null }
  | { kind: "completed" }
  | { kind: "halted" }
  | { kind: "published" };

export function deriveContextWaitState(input: {
  contextId: string;
  definition: WaitStateDefinition;
  execution: GraphWorkflowExecution;
}): ContextWaitState | undefined {
  const { contextId, definition, execution } = input;
  const ctxState = execution.contextStates[contextId];
  if (!ctxState) return undefined;

  if (ctxState.status === "halted") {
    return { kind: "halted" };
  }

  if (ctxState.mergeStatus === "in-progress") {
    return { kind: "merging", targetBranch: ctxState.branchName };
  }

  if (ctxState.status === "completed") {
    if (
      ctxState.isolation === "worktree" &&
      ctxState.mergeStatus === "merged-success"
    ) {
      return { kind: "published" };
    }
    return { kind: "completed" };
  }

  if (ctxState.status === "running") {
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

function getUnmetDependencyIds(
  contextId: string,
  definition: WaitStateDefinition,
  execution: GraphWorkflowExecution,
): string[] {
  const upstreamIds = definition.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => edge.sourceContextId);

  return upstreamIds.filter((upstreamId) => {
    const upstream = execution.contextStates[upstreamId];
    return !upstream || upstream.status !== "completed";
  });
}
