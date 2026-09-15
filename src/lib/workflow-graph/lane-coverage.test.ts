import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "./schemas";
import { isUpstreamVisibleToLane } from "./lane-readiness";
import { applyJoinProgress } from "./context-transitions";
import { planFinalPublishJoin } from "./lane-join";

const timestamp = "2026-09-15T12:00:00.000Z";
function lane(
  laneId: string,
  includedContextIds: string[],
): GraphWorkflowExecutionLaneState {
  return {
    laneId,
    includedContextIds,
    kind: "worktree",
    status: "active",
    branchName: laneId,
    worktreePath: `/tmp/${laneId}`,
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function join(
  joinId: string,
  source: string,
  target: string,
  contextIds: string[],
): GraphWorkflowExecutionJoinState {
  return {
    joinId,
    kind: "context_merge",
    contextId: null,
    targetLaneId: target,
    sourceLaneIds: [source],
    mergedSourceLaneIds: [],
    sourceLaneContextIds: { [source]: contextIds },
    validationDebtSourceLaneIds: [],
    validationEvidence: [],
    status: "running",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
  };
}
function execution(): GraphWorkflowExecution {
  const value = createWorkflowExecution();
  for (const state of Object.values(value.contextStates)) {
    state.status = "completed";
    state.completedTaskCount = state.totalTaskCount;
    state.laneId =
      state.contextId === "context-plan"
        ? "worker"
        : state.contextId === "context-implement"
          ? "judge"
          : null;
  }
  value.executionLanes = {
    worker: lane("worker", ["context-plan"]),
    judge: lane("judge", ["context-implement"]),
  };
  return value;
}

describe("confirmed lane contribution coverage", () => {
  it("records target work confirmed in the source during conflict resolution", () => {
    const value = execution();
    value.joins.transfer = join("transfer", "worker", "judge", [
      "context-plan",
    ]);
    const transferred = applyJoinProgress(value, "transfer", timestamp, {
      addMergedSourceLaneId: "worker",
      confirmedSourceCoverage: {
        laneId: "worker",
        contextIds: ["context-implement"],
      },
    });
    expect(transferred.executionLanes.worker!.includedContextIds).toEqual([
      "context-plan",
      "context-implement",
    ]);
  });

  it("does not make a later contribution visible through an earlier succeeded join", () => {
    const value = execution();
    value.joins.earlier = {
      ...join("earlier", "worker", "judge", []),
      status: "succeeded",
      mergedSourceLaneIds: ["worker"],
    };
    expect(isUpstreamVisibleToLane("context-plan", "judge", value)).toBe(false);
  });

  it("settles exactly the frozen transfer, including carried contributions", () => {
    const value = execution();
    value.executionLanes.worker!.includedContextIds.push("carried", "later");
    value.joins.transfer = join("transfer", "worker", "judge", [
      "context-plan",
      "carried",
    ]);
    const transferred = applyJoinProgress(value, "transfer", timestamp, {
      addMergedSourceLaneId: "worker",
    });
    expect(transferred.executionLanes.judge!.includedContextIds).toEqual([
      "context-implement",
      "context-plan",
      "carried",
    ]);
    expect(isUpstreamVisibleToLane("context-plan", "judge", transferred)).toBe(
      true,
    );
  });

  it("settles coverage when replay finds all sources already merged", () => {
    const value = execution();
    value.joins.transfer = {
      ...join("transfer", "worker", "judge", ["context-plan"]),
      mergedSourceLaneIds: ["worker"],
    };
    const settled = applyJoinProgress(value, "transfer", timestamp, {
      status: "succeeded",
    });
    expect(settled.executionLanes.judge!.includedContextIds).toContain(
      "context-plan",
    );
  });

  it("publishes contributions after reciprocal joins instead of dropping both lanes", () => {
    const value = execution();
    value.joins.forward = {
      ...join("forward", "worker", "judge", []),
      status: "succeeded",
      mergedSourceLaneIds: ["worker"],
    };
    value.joins.backward = {
      ...join("backward", "judge", "worker", []),
      status: "succeeded",
      mergedSourceLaneIds: ["judge"],
    };
    const planned = planFinalPublishJoin({
      execution: value,
      sessionLaneId: "session",
      now: () => timestamp,
      generateJoinId: () => "publish",
    });
    expect(planned?.sourceLaneIds.sort()).toEqual(["judge", "worker"]);
  });
});
