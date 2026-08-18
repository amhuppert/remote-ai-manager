import { describe, expect, it } from "vitest";
import { type GitClient } from "@/lib/git/client";
import { validateLaneId } from "./lane-identity";
import {
  createParallelWorktrees,
  deriveLaneTargets,
} from "./parallel-worktrees";

function makeFakeClient(
  stdoutByCommand: Map<string, string>,
  errorsByCommand?: Map<string, Error>,
): GitClient {
  return {
    git: async (args: readonly string[]) => {
      const key = args.join(" ");
      const error = errorsByCommand?.get(key);
      if (error) throw error;
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

describe("validateLaneId", () => {
  it("accepts allowed identifiers (letters, digits, underscore, dot, dash)", () => {
    expect(() => validateLaneId("ctx1")).not.toThrow();
    expect(() => validateLaneId("plan_step.2")).not.toThrow();
    expect(() => validateLaneId("a-b-c")).not.toThrow();
  });

  it("rejects identifiers that start with '.' or '-'", () => {
    expect(() => validateLaneId(".hidden")).toThrow(/must not start with/);
    expect(() => validateLaneId("-leading-dash")).toThrow(
      /must not start with/,
    );
  });

  it("rejects identifiers containing '..'", () => {
    expect(() => validateLaneId("foo..bar")).toThrow(/must not contain/);
  });

  it("rejects identifiers ending with '.', '-', or '.lock'", () => {
    expect(() => validateLaneId("trailing.")).toThrow(/must not end with/);
    expect(() => validateLaneId("trailing-")).toThrow(/must not end with/);
    expect(() => validateLaneId("file.lock")).toThrow(/must not end with/);
  });

  it("rejects identifiers with disallowed characters", () => {
    expect(() => validateLaneId("ctx/slash")).toThrow(/must match/);
    expect(() => validateLaneId("ctx space")).toThrow(/must match/);
    expect(() => validateLaneId("ctx!")).toThrow(/must match/);
  });
});

describe("deriveLaneTargets", () => {
  it("derives deterministic safe lane worktree path and branch name", () => {
    const targets = deriveLaneTargets({
      projectPath: "/repo",
      sessionDir: "feature-session",
      laneId: "lane-a",
      branchPrefix: "csm",
    });

    expect(targets.worktreePath).toBe(
      "/repo/.worktrees/feature-session.lane-a",
    );
    expect(targets.branchName).toBe("csm/feature-session-lane-a");
  });

  it("is stable across calls with the same input", () => {
    const a = deriveLaneTargets({
      projectPath: "/r",
      sessionDir: "s",
      laneId: "lane-x",
      branchPrefix: "csm",
    });
    const b = deriveLaneTargets({
      projectPath: "/r",
      sessionDir: "s",
      laneId: "lane-x",
      branchPrefix: "csm",
    });
    expect(a).toEqual(b);
  });
});

describe("createParallelWorktrees.provisionLane", () => {
  it("creates a lane-stable branch and worktree using the laneId", async () => {
    const calls: string[] = [];
    const fakeClient: GitClient = {
      git: async (args) => {
        const key = args.join(" ");
        calls.push(key);
        if (key === "worktree list --porcelain")
          return { stdout: "", stderr: "" };
        if (key === "status --porcelain") return { stdout: "", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    };
    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      laneId: "lane-alpha",
    });

    expect(result.worktreePath).toBe("/repo/.worktrees/session-1.lane-alpha");
    expect(result.branchName).toBe("csm/session-1-lane-alpha");
    expect(
      calls.some((c) =>
        c.startsWith(
          "worktree add -b csm/session-1-lane-alpha /repo/.worktrees/session-1.lane-alpha csm/session-1",
        ),
      ),
    ).toBe(true);
  });

  it("is idempotent: returns existing targets when worktree exists on the expected lane branch", async () => {
    const stdoutByCommand = new Map<string, string>([
      [
        "worktree list --porcelain",
        "worktree /repo/.worktrees/session-1.lane-x\nbranch refs/heads/csm/session-1-lane-x\n",
      ],
    ]);
    const fakeClient = makeFakeClient(stdoutByCommand);
    const { logger, infoCalls } = makeLoggerSpy();

    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => true,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
      logger,
    });

    const result = await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      laneId: "lane-x",
    });

    expect(result.worktreePath).toBe("/repo/.worktrees/session-1.lane-x");
    expect(result.branchName).toBe("csm/session-1-lane-x");
    expect(infoCalls.some((c) => c.message === "provision_idempotent")).toBe(
      true,
    );
  });

  it("rejects unsafe lane ids before touching git", async () => {
    const calls: string[] = [];
    const fakeClient: GitClient = {
      git: async (args) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: "" };
      },
    };
    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
    });

    await expect(
      pwt.provisionLane({
        projectPath: "/repo",
        sessionName: "s",
        sessionDir: "s",
        sessionBranch: "csm/s",
        laneId: "../escape",
      }),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it("rolls back already-provisioned lanes in a batch on later failure", async () => {
    const stdoutByCommand = new Map<string, string>([
      ["worktree list --porcelain", ""],
      [
        "worktree add -b csm/session-1-lane-a /repo/.worktrees/session-1.lane-a csm/session-1",
        "",
      ],
      ["status --porcelain", ""],
      ["worktree remove --force /repo/.worktrees/session-1.lane-a", ""],
      ["branch -D csm/session-1-lane-a", ""],
    ]);
    const failingAdd = new Error("simulated add failure");
    const errorsByCommand = new Map<string, Error>([
      [
        "worktree add -b csm/session-1-lane-b /repo/.worktrees/session-1.lane-b csm/session-1",
        failingAdd,
      ],
    ]);
    const fakeClient = makeFakeClient(stdoutByCommand, errorsByCommand);
    const { logger, warnCalls } = makeLoggerSpy();

    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
      logger,
    });

    await expect(
      pwt.provisionLaneBatch([
        {
          projectPath: "/repo",
          sessionName: "session-1",
          sessionDir: "session-1",
          sessionBranch: "csm/session-1",
          laneId: "lane-a",
        },
        {
          projectPath: "/repo",
          sessionName: "session-1",
          sessionDir: "session-1",
          sessionBranch: "csm/session-1",
          laneId: "lane-b",
        },
      ]),
    ).rejects.toThrow(/simulated add failure/);

    expect(
      warnCalls.some((c) => c.message === "provision_batch_rollback"),
    ).toBe(true);
  });

  it("preserves per-context provision behavior as a one-context lane", async () => {
    const calls: string[] = [];
    const fakeClient: GitClient = {
      git: async (args) => {
        const key = args.join(" ");
        calls.push(key);
        return { stdout: "", stderr: "" };
      },
    };
    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      existsSync: () => false,
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => null,
    });

    const fromContext = await pwt.provision({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      contextId: "ctx-foo",
    });

    const fromLane = deriveLaneTargets({
      projectPath: "/repo",
      sessionDir: "session-1",
      laneId: "ctx-foo",
      branchPrefix: "csm",
    });

    expect({
      worktreePath: fromContext.worktreePath,
      branchName: fromContext.branchName,
    }).toEqual(fromLane);
  });

  it("passes the session worktree as PARENT_WORKTREE_PATH to the lane init script", async () => {
    const fakeClient = makeFakeClient(new Map<string, string>());

    const initCalls: Array<{
      cmd: string;
      args: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }> = [];

    const pwt = createParallelWorktrees({
      gitClient: fakeClient,
      // Worktree dir absent (so provisioning proceeds); init script present.
      existsSync: (p: string) => p.includes("init.sh"),
      readGlobalConfig: async () => ({}),
      readRepoConfig: async () => ({ initScriptPath: "./init.sh" }),
      buildChildEnv: () => ({ NODE_ENV: "test" as const }),
      execFileAsync: async (cmd, args, opts) => {
        initCalls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env });
        return { stdout: "", stderr: "" };
      },
    });

    await pwt.provisionLane({
      projectPath: "/repo",
      sessionName: "session-1",
      sessionDir: "session-1",
      sessionBranch: "csm/session-1",
      laneId: "lane-a",
    });

    expect(initCalls).toHaveLength(1);
    const env = initCalls[0]!.env;
    // Parent = the session's own worktree the lane was branched from.
    expect(env?.PARENT_WORKTREE_PATH).toBe("/repo/.worktrees/session-1");
    expect(env?.WORKTREE_PATH).toBe("/repo/.worktrees/session-1.lane-a");
    expect(env?.PROJECT_ROOT).toBe("/repo");
  });
});
