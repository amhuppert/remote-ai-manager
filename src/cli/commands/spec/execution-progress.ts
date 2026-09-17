import type { SpecStatusExecution } from "@/lib/specs/view-schemas";

/**
 * The execution states `projectSpecPhase` collapses into `phase: executing`.
 * Reporting them individually is what lets a reader tell a parked graph
 * review from a running lane.
 */
export type ActiveExecution = SpecStatusExecution & {
  state: "definition_review" | "running";
};

export function isActiveExecution(
  execution: SpecStatusExecution,
): execution is ActiveExecution {
  return (
    execution.state === "definition_review" || execution.state === "running"
  );
}

export type ExecutionLaneState =
  | "session_delivery"
  | "running"
  | "merge_pending"
  | "halted"
  | "awaiting_workflow_approval"
  | "not_launched";

interface ExecutionProgress {
  readonly laneState: ExecutionLaneState;
  readonly actsNext: "human" | "agent" | null;
  readonly detail: string;
}

/**
 * The one owner of what a run's position means, so the text and `--json`
 * renderings cannot disagree. The spec-execution state decides: a run in
 * `definition_review` is parked whether or not a workflow execution is linked,
 * because linking is exactly what happens when its admitted one-off launch is
 * attached to the graph workflow run.
 */
export function describeExecution(
  execution: ActiveExecution,
): ExecutionProgress {
  const lane = execution.workflowExecutionId;
  if (
    execution.state === "running" &&
    execution.deliveryBasis?.kind === "session"
  ) {
    return {
      laneState: "session_delivery",
      actsNext: null,
      detail:
        "session delivery awaiting the delivering merge; review acceptance in Spec Studio",
    };
  }
  if (execution.state === "running") {
    // The spec execution stays `running` until the session's delivering
    // merge, so the lane's own status is what separates "lanes are working"
    // from "everything finished; only the merge remains" and "halted".
    if (lane !== null && execution.workflowStatus === "completed") {
      return {
        laneState: "merge_pending",
        actsNext: null,
        detail: `workflow lane ${lane} completed; delivery lands when the session's delivering merge publishes`,
      };
    }
    if (lane !== null && execution.workflowStatus === "halted") {
      return {
        laneState: "halted",
        actsNext: null,
        detail: `workflow lane ${lane} halted; resolve the halt from the workflow surface, then resume it`,
      };
    }
    return {
      laneState: "running",
      actsNext: null,
      detail:
        lane === null ? "no workflow lane recorded" : `workflow lane ${lane}`,
    };
  }
  if (lane === null) {
    return {
      laneState: "not_launched",
      actsNext: "agent",
      detail:
        execution.workflowSeedSource === null
          ? "no immutable workflow source is recorded; this retired execution cannot be started"
          : "the admitted one-off launch is awaiting restart recovery before its workflow lane is attached",
    };
  }
  return {
    laneState: "awaiting_workflow_approval",
    actsNext: "human",
    detail: `parked awaiting human approval of workflow lane ${lane}; approve it from the workflow surface`,
  };
}
