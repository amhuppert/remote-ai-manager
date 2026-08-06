import { describe, expect, it, vi } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  collectLaneWorktreePaths,
  stopExecutionLaneDevServers,
} from "./dev-server-lane-cleanup";

function ctx(
  contextId: string,
  isolation: "session" | "worktree",
  worktreePath: string | null,
): GraphWorkflowExecutionContextState {
  return {
    pendingApproval: null,
    pendingUserInputs: {},
    contextId,
    status: "running",
    totalTaskCount: 1,
    completedTaskCount: 0,
    iterationCount: 0,
    consecutiveFailureCount: 0,
    worktreePath,
    branchName: worktreePath ? `csm/s.${contextId}` : null,
    isolation,
    batchId: null,
    laneId: isolation === "worktree" ? contextId : null,
    joinId: null,
    mergeStatus: "not-applicable",
    cleanupStatus: "not-applicable",
    lastMergeError: null,
  };
}

function buildExecution(
  contextStates: Record<string, GraphWorkflowExecutionContextState>,
): GraphWorkflowExecution {
  return createWorkflowExecution({ contextStates });
}

describe("collectLaneWorktreePaths", () => {
  it("returns worktree-isolation paths and skips session/null lanes", () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      b: ctx("b", "session", null),
      c: ctx("c", "worktree", "/proj/.worktrees/s.c"),
      d: ctx("d", "worktree", null),
    });
    expect(new Set(collectLaneWorktreePaths(execution))).toEqual(
      new Set(["/proj/.worktrees/s.a", "/proj/.worktrees/s.c"]),
    );
  });

  it("dedupes worktree paths that normalize to the same directory", () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      b: ctx("b", "worktree", "/proj/.worktrees/s.a/"),
    });
    expect(collectLaneWorktreePaths(execution)).toHaveLength(1);
  });

  it("filters to the given contextIds", () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      c: ctx("c", "worktree", "/proj/.worktrees/s.c"),
    });
    expect(collectLaneWorktreePaths(execution, { contextIds: ["c"] })).toEqual([
      "/proj/.worktrees/s.c",
    ]);
  });
});

describe("stopExecutionLaneDevServers", () => {
  it("stops dev servers for each lane worktree with the project path", async () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      c: ctx("c", "worktree", "/proj/.worktrees/s.c"),
    });
    const stopDevServersForWorktree = vi.fn(async () => {});

    await stopExecutionLaneDevServers(
      { execution, projectPath: "/proj" },
      { stopDevServersForWorktree },
    );

    expect(stopDevServersForWorktree).toHaveBeenCalledTimes(2);
    expect(stopDevServersForWorktree).toHaveBeenCalledWith({
      projectPath: "/proj",
      worktreePath: "/proj/.worktrees/s.a",
    });
    expect(stopDevServersForWorktree).toHaveBeenCalledWith({
      projectPath: "/proj",
      worktreePath: "/proj/.worktrees/s.c",
    });
  });

  it("does nothing when there are no worktree lanes", async () => {
    const execution = buildExecution({ a: ctx("a", "session", null) });
    const stopDevServersForWorktree = vi.fn(async () => {});

    await stopExecutionLaneDevServers(
      { execution, projectPath: "/proj" },
      { stopDevServersForWorktree },
    );

    expect(stopDevServersForWorktree).not.toHaveBeenCalled();
  });

  it("stops the remaining lanes even when one stop rejects", async () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      c: ctx("c", "worktree", "/proj/.worktrees/s.c"),
    });
    const stopDevServersForWorktree = vi.fn(
      async (input: { worktreePath: string }) => {
        if (input.worktreePath.endsWith("s.a")) throw new Error("boom");
      },
    );

    await expect(
      stopExecutionLaneDevServers(
        { execution, projectPath: "/proj" },
        { stopDevServersForWorktree },
      ),
    ).resolves.toBeUndefined();
    expect(stopDevServersForWorktree).toHaveBeenCalledTimes(2);
  });
});
