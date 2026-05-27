import { describe, expect, it, vi } from "vitest";
import {
  fastRemoveWorktree,
  type FastRemoveDeps,
} from "./worktree-fast-remove";

interface HarnessOptions {
  exists?: boolean;
  renameImpl?: (src: string, dst: string) => Promise<void>;
  rmImpl?: (p: string) => Promise<void>;
  backgroundRmImpl?: (p: string) => Promise<void>;
  gitImpl?: (
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  now?: number;
  random?: string;
}

function makeHarness(opts: HarnessOptions = {}) {
  const renameSpy = vi.fn(opts.renameImpl ?? (async () => undefined));
  const rmSpy = vi.fn(async (p: string, _o) => {
    if (opts.rmImpl) await opts.rmImpl(p);
  });
  const mkdirSpy = vi.fn(async () => undefined);
  const backgroundRmSpy = vi.fn(
    opts.backgroundRmImpl ?? (async () => undefined),
  );
  const gitSpy = vi.fn(
    opts.gitImpl ?? (async () => ({ stdout: "", stderr: "" })),
  );
  const warnSpy = vi.fn();
  const infoSpy = vi.fn();
  const errorSpy = vi.fn();
  const debugSpy = vi.fn();

  const deps: FastRemoveDeps = {
    gitClient: { git: gitSpy },
    existsSync: () => opts.exists ?? true,
    rename: renameSpy,
    mkdir: mkdirSpy,
    rm: rmSpy,
    backgroundRm: backgroundRmSpy,
    logger: {
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    },
    now: () => opts.now ?? 1700000000000,
    randomSuffix: () => opts.random ?? "abc123",
  };

  return {
    deps,
    spies: {
      rename: renameSpy,
      rm: rmSpy,
      mkdir: mkdirSpy,
      backgroundRm: backgroundRmSpy,
      git: gitSpy,
      warn: warnSpy,
      info: infoSpy,
      error: errorSpy,
    },
  };
}

describe("fastRemoveWorktree", () => {
  it("renames worktree into .trash, prunes git admin, and schedules background rm", async () => {
    const { deps, spies } = makeHarness({ now: 999, random: "xy" });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
      },
      deps,
    );

    expect(result.status).toBe("moved");
    expect(result.trashPath).toBe("/repo/.worktrees/.trash/feat-1-999-xy");
    expect(spies.rename).toHaveBeenCalledWith(
      "/repo/.worktrees/feat-1",
      "/repo/.worktrees/.trash/feat-1-999-xy",
    );
    expect(spies.mkdir).toHaveBeenCalledWith("/repo/.worktrees/.trash", {
      recursive: true,
    });
    expect(spies.git).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    expect(spies.backgroundRm).toHaveBeenCalledWith(
      "/repo/.worktrees/.trash/feat-1-999-xy",
    );
  });

  it("also deletes branch when branchName is supplied", async () => {
    const { deps, spies } = makeHarness();

    await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
        branchName: "csm/feat-1",
      },
      deps,
    );

    expect(spies.git).toHaveBeenCalledWith(
      ["branch", "-D", "csm/feat-1"],
      "/repo",
    );
  });

  it("does not delete branch when branchName is omitted", async () => {
    const { deps, spies } = makeHarness();

    await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
      },
      deps,
    );

    const branchCalls = spies.git.mock.calls.filter(
      (c) => c[0][0] === "branch",
    );
    expect(branchCalls).toEqual([]);
  });

  it("returns absent and skips git work when worktree does not exist", async () => {
    const { deps, spies } = makeHarness({ exists: false });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/missing",
      },
      deps,
    );

    expect(result.status).toBe("absent");
    expect(spies.rename).not.toHaveBeenCalled();
    expect(spies.backgroundRm).not.toHaveBeenCalled();
    expect(spies.git).not.toHaveBeenCalled();
  });

  it("still deletes branch when worktree is absent but branchName supplied", async () => {
    const { deps, spies } = makeHarness({ exists: false });

    await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/missing",
        branchName: "csm/stale",
      },
      deps,
    );

    expect(spies.git).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
    expect(spies.git).toHaveBeenCalledWith(
      ["branch", "-D", "csm/stale"],
      "/repo",
    );
  });

  it("falls back to synchronous rm when rename fails", async () => {
    const renameErr = new Error("EXDEV: cross-device");
    const { deps, spies } = makeHarness({
      renameImpl: async () => {
        throw renameErr;
      },
    });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
      },
      deps,
    );

    expect(result.status).toBe("fallback");
    expect(result.reason).toContain("cross-device");
    expect(spies.rm).toHaveBeenCalledWith("/repo/.worktrees/feat-1", {
      recursive: true,
      force: true,
    });
    // No background rm needed when fallback already removed the dir
    expect(spies.backgroundRm).not.toHaveBeenCalled();
    // Git prune still runs to clean stale admin entry
    expect(spies.git).toHaveBeenCalledWith(["worktree", "prune"], "/repo");
  });

  it("throws when both rename and fallback rm fail", async () => {
    const { deps } = makeHarness({
      renameImpl: async () => {
        throw new Error("rename failed");
      },
      rmImpl: async () => {
        throw new Error("rm failed");
      },
    });

    await expect(
      fastRemoveWorktree(
        {
          projectPath: "/repo",
          worktreePath: "/repo/.worktrees/feat-1",
        },
        deps,
      ),
    ).rejects.toThrow("rm failed");
  });

  it("treats git prune failure as non-fatal", async () => {
    const { deps, spies } = makeHarness({
      gitImpl: async (args) => {
        if (args[0] === "worktree" && args[1] === "prune") {
          throw new Error("prune failed");
        }
        return { stdout: "", stderr: "" };
      },
    });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
      },
      deps,
    );

    expect(result.status).toBe("moved");
    expect(spies.warn).toHaveBeenCalled();
  });

  it("treats branch -D failure as non-fatal", async () => {
    const { deps, spies } = makeHarness({
      gitImpl: async (args) => {
        if (args[0] === "branch" && args[1] === "-D") {
          throw new Error("branch is checked out");
        }
        return { stdout: "", stderr: "" };
      },
    });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
        branchName: "csm/feat-1",
      },
      deps,
    );

    expect(result.status).toBe("moved");
    expect(spies.warn).toHaveBeenCalled();
  });

  it("returns before background rm settles so foreground is not blocked", async () => {
    let releaseBackground!: () => void;
    const slowBackground = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });

    const { deps } = makeHarness({
      backgroundRmImpl: () => slowBackground,
    });

    const result = await fastRemoveWorktree(
      {
        projectPath: "/repo",
        worktreePath: "/repo/.worktrees/feat-1",
      },
      deps,
    );

    expect(result.status).toBe("moved");

    let finished = false;
    void result.backgroundCleanup!.then(() => {
      finished = true;
    });

    // Without releasing the background rm, it should remain pending.
    await Promise.resolve();
    expect(finished).toBe(false);

    releaseBackground();
    await result.backgroundCleanup;
    expect(finished).toBe(true);
  });
});
