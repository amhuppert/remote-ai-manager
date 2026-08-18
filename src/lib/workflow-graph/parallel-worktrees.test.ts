import { describe, expect, it, vi } from "vitest";
import { type GitClient } from "@/lib/git/client";
import type { FastRemoveInput } from "@/lib/git/worktree-fast-remove";
import { createParallelWorktrees } from "./parallel-worktrees";

describe("createParallelWorktrees.provision dirty-after-create probe", () => {
  function makeFakeClient(stdoutByCommand: Map<string, string>): GitClient {
    return {
      git: async (args: readonly string[]) => {
        const key = args.join(" ");
        const stdout = stdoutByCommand.get(key) ?? "";
        return { stdout, stderr: "" };
      },
    };
  }

  function makeLoggerSpy() {
    const warnCalls: Array<{
      message: string;
      fields?: Record<string, unknown>;
    }> = [];
    const infoCalls: Array<{
      message: string;
      fields?: Record<string, unknown>;
    }> = [];
    return {
      logger: {
        debug: () => {},
        info: (message: string, fields?: Record<string, unknown>) => {
          infoCalls.push({ message, fields });
        },
        warn: (message: string, fields?: Record<string, unknown>) => {
          warnCalls.push({ message, fields });
        },
        error: () => {},
      },
      warnCalls,
      infoCalls,
    };
  }

  it("emits provision_dirty_after_create when worktree is dirty after add, without throwing", async () => {
    const stdoutByCommand = new Map<string, string>([
      ["worktree list --porcelain", ""],
      [
        "worktree add -b csm/session-ctx1 /fake/.worktrees/session.ctx1 csm/session",
        "",
      ],
      ["status --porcelain", " M dirty-one.ts\nM  dirty-two.ts\n"],
    ]);
    const fakeClient = makeFakeClient(stdoutByCommand);
    const { logger, warnCalls } = makeLoggerSpy();

    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
      logger,
    });

    const result = await pwt.provision({
      projectPath: "/fake",
      sessionName: "session",
      sessionDir: "session",
      sessionBranch: "csm/session",
      contextId: "ctx1",
    });

    expect(result.worktreePath).toBe("/fake/.worktrees/session.ctx1");
    const dirtyWarn = warnCalls.find(
      (c) => c.message === "provision_dirty_after_create",
    );
    expect(dirtyWarn).toBeDefined();
    expect(dirtyWarn?.fields?.["dirtyCount"]).toBe(2);
    expect(dirtyWarn?.fields?.["contextId"]).toBe("ctx1");
  });

  it("does not emit dirty warning when worktree is clean after add", async () => {
    const stdoutByCommand = new Map<string, string>([
      ["worktree list --porcelain", ""],
      [
        "worktree add -b csm/session-ctx1 /fake/.worktrees/session.ctx1 csm/session",
        "",
      ],
      ["status --porcelain", ""],
    ]);
    const fakeClient = makeFakeClient(stdoutByCommand);
    const { logger, warnCalls } = makeLoggerSpy();

    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
      logger,
    });

    await pwt.provision({
      projectPath: "/fake",
      sessionName: "session",
      sessionDir: "session",
      sessionBranch: "csm/session",
      contextId: "ctx1",
    });

    expect(
      warnCalls.find((c) => c.message === "provision_dirty_after_create"),
    ).toBeUndefined();
  });
});

describe("createParallelWorktrees managed-skill checkout", () => {
  it("prepares the lane's managed-skill checkout as part of provisioning it", async () => {
    const prepared: string[] = [];
    const provisioner = createParallelWorktrees({
      gitClient: {
        git: async () => ({ stdout: "", stderr: "" }),
      },
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "csm" }),
      readRepoConfig: async () => null,
      prepareManagedSkillsCheckout: async (worktreePath) => {
        prepared.push(worktreePath);
      },
    });

    const result = await provisioner.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      laneId: "lane-a",
    });

    expect(prepared).toEqual([result.worktreePath]);
  });
});

