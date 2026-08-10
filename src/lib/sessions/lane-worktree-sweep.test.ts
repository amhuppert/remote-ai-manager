import { describe, expect, it } from "vitest";
import { createLaneWorktreeSweep } from "./lane-worktree-sweep";

function createDeps(entries: string[]) {
  const removed: string[] = [];
  return {
    removed,
    deps: {
      async readdir() {
        return entries;
      },
      async removeWorktree(input: {
        projectPath: string;
        worktreePath: string;
      }) {
        removed.push(input.worktreePath);
      },
    },
  };
}

describe("createLaneWorktreeSweep", () => {
  it("removes exactly the lane worktrees prefixed with the session dir name", async () => {
    const { deps, removed } = createDeps([
      "session-1",
      "session-1.ctx-a",
      "session-1.ctx-b",
      "other",
      ".trash",
    ]);
    const sweep = createLaneWorktreeSweep(deps);

    const result = await sweep.sweep({
      projectPath: "/repo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(removed).toEqual([
      "/repo/.worktrees/session-1.ctx-a",
      "/repo/.worktrees/session-1.ctx-b",
    ]);
    expect(result).toEqual([
      "/repo/.worktrees/session-1.ctx-a",
      "/repo/.worktrees/session-1.ctx-b",
    ]);
  });

  it("removes named lane worktrees whose suffix is unrelated to any context id", async () => {
    const { deps, removed } = createDeps([
      "session-1.implementation",
      "session-1.analysis-readers",
      "other-session.implementation",
    ]);
    const sweep = createLaneWorktreeSweep(deps);

    const result = await sweep.sweep({
      projectPath: "/repo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(removed).toEqual([
      "/repo/.worktrees/session-1.implementation",
      "/repo/.worktrees/session-1.analysis-readers",
    ]);
    expect(result).toEqual(removed);
  });

  it("does not match sessions whose name shares a prefix without the dot separator", async () => {
    const { deps, removed } = createDeps(["session-1", "session-10.ctx-a"]);
    const sweep = createLaneWorktreeSweep(deps);

    const result = await sweep.sweep({
      projectPath: "/repo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(removed).toEqual([]);
    expect(result).toEqual([]);
  });

  it("returns an empty list when the worktrees directory cannot be read", async () => {
    const sweep = createLaneWorktreeSweep({
      async readdir() {
        throw new Error("ENOENT");
      },
      async removeWorktree() {
        throw new Error("must not be called");
      },
    });

    const result = await sweep.sweep({
      projectPath: "/repo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(result).toEqual([]);
  });

  it("continues past individual removal failures and reports only successes", async () => {
    const removed: string[] = [];
    const sweep = createLaneWorktreeSweep({
      async readdir() {
        return ["session-1.ctx-a", "session-1.ctx-b"];
      },
      async removeWorktree(input: {
        projectPath: string;
        worktreePath: string;
      }) {
        if (input.worktreePath.endsWith("ctx-a")) {
          throw new Error("locked");
        }
        removed.push(input.worktreePath);
      },
    });

    const result = await sweep.sweep({
      projectPath: "/repo",
      sessionWorktreePath: "/repo/.worktrees/session-1",
    });

    expect(removed).toEqual(["/repo/.worktrees/session-1.ctx-b"]);
    expect(result).toEqual(["/repo/.worktrees/session-1.ctx-b"]);
  });
});
