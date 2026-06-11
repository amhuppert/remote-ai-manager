import { describe, it, expect, vi } from "vitest";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { createMergeTargetResolver } from "./merge-target";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "feature-x",
    branchName: "csm/feature-x",
    worktreePath: "/repo/.worktrees/feature-x",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("resolveMergeTarget", () => {
  it("resolves a normal session to main with no target worktree", async () => {
    const getSession = vi.fn();
    const resolve = createMergeTargetResolver({ getSession });

    const result = await resolve("/repo", makeSession());

    expect(result).toEqual({ targetBranch: "main", targetWorktreePath: null });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("resolves a child-branch session to the parent session's worktree", async () => {
    const parent = makeSession({
      sessionName: "parent",
      branchName: "csm/parent",
      worktreePath: "/repo/.worktrees/parent",
    });
    const getSession = vi.fn(async () => parent);
    const resolve = createMergeTargetResolver({ getSession });

    const session = makeSession({
      targetBranch: "csm/parent",
      parentSessionName: "parent",
    });
    const result = await resolve("/repo", session);

    expect(result).toEqual({
      targetBranch: "csm/parent",
      targetWorktreePath: "/repo/.worktrees/parent",
    });
    expect(getSession).toHaveBeenCalledWith("/repo", "parent");
  });

  it("returns null worktree when the parent session no longer exists", async () => {
    const getSession = vi.fn(async () => null);
    const resolve = createMergeTargetResolver({ getSession });

    const session = makeSession({
      targetBranch: "csm/parent",
      parentSessionName: "parent",
    });
    const result = await resolve("/repo", session);

    expect(result).toEqual({
      targetBranch: "csm/parent",
      targetWorktreePath: null,
    });
  });

  it("skips parent lookup when targeting non-main without a parent session", async () => {
    const getSession = vi.fn();
    const resolve = createMergeTargetResolver({ getSession });

    const session = makeSession({
      targetBranch: "develop",
      parentSessionName: null,
    });
    const result = await resolve("/repo", session);

    expect(result).toEqual({
      targetBranch: "develop",
      targetWorktreePath: null,
    });
    expect(getSession).not.toHaveBeenCalled();
  });
});