describe("createParallelWorktrees branch prefix resolution", () => {
  function makeRecordingClient() {
    const calls: string[] = [];
    const client: GitClient = {
      git: async (args: readonly string[]) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      },
    };
    return { client, calls };
  }

  it("uses the configured global branch prefix for lane branches", async () => {
    const { client, calls } = makeRecordingClient();
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "wt" }),
      readRepoConfig: async () => null,
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "wt/session-1",
      laneId: "lane-a",
    });

    expect(result.branchName).toBe("wt/session-1-lane-a");
    expect(
      calls.some((c) =>
        c.startsWith(
          "worktree add -b wt/session-1-lane-a /repo/.worktrees/session-1.lane-a wt/session-1",
        ),
      ),
    ).toBe(true);
  });

  it("prefers the per-repo branch prefix over the global one", async () => {
    const { client } = makeRecordingClient();
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "global" }),
      readRepoConfig: async () => ({ branchPrefix: "repo" }),
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "repo/session-1",
      laneId: "lane-a",
    });

    expect(result.branchName).toBe("repo/session-1-lane-a");
  });

  it("falls back to csm when no prefix is configured", async () => {
    const { client } = makeRecordingClient();
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      laneId: "lane-a",
    });

    expect(result.branchName).toBe("csm/session-1-lane-a");
  });

  it("derives an unprefixed branch when the resolved prefix is empty", async () => {
    const { client } = makeRecordingClient();
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "" }),
      readRepoConfig: async () => null,
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "session-1",
      laneId: "lane-a",
    });

    expect(result.branchName).toBe("session-1-lane-a");
  });

  it("cleans up the worktree's actual branch when the configured prefix changed between provision and cleanup", async () => {
    const worktreePath = "/repo/.worktrees/session-1.lane-a";
    let branchPrefix = "wt";
    let provisioned = false;
    const client: GitClient = {
      git: async (args: readonly string[]) => {
        if (args.join(" ") === "worktree list --porcelain") {
          return {
            stdout: provisioned
              ? `worktree ${worktreePath}\nHEAD abc123\nbranch refs/heads/wt/session-1-lane-a\n`
              : "",
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
    };
    const fastRemoveWorktree = vi.fn(async () => ({
      status: "moved" as const,
    }));
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: (p) => provisioned && p === worktreePath,
      readGlobalConfig: async () => ({ branchPrefix }),
      readRepoConfig: async () => null,
      fastRemoveWorktree,
      stopDevServersForWorktree: async () => {},
    });

    const provisionResult = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "wt/session-1",
      laneId: "lane-a",
    });
    expect(provisionResult.branchName).toBe("wt/session-1-lane-a");
    provisioned = true;
    branchPrefix = "team";

    const result = await pwt.cleanupLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      contextId: "lane-a",
    });

    expect(result.status).toBe("removed");
    expect(fastRemoveWorktree).toHaveBeenCalledWith({
      projectPath: "/repo",
      worktreePath,
      branchName: "wt/session-1-lane-a",
    });
  });

  it("uses the branch persisted at provision time when the worktree is already gone, ignoring current config", async () => {
    const { client } = makeRecordingClient();
    const fastRemoveWorktree = vi.fn(async () => ({
      status: "moved" as const,
    }));
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "team" }),
      readRepoConfig: async () => null,
      fastRemoveWorktree,
      stopDevServersForWorktree: async () => {},
    });

    const result = await pwt.cleanupLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      contextId: "ctx-1",
      branchName: "wt/session-1-ctx-1",
    });

    expect(result.status).toBe("removed");
    expect(fastRemoveWorktree).toHaveBeenCalledWith({
      projectPath: "/repo",
      worktreePath: "/repo/.worktrees/session-1.ctx-1",
      branchName: "wt/session-1-ctx-1",
    });
  });

  it("skips branch deletion when no branch is resolvable instead of guessing from config", async () => {
    const { client } = makeRecordingClient();
    const fastRemoveCalls: FastRemoveInput[] = [];
    const fastRemoveWorktree = async (input: FastRemoveInput) => {
      fastRemoveCalls.push(input);
      return { status: "absent" as const };
    };
    const pwt = createParallelWorktrees({
      gitClient: client,
      existsSync: () => false,
      readGlobalConfig: async () => ({ branchPrefix: "team" }),
      readRepoConfig: async () => null,
      fastRemoveWorktree,
      stopDevServersForWorktree: async () => {},
    });

    const result = await pwt.cleanupLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      contextId: "ctx-1",
    });

    expect(result.status).toBe("removed");
    expect(fastRemoveCalls).toHaveLength(1);
    expect(fastRemoveCalls[0]?.projectPath).toBe("/repo");
    expect(fastRemoveCalls[0]?.worktreePath).toBe(
      "/repo/.worktrees/session-1.ctx-1",
    );
    expect(fastRemoveCalls[0]?.branchName).toBeUndefined();
  });
});

describe("createParallelWorktrees.dispose stop-before-remove", () => {
  it("stops dev servers in the worktree before removing it", async () => {
    const order: string[] = [];
    const stopDevServersForWorktree = vi.fn(async () => {
      order.push("stop");
    });
    const fastRemoveWorktree = vi.fn(async () => {
      order.push("remove");
      return { status: "moved" as const };
    });

    const pwt = createParallelWorktrees({
      stopDevServersForWorktree,
      fastRemoveWorktree,
    });

    const result = await pwt.dispose({
      projectPath: "/fake",
      worktreePath: "/fake/.worktrees/session.ctx1",
      branchName: "csm/session-ctx1",
    });

    expect(result.status).toBe("removed");
    expect(order).toEqual(["stop", "remove"]);
    expect(stopDevServersForWorktree).toHaveBeenCalledWith({
      projectPath: "/fake",
      worktreePath: "/fake/.worktrees/session.ctx1",
    });
  });

  it("removes the worktree even when stopping dev servers throws", async () => {
    const fastRemoveWorktree = vi.fn(async () => ({
      status: "moved" as const,
    }));
    const stopDevServersForWorktree = vi.fn(async () => {
      throw new Error("stop failed");
    });

    const pwt = createParallelWorktrees({
      stopDevServersForWorktree,
      fastRemoveWorktree,
    });

    const result = await pwt.dispose({
      projectPath: "/fake",
      worktreePath: "/fake/.worktrees/session.ctx1",
      branchName: "csm/session-ctx1",
    });

    expect(result.status).toBe("removed");
    expect(fastRemoveWorktree).toHaveBeenCalledTimes(1);
  });
});
