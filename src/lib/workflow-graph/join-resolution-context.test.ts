import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowTaskState,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import { SESSION_LANE_ID } from "./lane-join";
import { buildJoinResolutionContext } from "./join-resolution-context";

const t0 = "2026-03-27T12:00:00.000Z";

function makeLane(
  overrides: Partial<GraphWorkflowExecutionLaneState> &
    Pick<GraphWorkflowExecutionLaneState, "laneId" | "branchName">,
): GraphWorkflowExecutionLaneState {
  return {
    kind: "worktree",
    status: "active",
    worktreePath: `/tmp/${overrides.laneId}`,
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

function makeJoin(
  overrides: Partial<GraphWorkflowExecutionJoinState> &
    Pick<
      GraphWorkflowExecutionJoinState,
      "joinId" | "targetLaneId" | "sourceLaneIds"
    >,
): GraphWorkflowExecutionJoinState {
  return {
    kind: "context_merge",
    contextId: null,
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: t0,
    updatedAt: t0,
    completedAt: null,
    ...overrides,
  };
}

function makeTaskState(
  overrides: Partial<GraphWorkflowTaskState> &
    Pick<GraphWorkflowTaskState, "taskId" | "contextId">,
): GraphWorkflowTaskState {
  return {
    order: 1,
    status: "completed",
    summary: null,
    startedAt: t0,
    completedAt: t0,
    lastConversationId: null,
    failureMessage: null,
    failureHistory: [],
    ...overrides,
  };
}

/** Fixture: plan+implement ran on lane-a, verify ran on lane-b. */
function makeExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return {
    ...base,
    executionLanes: {
      "lane-a": makeLane({
        laneId: "lane-a",
        branchName: "csm/lane-a",
        includedContextIds: ["context-plan", "context-implement"],
      }),
      "lane-b": makeLane({
        laneId: "lane-b",
        branchName: "csm/lane-b",
        includedContextIds: ["context-verify"],
      }),
    },
    taskStates: {
      "task-plan-1": makeTaskState({
        taskId: "task-plan-1",
        contextId: "context-plan",
        summary: "Documented the migration plan in docs/plan.md.",
      }),
      "task-implement-1": makeTaskState({
        taskId: "task-implement-1",
        contextId: "context-implement",
        summary: "Implemented the feature behind the settings flag.",
      }),
      "task-verify-1": makeTaskState({
        taskId: "task-verify-1",
        contextId: "context-verify",
        summary: "Added integration checks for the new flow.",
      }),
    },
    ...overrides,
  };
}

describe("buildJoinResolutionContext", () => {
  it("describes the source lane as ours and the target lane as theirs with context goals and task summaries", () => {
    const execution = makeExecution();
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    const brief = buildJoinResolutionContext(execution, join, "lane-b");

    expect(brief).not.toBeNull();
    // Ours = the source lane the merge runs in (HEAD side of the markers).
    const oursIndex = brief!.indexOf("csm/lane-b");
    const theirsIndex = brief!.indexOf("csm/lane-a");
    expect(oursIndex).toBeGreaterThanOrEqual(0);
    expect(theirsIndex).toBeGreaterThan(oursIndex);
    // Source lane content
    expect(brief).toContain("Verify");
    expect(brief).toContain("Added integration checks for the new flow.");
    // Target lane content
    expect(brief).toContain("Implement");
    expect(brief).toContain("Implement the feature");
    expect(brief).toContain(
      "Implemented the feature behind the settings flag.",
    );
  });

  it("excludes contexts shared by both lanes (common ancestry cannot conflict with itself)", () => {
    const execution = makeExecution();
    execution.executionLanes["lane-b"]!.includedContextIds = [
      "context-plan",
      "context-verify",
    ];
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    const brief = buildJoinResolutionContext(execution, join, "lane-b");

    expect(brief).not.toBeNull();
    expect(brief).not.toContain("Documented the migration plan");
  });

  it("skips tasks without a completed summary", () => {
    const execution = makeExecution();
    execution.taskStates["task-verify-1"]!.summary = null;
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    const brief = buildJoinResolutionContext(execution, join, "lane-b");

    expect(brief).not.toBeNull();
    expect(brief).not.toContain("Run checks");
  });

  it("describes the session lane as the workflow's base branch", () => {
    const execution = makeExecution();
    execution.executionLanes[SESSION_LANE_ID] = makeLane({
      laneId: SESSION_LANE_ID,
      branchName: "csm/session",
      kind: "session",
    });
    const join = makeJoin({
      joinId: "publish-1",
      kind: "final_publish",
      targetLaneId: SESSION_LANE_ID,
      sourceLaneIds: ["lane-a"],
    });

    const brief = buildJoinResolutionContext(execution, join, "lane-a");

    expect(brief).not.toBeNull();
    expect(brief).toContain("csm/session");
    expect(brief!.toLowerCase()).toContain("previously merged");
  });

  it("returns null when neither lane has any describable work", () => {
    const execution = makeExecution({
      taskStates: {},
    });
    execution.executionLanes["lane-a"]!.includedContextIds = [];
    execution.executionLanes["lane-b"]!.includedContextIds = [];
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    expect(buildJoinResolutionContext(execution, join, "lane-b")).toBeNull();
  });

  it("returns null when the lanes are missing from the execution", () => {
    const execution = makeExecution({ executionLanes: {} });
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    expect(buildJoinResolutionContext(execution, join, "lane-b")).toBeNull();
  });

  it("caps the brief size and marks truncation", () => {
    const execution = makeExecution();
    execution.taskStates["task-verify-1"]!.summary = "x".repeat(20_000);
    const join = makeJoin({
      joinId: "join-1",
      targetLaneId: "lane-a",
      sourceLaneIds: ["lane-a", "lane-b"],
    });

    const brief = buildJoinResolutionContext(execution, join, "lane-b");

    expect(brief).not.toBeNull();
    expect(brief!.length).toBeLessThanOrEqual(8_000);
    expect(brief).toContain("truncated");
  });
});
