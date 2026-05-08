import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import { ExecFileGitClient, type GitClient } from "@/lib/git-client";
import { createParallelWorktrees } from "./parallel-worktrees";

const tempDirs: string[] = [];

async function makeRepo(): Promise<{
  projectPath: string;
  sessionDir: string;
  sessionBranch: string;
  gitClient: GitClient;
}> {
  const projectPath = await mkdtemp(path.join(tmpdir(), "cc-pwt-test-"));
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

  const sessionDir = "feature-abc123";
  const sessionBranch = `csm/${sessionDir}`;
  await gitClient.git(["checkout", "-b", sessionBranch], projectPath);
  await gitClient.git(["checkout", "main"], projectPath);

  return { projectPath, sessionDir, sessionBranch, gitClient };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createParallelWorktrees.provision", () => {
  it("provisions a worktree on a new branch from the session branch", async () => {
    const { projectPath, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const result = await pwt.provision({
      projectPath,
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
    const { projectPath, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const first = await pwt.provision({
      projectPath,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });
    const second = await pwt.provision({
      projectPath,
      sessionDir,
      sessionBranch,
      contextId: "ctx1",
    });

    expect(second).toEqual(first);
  });

  it("fails idempotency check if worktree exists with mismatched branch", async () => {
    const { projectPath, sessionDir, sessionBranch, gitClient } =
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
      const { projectPath, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      await expect(
        pwt.provision({
          projectPath,
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
      const { projectPath, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      const result = await pwt.provision({
        projectPath,
        sessionDir,
        sessionBranch,
        contextId: goodId,
      });
      expect(result.branchName).toBe(`csm/${sessionDir}-${goodId}`);
    });
  });

  describe("provisionBatch", () => {
    it("provisions all contexts in a batch", async () => {
      const { projectPath, sessionDir, sessionBranch, gitClient } =
        await makeRepo();
      const pwt = createParallelWorktrees({ gitClient });

      const results = await pwt.provisionBatch([
        { projectPath, sessionDir, sessionBranch, contextId: "a" },
        { projectPath, sessionDir, sessionBranch, contextId: "b" },
      ]);

      expect(results).toHaveLength(2);
      expect(existsSync(results[0]!.worktreePath)).toBe(true);
      expect(existsSync(results[1]!.worktreePath)).toBe(true);
    });

    it("rejects an invalid contextId before any git worktree command runs", async () => {
      const { projectPath, sessionDir, sessionBranch } = await makeRepo();
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
          { projectPath, sessionDir, sessionBranch, contextId: "a" },
          {
            projectPath,
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
      const { projectPath, sessionDir, sessionBranch } = await makeRepo();
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
          { projectPath, sessionDir, sessionBranch, contextId: "a" },
          { projectPath, sessionDir, sessionBranch, contextId: "b" },
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
});

describe("createParallelWorktrees.dispose", () => {
  it("removes the worktree and deletes the branch", async () => {
    const { projectPath, sessionDir, sessionBranch, gitClient } =
      await makeRepo();
    const pwt = createParallelWorktrees({ gitClient });

    const { worktreePath, branchName } = await pwt.provision({
      projectPath,
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
