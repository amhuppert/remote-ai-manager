import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { ExecFileGitClient, type GitClient } from "@/lib/git-client";
import {
  createParallelWorktrees,
  type ParallelWorktreesDeps,
} from "./parallel-worktrees";

// Hard sandbox: refuse to let git climb above the OS temp dir when looking
// for a repository. Without this, a partially-initialized temp repo could
// fall through to an ancestor .git and pollute the host worktree.
const HOST_TMPDIR = tmpdir();
const ORIGINAL_GIT_CEILING = process.env["GIT_CEILING_DIRECTORIES"];
beforeAll(() => {
  process.env["GIT_CEILING_DIRECTORIES"] = HOST_TMPDIR;
});
afterAll(() => {
  if (ORIGINAL_GIT_CEILING === undefined) {
    delete process.env["GIT_CEILING_DIRECTORIES"];
  } else {
    process.env["GIT_CEILING_DIRECTORIES"] = ORIGINAL_GIT_CEILING;
  }
});

const tempDirs: string[] = [];

async function makeRepo(): Promise<{
  projectPath: string;
  sessionName: string;
  sessionDir: string;
  sessionBranch: string;
  gitClient: GitClient;
}> {
  const projectPath = await mkdtemp(path.join(HOST_TMPDIR, "cc-pwt-test-"));
  if (!path.resolve(projectPath).startsWith(path.resolve(HOST_TMPDIR))) {
    throw new Error(
      `Refusing to run test: projectPath ${projectPath} is not under tmpdir ${HOST_TMPDIR}`,
    );
  }
  tempDirs.push(projectPath);
  const gitClient = new ExecFileGitClient();

  await gitClient.git(["init", "--initial-branch=main"], projectPath);
  await gitClient.git(
    ["config", "user.email", "test@example.com"],
    projectPath,
  );
  await gitClient.git(["config", "user.name", "Test"], projectPath);
  await writeFile(path.join(projectPath, "README.md"), "init\n");
  await gitClient.git(["add", "README.md"], projectPath);
  await gitClient.git(["commit", "-m", "init"], projectPath);

  const sessionName = "Feature ABC 123";
  const sessionDir = "feature-abc123";
  const sessionBranch = `csm/${sessionDir}`;
  await gitClient.git(["checkout", "-b", sessionBranch], projectPath);
  await gitClient.git(["checkout", "main"], projectPath);

  return { projectPath, sessionName, sessionDir, sessionBranch, gitClient };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createParallelWorktrees.provision", () => {
  it("provisions a worktree on a new branch from the session branch", async () => {
    const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const result = await pwt.provision({
      projectPath,
      sessionName,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });

    expect(result.worktreePath).toBe(
      path.join(projectPath, ".worktrees", `${sessionDir}.ctx1`),
    );
    expect(result.branchName).toBe(`csm/${sessionDir}-ctx1`);
    expect(existsSync(result.worktreePath)).toBe(true);

    const { stdout: branches } = await gitClient.git(
      ["branch", "--list", result.branchName],
      projectPath,
    );
    expect(branches).toContain(result.branchName);
  });

  it("is idempotent: returns same result if worktree already exists with matching branch", async () => {
    const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const first = await pwt.provision({
      projectPath,
      sessionName,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });
    const second = await pwt.provision({
      projectPath,
      sessionName,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });

    expect(second).toEqual(first);
  });

  it("fails idempotency check if worktree exists with mismatched branch", async () => {
    const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const worktreePath = path.join(
      projectPath,
      ".worktrees",
      `${sessionDir}.ctx1`,
    );
    await gitClient.git(
      ["worktree", "add", "-b", "wrong-branch", worktreePath, sessionBranch],
      projectPath,
    );

    await expect(
      pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      }),
    ).rejects.toThrow(/branch/i);
  });

  describe("contextId validation", () => {
    it.each([
      ["empty", ""],
      ["dot-traversal", "../escape"],
      ["leading dot", ".hidden"],
      ["leading dash", "-flag"],
      ["slash", "a/b"],
      ["space", "a b"],
      ["colon", "a:b"],
      ["tilde", "a~b"],
      ["caret", "a^b"],
      ["question", "a?b"],
      ["asterisk", "a*b"],
      ["null byte", "a\0b"],
      ["consecutive dots", "ctx..one"],
      ["trailing dot", "ctx."],
      ["trailing dash", "ctx-"],
      ["trailing .lock", "ctx.lock"],
    ])("rejects contextId %s", async (_label, badId) => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      await expect(
        pwt.provision({
          projectPath,
          sessionName,
          sessionDir,
          sessionBranch,
          contextId: badId,
        }),
      ).rejects.toThrow(/contextId/i);

      expect(existsSync(path.join(projectPath, ".worktrees"))).toBe(false);
    });

    it.each([
      ["alphanum", "abc123"],
      ["underscore", "ctx_one"],
      ["dash inside", "ctx-one"],
      ["dot inside", "ctx.one"],
    ])("accepts contextId %s", async (_label, goodId) => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      const result = await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: goodId,
      });
      expect(result.branchName).toBe(`csm/${sessionDir}-${goodId}`);
    });
  });

  describe("provisionBatch", () => {
    it("provisions all contexts in a batch", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      const results = await pwt.provisionBatch([
        { projectPath, sessionName, sessionDir, sessionBranch, contextId: "a" },
        { projectPath, sessionName, sessionDir, sessionBranch, contextId: "b" },
      ]);

      expect(results).toHaveLength(2);
      expect(existsSync(results[0]!.worktreePath)).toBe(true);
      expect(existsSync(results[1]!.worktreePath)).toBe(true);
    });

    it("rejects an invalid contextId before any git worktree command runs", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch } =
        await makeRepo();
      const calls: string[][] = [];
      const trackingClient: GitClient = {
        async git(args, cwd) {
          calls.push(args);
          return new ExecFileGitClient().git(args, cwd);
        },
      };
      const pwt = createParallelWorktrees({ gitClient: trackingClient });

      await expect(
        pwt.provisionBatch([
          {
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch,
            contextId: "a",
          },
          {
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch,
            contextId: "../bad",
          },
        ]),
      ).rejects.toThrow(/contextId/i);

      expect(calls.some((a) => a[0] === "worktree" && a[1] === "add")).toBe(
        false,
      );
      const aWorktreePath = path.join(
        projectPath,
        ".worktrees",
        `${sessionDir}.a`,
      );
      expect(existsSync(aWorktreePath)).toBe(false);
    });

    it("rolls back already-created worktrees when a later git operation fails", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch } =
        await makeRepo();
      const realClient = new ExecFileGitClient();
      let addCalls = 0;
      const flakyClient: GitClient = {
        async git(args, cwd) {
          if (args[0] === "worktree" && args[1] === "add") {
            addCalls += 1;
            if (addCalls === 2) {
              throw new Error("simulated worktree add failure");
            }
          }
          return realClient.git(args, cwd);
        },
      };
      const pwt = createParallelWorktrees({ gitClient: flakyClient });

      await expect(
        pwt.provisionBatch([
          {
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch,
            contextId: "a",
          },
          {
            projectPath,
            sessionName,
            sessionDir,
            sessionBranch,
            contextId: "b",
          },
        ]),
      ).rejects.toThrow(/simulated worktree add failure/);

      const aWorktreePath = path.join(
        projectPath,
        ".worktrees",
        `${sessionDir}.a`,
      );
      expect(existsSync(aWorktreePath)).toBe(false);
      const { stdout: branches } = await realClient.git(
        ["branch", "--list", `csm/${sessionDir}-a`],
        projectPath,
      );
      expect(branches.trim()).toBe("");
    });
  });

  describe("init script", () => {
    it("does not invoke execFileAsync when readRepoConfig returns null", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const execCalls: Array<{ file: string }> = [];
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => null,
        execFileAsync: (async (file: string) => {
          execCalls.push({ file });
          return { stdout: "", stderr: "" };
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });

      expect(execCalls).toEqual([]);
    });

    it("does not invoke execFileAsync when initScriptPath is unset", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const execCalls: Array<{ file: string }> = [];
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: null }),
        execFileAsync: (async (file: string) => {
          execCalls.push({ file });
          return { stdout: "", stderr: "" };
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });

      expect(execCalls).toEqual([]);
    });

    it("runs the init script with the documented env after worktree creation", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      await writeFile(
        path.join(projectPath, "init.sh"),
        "#!/bin/sh\nexit 0\n",
        {
          mode: 0o755,
        },
      );
      const calls: Array<{
        file: string;
        cwd: string | undefined;
        env: NodeJS.ProcessEnv | undefined;
      }> = [];
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: "init.sh" }),
        execFileAsync: (async (
          file: string,
          _args: readonly string[] | null | undefined,
          opts: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined,
        ) => {
          calls.push({
            file,
            cwd: opts?.cwd,
            env: opts?.env,
          });
          return { stdout: "", stderr: "" };
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () =>
          ({ ...process.env, BASE_ENV: "set" }) as NodeJS.ProcessEnv,
      });

      const result = await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.file).toBe(path.join(projectPath, "init.sh"));
      expect(calls[0]!.cwd).toBe(result.worktreePath);
      expect(calls[0]!.env).toMatchObject({
        BASE_ENV: "set",
        PROJECT_ROOT: projectPath,
        CLAUDE_PROJECT_DIR: projectPath,
        WORKTREE_PATH: result.worktreePath,
        SESSION_NAME: sessionName,
        BRANCH_NAME: result.branchName,
        CONTEXT_ID: "ctx1",
      });
    });

    it("resolves an absolute initScriptPath without prepending projectPath", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const absScript = path.join(projectPath, "abs-init.sh");
      await writeFile(absScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const calls: Array<{ file: string }> = [];
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: absScript }),
        execFileAsync: (async (file: string) => {
          calls.push({ file });
          return { stdout: "", stderr: "" };
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });

      expect(calls[0]!.file).toBe(absScript);
    });

    it("throws and disposes the worktree if the init script is missing on disk", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: "missing-init.sh" }),
        execFileAsync: (async () => {
          throw new Error("execFileAsync should not be called");
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await expect(
        pwt.provision({
          projectPath,
          sessionName,
          sessionDir,
          sessionBranch,
          contextId: "ctx1",
        }),
      ).rejects.toThrow(/init script not found/i);

      const worktreePath = path.join(
        projectPath,
        ".worktrees",
        `${sessionDir}.ctx1`,
      );
      expect(existsSync(worktreePath)).toBe(false);
      const { stdout: branches } = await gitClient.git(
        ["branch", "--list", `csm/${sessionDir}-ctx1`],
        projectPath,
      );
      expect(branches.trim()).toBe("");
    });

    it("throws and disposes the worktree if the init script exits non-zero", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      await writeFile(
        path.join(projectPath, "init.sh"),
        "#!/bin/sh\nexit 7\n",
        {
          mode: 0o755,
        },
      );
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: "init.sh" }),
        execFileAsync: (async () => {
          throw new Error("init script failed: exit 7");
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await expect(
        pwt.provision({
          projectPath,
          sessionName,
          sessionDir,
          sessionBranch,
          contextId: "ctx1",
        }),
      ).rejects.toThrow(/init script failed: exit 7/);

      const worktreePath = path.join(
        projectPath,
        ".worktrees",
        `${sessionDir}.ctx1`,
      );
      expect(existsSync(worktreePath)).toBe(false);
      const { stdout: branches } = await gitClient.git(
        ["branch", "--list", `csm/${sessionDir}-ctx1`],
        projectPath,
      );
      expect(branches.trim()).toBe("");
    });

    it("does not re-run the init script on idempotent re-provision", async () => {
      const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      await writeFile(
        path.join(projectPath, "init.sh"),
        "#!/bin/sh\nexit 0\n",
        {
          mode: 0o755,
        },
      );
      let execCount = 0;
      const pwt = createParallelWorktrees({
        gitClient,
        readRepoConfig: async () => ({ initScriptPath: "init.sh" }),
        execFileAsync: (async () => {
          execCount += 1;
          return { stdout: "", stderr: "" };
        }) as unknown as ParallelWorktreesDeps["execFileAsync"],
        buildChildEnv: () => process.env,
      });

      await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });
      await pwt.provision({
        projectPath,
        sessionName,
        sessionDir,
        sessionBranch,
        contextId: "ctx1",
      });

      expect(execCount).toBe(1);
    });
  });
});

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

