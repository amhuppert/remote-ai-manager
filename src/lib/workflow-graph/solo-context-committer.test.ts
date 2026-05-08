import { describe, expect, it, vi } from "vitest";
import { createSoloContextCommitter } from "./solo-context-committer";

describe("createSoloContextCommitter", () => {
  it("commits uncommitted changes in the session worktree with the canonical message", async () => {
    const hasUncommittedChanges = vi.fn(async () => true);
    const commitChanges = vi.fn(async () => ({ hash: "abc1234" }));

    const committer = createSoloContextCommitter({
      hasUncommittedChanges,
      commitChanges,
    });

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "ctx-solo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(result).toEqual({ status: "committed", hash: "abc1234" });
    expect(hasUncommittedChanges).toHaveBeenCalledWith(
      "/repo/.worktrees/session-1",
    );
    expect(commitChanges).toHaveBeenCalledWith(
      "/repo/.worktrees/session-1",
      "Graph workflow context ctx-solo",
      { skipHooks: true },
    );
  });

  it("skips committing when the session worktree has no uncommitted changes", async () => {
    const hasUncommittedChanges = vi.fn(async () => false);
    const commitChanges = vi.fn(async () => ({ hash: "" }));

    const committer = createSoloContextCommitter({
      hasUncommittedChanges,
      commitChanges,
    });

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "ctx-solo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(result).toEqual({ status: "skipped" });
    expect(commitChanges).not.toHaveBeenCalled();
  });

  it("returns failed status with error message when the commit throws", async () => {
    const hasUncommittedChanges = vi.fn(async () => true);
    const commitChanges = vi.fn(async () => {
      throw new Error("pre-commit hook failed");
    });

    const committer = createSoloContextCommitter({
      hasUncommittedChanges,
      commitChanges,
    });

    const result = await committer.commit({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "ctx-solo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.errorMessage).toContain("pre-commit hook failed");
    }
  });
});
