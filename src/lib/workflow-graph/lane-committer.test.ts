import { describe, expect, it } from "vitest";
import { graphWorkflowExecutionLaneStateSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import {
  applyLaneCommitSnapshot,
  createLaneCommitter,
  type LaneCommitterDeps,
} from "./lane-committer";

function makeDeps(
  overrides: Partial<LaneCommitterDeps> = {},
): LaneCommitterDeps {
  return {
    hasUncommittedChanges: async () => true,
    commitChanges: async () => ({ hash: "deadbeef" }),
    now: () => "2026-04-02T10:00:00.000Z",
    ...overrides,
  };
}

function withLane(
  execution: GraphWorkflowExecution,
  laneId: string,
  worktreePath: string | null,
  branchName: string,
): GraphWorkflowExecution {
  return {
    ...execution,
    executionLanes: {
      ...execution.executionLanes,
      [laneId]: {
        laneId,
        kind:
          worktreePath === null ? ("session" as const) : ("worktree" as const),
        status: "active",
        worktreePath,
        branchName,
        includedContextIds: [],
        lastCommittingContextId: null,
        commitSnapshots: [],
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T09:00:00.000Z",
      },
    },
  };
}

describe("createLaneCommitter.commit", () => {
  it("returns skipped when the lane worktree has no uncommitted changes", async () => {
    const committer = createLaneCommitter(
      makeDeps({ hasUncommittedChanges: async () => false }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("commits and returns a snapshot containing contextId, sha, and committedAt", async () => {
    const commitCalls: Array<{
      path: string;
      message: string;
      options?: { skipHooks?: boolean };
    }> = [];
    const committer = createLaneCommitter(
      makeDeps({
        commitChanges: async (path, message, options) => {
          commitCalls.push({ path, message, options });
          return { hash: "abc123" };
        },
        now: () => "2026-04-02T10:30:00.000Z",
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
    });

    expect(result).toEqual({
      status: "committed",
      snapshot: {
        contextId: "context-plan",
        sha: "abc123",
        committedAt: "2026-04-02T10:30:00.000Z",
      },
    });
    expect(commitCalls).toEqual([
      {
        path: "/repo/.worktrees/session-1.lane-plan",
        message: "Graph workflow context context-plan",
        options: { skipHooks: true },
      },
    ]);
  });

  it("returns failed with the error message when commitChanges throws", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        commitChanges: async () => {
          throw new Error("git commit failed: nothing to commit");
        },
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
    });

    expect(result).toEqual({
      status: "failed",
      errorMessage: "git commit failed: nothing to commit",
    });
  });
});

describe("applyLaneCommitSnapshot", () => {
  it("appends the snapshot, updates lastCommittingContextId, refreshes updatedAt, and marks the context available in includedContextIds", () => {
    const baseExecution = withLane(
      createWorkflowExecution(),
      "lane-plan",
      "/repo/.worktrees/session-1.lane-plan",
      "csm/session-1-lane-plan",
    );

    const next = applyLaneCommitSnapshot(baseExecution, "lane-plan", {
      contextId: "context-plan",
      sha: "abc123",
      committedAt: "2026-04-02T10:30:00.000Z",
    });

    const lane = next.executionLanes["lane-plan"]!;
    expect(lane.commitSnapshots).toEqual([
      {
        contextId: "context-plan",
        sha: "abc123",
        committedAt: "2026-04-02T10:30:00.000Z",
      },
    ]);
    expect(lane.lastCommittingContextId).toBe("context-plan");
    expect(lane.updatedAt).toBe("2026-04-02T10:30:00.000Z");
    expect(lane.includedContextIds).toEqual(["context-plan"]);
  });

  it("does not duplicate contextId in includedContextIds when the same context commits twice", () => {
    const baseExecution = withLane(
      createWorkflowExecution(),
      "lane-plan",
      "/repo/.worktrees/session-1.lane-plan",
      "csm/session-1-lane-plan",
    );
    const afterFirst = applyLaneCommitSnapshot(baseExecution, "lane-plan", {
      contextId: "context-plan",
      sha: "aaa",
      committedAt: "2026-04-02T10:10:00.000Z",
    });
    const afterSecond = applyLaneCommitSnapshot(afterFirst, "lane-plan", {
      contextId: "context-plan",
      sha: "bbb",
      committedAt: "2026-04-02T10:20:00.000Z",
    });

    const lane = afterSecond.executionLanes["lane-plan"]!;
    expect(lane.includedContextIds).toEqual(["context-plan"]);
    expect(lane.commitSnapshots).toHaveLength(2);
  });

  it("appends to an existing commitSnapshots array without mutating prior snapshots", () => {
    const baseExecution = withLane(
      createWorkflowExecution(),
      "lane-plan",
      "/repo/.worktrees/session-1.lane-plan",
      "csm/session-1-lane-plan",
    );
    const withFirst = applyLaneCommitSnapshot(baseExecution, "lane-plan", {
      contextId: "context-plan",
      sha: "abc111",
      committedAt: "2026-04-02T10:10:00.000Z",
    });

    const withSecond = applyLaneCommitSnapshot(withFirst, "lane-plan", {
      contextId: "context-implement",
      sha: "def222",
      committedAt: "2026-04-02T10:20:00.000Z",
    });

    const lane = withSecond.executionLanes["lane-plan"]!;
    expect(lane.commitSnapshots).toEqual([
      {
        contextId: "context-plan",
        sha: "abc111",
        committedAt: "2026-04-02T10:10:00.000Z",
      },
      {
        contextId: "context-implement",
        sha: "def222",
        committedAt: "2026-04-02T10:20:00.000Z",
      },
    ]);
    expect(lane.lastCommittingContextId).toBe("context-implement");
    expect(lane.updatedAt).toBe("2026-04-02T10:20:00.000Z");
    expect(lane.includedContextIds).toEqual([
      "context-plan",
      "context-implement",
    ]);

    // Prior execution object must remain untouched (immutability)
    expect(baseExecution.executionLanes["lane-plan"]!.commitSnapshots).toEqual(
      [],
    );
    expect(
      baseExecution.executionLanes["lane-plan"]!.includedContextIds,
    ).toEqual([]);
    expect(withFirst.executionLanes["lane-plan"]!.commitSnapshots).toHaveLength(
      1,
    );
    expect(withFirst.executionLanes["lane-plan"]!.includedContextIds).toEqual([
      "context-plan",
    ]);
  });

  it("throws when the laneId is not found in execution.executionLanes", () => {
    const baseExecution = createWorkflowExecution();

    expect(() =>
      applyLaneCommitSnapshot(baseExecution, "lane-missing", {
        contextId: "context-plan",
        sha: "abc123",
        committedAt: "2026-04-02T10:30:00.000Z",
      }),
    ).toThrow(/lane-missing/);
  });

  // Recovery contract: commit snapshots are append-only audit data; git is the
  // authoritative source for the lane's current HEAD. This invariant is enforced
  // by the lane state schema NOT carrying a SHA-pointer field (headSha,
  // currentSha, branchHead, currentHead). If a SHA-pointer field is added in
  // the future, recovery code would be tempted to trust the JSON over git,
  // diverging from reality when external commits land on the lane branch.
  it("lane state schema does not store a HEAD SHA pointer (git is authoritative)", () => {
    const parsed = graphWorkflowExecutionLaneStateSchema.parse({
      laneId: "lane-1",
      kind: "worktree",
      status: "active",
      worktreePath: "/repo/.worktrees/x.lane-1",
      branchName: "csm/x-lane-1",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: "2026-04-02T09:00:00.000Z",
      updatedAt: "2026-04-02T09:00:00.000Z",
    });
    const keys = Object.keys(parsed);
    expect(keys).not.toContain("headSha");
    expect(keys).not.toContain("currentSha");
    expect(keys).not.toContain("branchHead");
    expect(keys).not.toContain("currentHead");
    // The only commit-related fields are the append-only audit list and the
    // last-committing-context pointer (used for cooperative scheduling, not
    // as a HEAD pointer).
    expect(keys).toContain("commitSnapshots");
    expect(keys).toContain("lastCommittingContextId");
    expect(keys).toContain("branchName");
  });
});