describe("createParallelWorktrees.dispose", () => {
  it("removes the worktree and deletes the branch", async () => {
    const { projectPath, sessionName, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const { worktreePath, branchName } = await pwt.provision({
      projectPath,
      sessionName,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });

    const result = await pwt.dispose({
      projectPath,
      worktreePath,
      branchName,
    });

    expect(result).toEqual({ status: "removed" });
    expect(existsSync(worktreePath)).toBe(false);

    const { stdout: branches } = await gitClient.git(
      ["branch", "--list", branchName],
      projectPath,
    );
    expect(branches.trim()).toBe("");
  });

  it("returns failed status and runs prune fallback when remove fails", async () => {
    const { projectPath, sessionDir } = await makeRepo();
    const calls: string[][] = [];
    const failingClient: GitClient = {
      async git(args, _cwd) {
        calls.push(args);
        if (args[0] === "worktree" && args[1] === "remove") {
          throw new Error("worktree remove failed");
        }
        return { stdout: "", stderr: "" };
      },
    };
    const pwt = createParallelWorktrees({ gitClient: failingClient });

    const result = await pwt.dispose({
      projectPath,
      worktreePath: path.join(projectPath, ".worktrees", `${sessionDir}.ctx1`),
      branchName: `csm/${sessionDir}-ctx1`,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/worktree remove failed/);
    }
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "prune")).toBe(
      true,
    );
  });

  it("returns failed status when branch delete fails", async () => {
    const { projectPath, sessionDir } = await makeRepo();
    const failingClient: GitClient = {
      async git(args, _cwd) {
        if (args[0] === "branch" && args[1] === "-D") {
          throw new Error("branch delete failed");
        }
        return { stdout: "", stderr: "" };
      },
    };
    const pwt = createParallelWorktrees({ gitClient: failingClient });

    const result = await pwt.dispose({
      projectPath,
      worktreePath: path.join(projectPath, ".worktrees", `${sessionDir}.ctx1`),
      branchName: `csm/${sessionDir}-ctx1`,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toMatch(/branch delete failed/);
    }
  });

  it("never throws on git failures", async () => {
    const { projectPath, sessionDir } = await makeRepo();
    const explodingClient: GitClient = {
      async git() {
        throw new Error("everything broken");
      },
    };
    const pwt = createParallelWorktrees({ gitClient: explodingClient });

    await expect(
      pwt.dispose({
        projectPath,
        worktreePath: path.join(
          projectPath,
          ".worktrees",
          `${sessionDir}.ctx1`,
        ),
        branchName: `csm/${sessionDir}-ctx1`,
      }),
    ).resolves.toBeDefined();
  });
});
