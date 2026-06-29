import { describe, expect, it, vi } from "vitest";
import { type GitClient } from "@/lib/git/client";
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
