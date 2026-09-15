import { describe, expect, it, vi } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import {
  collectLaneWorktreePaths,
  captureExecutionLaneDevServerCleanup,
  stopExecutionLaneDevServers,
} from "./dev-server-lane-cleanup";

function ctx(
  contextId: string,
  isolation: "session" | "worktree",
  worktreePath: string | null,
): GraphWorkflowExecutionContextState {
  return {
    skipReason: null,
    landingIntent: null,
    reviewOrigin: null,
    pendingApproval: null,
    pendingUserInputs: {},
    contextId,
    status: "running",
    totalTaskCount: 1,
    completedTaskCount: 0,
    iterationCount: 0,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
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

  it("preserves a shared lane when resetting only one of its remaining members", () => {
    const a = ctx("a", "worktree", "/proj/.worktrees/s.shared");
    const b = ctx("b", "worktree", "/proj/.worktrees/s.shared");
    a.laneId = "shared";
    b.laneId = "shared";
    const execution = buildExecution({ a, b });

    expect(collectLaneWorktreePaths(execution, { contextIds: ["a"] })).toEqual(
      [],
    );
  });

  it("collects a named lane once at terminal cleanup even when context rows no longer carry its path", () => {
    const execution = buildExecution({
      a: ctx("a", "session", null),
      b: ctx("b", "session", null),
    });
    execution.executionLanes = {
      implementation: {
        laneId: "implementation",
        kind: "worktree",
        status: "active",
        worktreePath: "/proj/.worktrees/s.implementation",
        branchName: "csm/s-implementation",
        includedContextIds: ["a", "b"],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: "2026-03-27T12:00:00.000Z",
        updatedAt: "2026-03-27T12:00:00.000Z",
      },
    };

    expect(collectLaneWorktreePaths(execution)).toEqual([
      "/proj/.worktrees/s.implementation",
    ]);
  });
});

describe("stopExecutionLaneDevServers", () => {
  it("stops dev servers for each lane worktree with the project path", async () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
      c: ctx("c", "worktree", "/proj/.worktrees/s.c"),
    });
    const stopDevServersForWorktree = vi.fn(
      async (_input: { projectPath: string; worktreePath: string }) => {},
    );

    await stopExecutionLaneDevServers(
      { execution, projectPath: "/proj" },
      {
        captureStopForWorktree: (input) => () =>
          stopDevServersForWorktree(input),
      },
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
    const stopDevServersForWorktree = vi.fn(
      async (_input: { projectPath: string; worktreePath: string }) => {},
    );

    await stopExecutionLaneDevServers(
      { execution, projectPath: "/proj" },
      {
        captureStopForWorktree: (input) => () =>
          stopDevServersForWorktree(input),
      },
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
        {
          captureStopForWorktree: (input) => () =>
            stopDevServersForWorktree(input),
        },
      ),
    ).resolves.toBeUndefined();
    expect(stopDevServersForWorktree).toHaveBeenCalledTimes(2);
  });
});

describe("captureExecutionLaneDevServerCleanup", () => {
  it("captures resources before state changes and stops only when the accepted cleanup runs", async () => {
    const execution = buildExecution({
      a: ctx("a", "worktree", "/proj/.worktrees/s.a"),
    });
    const resources = new Map([["/proj/.worktrees/s.a", { running: true }]]);
    const original = resources.get("/proj/.worktrees/s.a")!;
    const cleanup = captureExecutionLaneDevServerCleanup(
      { execution, projectPath: "/proj", contextIds: ["a"] },
      {
        captureStopForWorktree({ worktreePath }) {
          const resource = resources.get(worktreePath);
          return async () => {
            if (resource) resource.running = false;
          };
        },
      },
    );
    execution.contextStates.a!.worktreePath = null;
    resources.set("/proj/.worktrees/s.a", { running: true });
    expect(original.running).toBe(true);
    await cleanup();
    expect(original.running).toBe(false);
    expect(resources.get("/proj/.worktrees/s.a")?.running).toBe(true);
  });
});
