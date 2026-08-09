import { describe, expect, it } from "vitest";
import type { OwnedLandingRequest } from "@/lib/git/owned-landing";
import { graphWorkflowExecutionLaneStateSchema } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "./test-fixtures";
import {
  applyLaneCommitSnapshot,
  createLaneCommitter,
  type LaneCommitterDeps,
} from "./lane-committer";

const FULL_ACCESS = { mode: "full" as const, canonicalPrefixes: [] };

function makeDeps(
  overrides: Partial<LaneCommitterDeps> = {},
): LaneCommitterDeps {
  return {
    hasUncommittedChanges: async () => true,
    commitChanges: async () => ({ hash: "deadbeef" }),
    commitOwnedPaths: async () => ({ status: "committed", hash: "owned123" }),
    resolveHeadSha: async () => null,
    realpath: async (target) => target,
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
        ignoredBaseline: [],
        createdAt: "2026-04-02T09:00:00.000Z",
        updatedAt: "2026-04-02T09:00:00.000Z",
      },
    },
  };
}

describe("createLaneCommitter.commit", () => {
  it("returns skipped when the lane worktree has no uncommitted changes and the pre-turn head is unknown", async () => {
    const committer = createLaneCommitter(
      makeDeps({ hasUncommittedChanges: async () => false }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: null,
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("adopts the lane HEAD as the context's commit snapshot when the worktree is clean but HEAD moved during the turn", async () => {
    let commitCalled = false;
    const committer = createLaneCommitter(
      makeDeps({
        hasUncommittedChanges: async () => false,
        resolveHeadSha: async () => "head-after-selfcommit",
        commitChanges: async () => {
          commitCalled = true;
          return { hash: "never" };
        },
        now: () => "2026-04-02T10:45:00.000Z",
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-before-turn",
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({
      status: "adopted",
      snapshot: {
        contextId: "context-plan",
        sha: "head-after-selfcommit",
        committedAt: "2026-04-02T10:45:00.000Z",
      },
    });
    expect(commitCalled).toBe(false);
  });

  it("returns skipped when the worktree is clean and HEAD equals the pre-turn head", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        hasUncommittedChanges: async () => false,
        resolveHeadSha: async () => "head-unmoved",
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-unmoved",
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("returns skipped when the worktree is clean and the current HEAD cannot be resolved (never fabricates evidence)", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        hasUncommittedChanges: async () => false,
        resolveHeadSha: async () => null,
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-before-turn",
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("returns skipped when the worktree is clean and resolving HEAD throws (conservative, never halts)", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        hasUncommittedChanges: async () => false,
        resolveHeadSha: async () => {
          throw new Error("git rev-parse exploded");
        },
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-before-turn",
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("commits (does not adopt) when the worktree has uncommitted changes even if HEAD moved during the turn", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        hasUncommittedChanges: async () => true,
        resolveHeadSha: async () => "head-after-selfcommit",
        commitChanges: async () => ({ hash: "residual-commit" }),
        now: () => "2026-04-02T10:50:00.000Z",
      }),
    );

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-plan",
      laneId: "lane-plan",
      laneWorktreePath: "/repo/.worktrees/session-1.lane-plan",
      preTurnHeadSha: "head-before-turn",
      ownership: FULL_ACCESS,
    });

    // Exactly one snapshot for the context — the committer's own commit is
    // authoritative; adoption only fills the clean-worktree gap.
    expect(result).toEqual({
      status: "committed",
      snapshot: {
        contextId: "context-plan",
        sha: "residual-commit",
        committedAt: "2026-04-02T10:50:00.000Z",
      },
    });
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
      preTurnHeadSha: null,
      ownership: FULL_ACCESS,
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
      preTurnHeadSha: null,
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({
      status: "failed",
      errorMessage: "git commit failed: nothing to commit",
    });
  });
});

describe("createLaneCommitter.commit under an ownership envelope", () => {
  const LANE_WORKTREE = "/repo/.worktrees/session-1.lane-api";
  /** The lane worktree reached through a symlinked parent, as macOS does. */
  const CANONICAL_LANE_WORKTREE = "/private/repo/.worktrees/session-1.lane-api";

  function ownedDeps(overrides: Partial<LaneCommitterDeps> = {}) {
    const landings: OwnedLandingRequest[] = [];
    const wholeTreeCommits: string[] = [];
    const deps = makeDeps({
      realpath: async () => CANONICAL_LANE_WORKTREE,
      commitOwnedPaths: async (request) => {
        landings.push(request);
        return { status: "committed", hash: "owned-abc" };
      },
      commitChanges: async (worktreePath) => {
        wholeTreeCommits.push(worktreePath);
        return { hash: "whole-tree" };
      },
      ...overrides,
    });
    return { deps, landings, wholeTreeCommits };
  }

  it("lands an owning context through the pathspec primitive, with the frozen prefixes as repo-relative paths and the landing-intent trailer", async () => {
    const { deps, landings, wholeTreeCommits } = ownedDeps();
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: "head-before-turn",
      landingToken: "token-api",
      ownership: {
        mode: "owned",
        canonicalPrefixes: [
          `${CANONICAL_LANE_WORKTREE}/src/api`,
          `${CANONICAL_LANE_WORKTREE}/docs/api.md`,
        ],
      },
    });

    expect(result).toEqual({
      status: "committed",
      snapshot: {
        contextId: "context-api",
        sha: "owned-abc",
        committedAt: "2026-04-02T10:00:00.000Z",
      },
    });
    expect(landings).toEqual([
      {
        worktreePath: LANE_WORKTREE,
        message:
          "Graph workflow context context-api\n\nLanding-Intent: token-api",
        ownedPaths: ["src/api", "docs/api.md"],
      },
    ]);
    // The whole-tree committer would have swept every sibling's in-progress
    // work into this commit; an owning context must never reach it.
    expect(wholeTreeCommits).toEqual([]);
  });

  it("never adopts a moved lane HEAD for an owning context, because a sibling's landing moves it too", async () => {
    const { deps, landings } = ownedDeps({
      hasUncommittedChanges: async () => false,
      resolveHeadSha: async () => "head-moved-by-sibling",
      commitOwnedPaths: async (request) => {
        landings.push(request);
        return { status: "no-changes" };
      },
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: "head-before-turn",
      ownership: {
        mode: "owned",
        canonicalPrefixes: [`${CANONICAL_LANE_WORKTREE}/src/api`],
      },
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("reports skipped when nothing under the owned prefixes changed, however dirty the shared worktree is", async () => {
    const { deps } = ownedDeps({
      hasUncommittedChanges: async () => true,
      commitOwnedPaths: async () => ({ status: "no-changes" }),
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: null,
      ownership: {
        mode: "owned",
        canonicalPrefixes: [`${CANONICAL_LANE_WORKTREE}/src/api`],
      },
    });

    expect(result).toEqual({ status: "skipped" });
  });

  it("refuses to land an owning context whose frozen prefix set is empty rather than falling back to a whole-tree commit", async () => {
    const { deps, landings, wholeTreeCommits } = ownedDeps();
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: null,
      ownership: { mode: "owned", canonicalPrefixes: [] },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorMessage).toContain("context-api");
    expect(landings).toEqual([]);
    expect(wholeTreeCommits).toEqual([]);
  });

  it("refuses to land when a frozen prefix does not sit under the canonical lane worktree", async () => {
    const { deps, landings, wholeTreeCommits } = ownedDeps();
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: null,
      ownership: {
        mode: "owned",
        canonicalPrefixes: ["/etc/passwd"],
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorMessage).toContain("/etc/passwd");
    expect(landings).toEqual([]);
    expect(wholeTreeCommits).toEqual([]);
  });

  it("refuses to land when the lane worktree cannot be canonicalized", async () => {
    const { deps, landings, wholeTreeCommits } = ownedDeps({
      realpath: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: null,
      ownership: {
        mode: "owned",
        canonicalPrefixes: [`${CANONICAL_LANE_WORKTREE}/src/api`],
      },
    });

    expect(result.status).toBe("failed");
    expect(landings).toEqual([]);
    expect(wholeTreeCommits).toEqual([]);
  });

  it("returns failed with the primitive's error message when the owned landing throws", async () => {
    const { deps } = ownedDeps({
      commitOwnedPaths: async () => {
        throw new Error("update-ref rejected: HEAD moved");
      },
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-api",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: null,
      ownership: {
        mode: "owned",
        canonicalPrefixes: [`${CANONICAL_LANE_WORKTREE}/src/api`],
      },
    });

    expect(result).toEqual({
      status: "failed",
      errorMessage: "update-ref rejected: HEAD moved",
    });
  });

  it("lands nothing for a read-only lane member, which has no write surface to commit", async () => {
    const { deps, landings, wholeTreeCommits } = ownedDeps({
      hasUncommittedChanges: async () => true,
      resolveHeadSha: async () => "head-moved-by-sibling",
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-reader",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: "head-before-turn",
      ownership: { mode: "readOnly", canonicalPrefixes: [] },
    });

    expect(result).toEqual({ status: "skipped" });
    expect(landings).toEqual([]);
    expect(wholeTreeCommits).toEqual([]);
  });

  it("keeps the whole-tree committer, adoption included, for a full-access lane member", async () => {
    const { deps, landings } = ownedDeps({
      hasUncommittedChanges: async () => false,
      resolveHeadSha: async () => "head-after-selfcommit",
    });
    const committer = createLaneCommitter(deps);

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "context-full",
      laneId: "lane-api",
      laneWorktreePath: LANE_WORKTREE,
      preTurnHeadSha: "head-before-turn",
      ownership: FULL_ACCESS,
    });

    expect(result).toEqual({
      status: "adopted",
      snapshot: {
        contextId: "context-full",
        sha: "head-after-selfcommit",
        committedAt: "2026-04-02T10:00:00.000Z",
      },
    });
    expect(landings).toEqual([]);
  });
});

describe("createLaneCommitter.resolveHead", () => {
  it("returns the resolved HEAD sha for a worktree", async () => {
    const committer = createLaneCommitter(
      makeDeps({ resolveHeadSha: async () => "head-at-capture" }),
    );

    await expect(
      committer.resolveHead("/repo/.worktrees/session-1.lane-plan"),
    ).resolves.toBe("head-at-capture");
  });

  it("returns null when HEAD resolution throws (best-effort capture)", async () => {
    const committer = createLaneCommitter(
      makeDeps({
        resolveHeadSha: async () => {
          throw new Error("not a git repository");
        },
      }),
    );

    await expect(
      committer.resolveHead("/repo/.worktrees/session-1.lane-plan"),
    ).resolves.toBeNull();
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
