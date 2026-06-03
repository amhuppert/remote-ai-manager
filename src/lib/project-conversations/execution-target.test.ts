import { describe, it, expect } from "vitest";
import { createProjectExecutionTargetResolver } from "./execution-target";

describe("createProjectExecutionTargetResolver", () => {
  it("returns the repo-root worktree and current branch", async () => {
    const resolver = createProjectExecutionTargetResolver({
      getCurrentBranch: async () => "main",
      getHeadShortSha: async () => "abc1234",
    });
    const target = await resolver.resolve("/repo");
    expect(target).toEqual({
      worktreePath: "/repo",
      branchName: "main",
      isolation: "worktree",
      laneId: null,
    });
  });

  it("labels a detached HEAD as detached@<shortSha> and still yields a target", async () => {
    const resolver = createProjectExecutionTargetResolver({
      getCurrentBranch: async () => null,
      getHeadShortSha: async () => "deadbee",
    });
    const target = await resolver.resolve("/repo");
    expect(target.worktreePath).toBe("/repo");
    expect(target.branchName).toBe("detached@deadbee");
    expect(target.isolation).toBe("worktree");
    expect(target.laneId).toBeNull();
  });

  it("falls back to detached@unknown when the short SHA is unavailable", async () => {
    const resolver = createProjectExecutionTargetResolver({
      getCurrentBranch: async () => null,
      getHeadShortSha: async () => null,
    });
    const target = await resolver.resolve("/repo");
    expect(target.branchName).toBe("detached@unknown");
  });
});
