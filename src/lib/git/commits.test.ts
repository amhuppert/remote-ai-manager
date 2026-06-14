import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GitClient } from "./client";
import { createCommitsOperations } from "./commits";
import { buildChildEnv } from "../shared/child-env";

const execFileAsync = promisify(execFile);

const gitMock = vi.fn();

const testClient: GitClient = {
  git: gitMock,
};

const ops = createCommitsOperations(testClient);

// Backed by the real GitClient for temp-repo fixture tests.
const realOps = createCommitsOperations();

const { parseDiffMock } = vi.hoisted(() => ({
  parseDiffMock: vi.fn(),
}));

vi.mock("./diff", () => ({
  parseDiff: parseDiffMock,
}));

function mockGitSuccess(stdout = "", stderr = "") {
  gitMock.mockResolvedValue({ stdout, stderr });
}

function mockGitFailure(error: Error) {
  gitMock.mockRejectedValue(error);
}

function mockGitSequence(
  results: Array<{ error?: Error; stdout?: string; stderr?: string }>,
) {
  for (const result of results) {
    if (result.error) {
      gitMock.mockRejectedValueOnce(result.error);
    } else {
      gitMock.mockResolvedValueOnce({
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasUncommittedChanges", () => {
  it("returns true when git status has output", async () => {
    mockGitSuccess(" M src/index.ts\n?? new-file.ts\n");
    const result = await ops.hasUncommittedChanges("/worktree");
    expect(result).toBe(true);
    expect(gitMock).toHaveBeenCalledWith(
      ["status", "--porcelain", "--untracked-files=all"],
      "/worktree",
      expect.anything(),
    );
  });

  it("returns false when git status is empty", async () => {
    mockGitSuccess("");
    const result = await ops.hasUncommittedChanges("/worktree");
    expect(result).toBe(false);
  });

  it("returns false for whitespace-only output", async () => {
    mockGitSuccess("   \n  ");
    const result = await ops.hasUncommittedChanges("/worktree");
    expect(result).toBe(false);
  });
});

describe("getCurrentBranch", () => {
  it("returns the branch name from git symbolic-ref output", async () => {
    mockGitSuccess("csm/my-feature\n");
    const result = await ops.getCurrentBranch("/worktree");
    expect(result).toBe("csm/my-feature");
    expect(gitMock).toHaveBeenCalledWith(
      ["symbolic-ref", "--short", "HEAD"],
      "/worktree",
      expect.anything(),
    );
  });

  it("returns null when HEAD is detached (symbolic-ref fails)", async () => {
    mockGitFailure(
      Object.assign(new Error("fatal: ref HEAD is not a symbolic ref"), {
        stderr: "fatal: ref HEAD is not a symbolic ref\n",
      }),
    );
    const result = await ops.getCurrentBranch("/worktree");
    expect(result).toBeNull();
  });

  it("trims trailing whitespace from output", async () => {
    mockGitSuccess("main\n\n");
    const result = await ops.getCurrentBranch("/worktree");
    expect(result).toBe("main");
  });
});

describe("commitChanges", () => {
  it("stages all and commits, returning the hash", async () => {
    mockGitSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    const result = await ops.commitChanges("/worktree", "Add feature");
    expect(result.hash).toBe("abc1234");

    expect(gitMock.mock.calls[1]![0]).toEqual(["add", "-A"]);
    expect(gitMock.mock.calls[2]![0]).toEqual(["commit", "-m", "Add feature"]);
  });

  it("throws when commit message is empty", async () => {
    await expect(ops.commitChanges("/worktree", "")).rejects.toThrow(
      "Commit message cannot be empty",
    );
    await expect(ops.commitChanges("/worktree", "   ")).rejects.toThrow(
      "Commit message cannot be empty",
    );
  });

  it("throws when there are no uncommitted changes", async () => {
    mockGitSuccess("");
    await expect(ops.commitChanges("/worktree", "msg")).rejects.toThrow(
      "No uncommitted changes to commit",
    );
  });

  it("passes --no-verify when skipHooks is true", async () => {
    mockGitSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] WIP commit\n 1 file changed\n" },
    ]);

    const result = await ops.commitChanges("/worktree", "WIP commit", {
      skipHooks: true,
    });
    expect(result.hash).toBe("abc1234");

    expect(gitMock.mock.calls[2]![0]).toEqual([
      "commit",
      "-m",
      "WIP commit",
      "--no-verify",
    ]);
  });

  it("does not pass --no-verify by default", async () => {
    mockGitSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    await ops.commitChanges("/worktree", "Add feature");

    expect(gitMock.mock.calls[2]![0]).toEqual(["commit", "-m", "Add feature"]);
  });

  it("returns empty hash when git output format is unexpected", async () => {
    mockGitSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "Unexpected output format" },
    ]);

    const result = await ops.commitChanges("/worktree", "msg");
    expect(result.hash).toBe("");
  });
});

describe("getCommitLog", () => {
  it("parses git log output into CommitLogEntry array", async () => {
    const fullHash1 = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const fullHash2 = "d1e2f3a4b5c6d1e2f3a4b5c6d1e2f3a4b5c6d1e2";

    const logOutput = [
      `abc1234\x00${fullHash1}\x00First commit\x002024-06-15T10:00:00Z\x00`,
      `def5678\x00${fullHash2}\x00Second commit\x002024-06-15T11:00:00Z\x00`,
    ].join("\n");

    const numstatOutput = [
      fullHash1,
      "10\t5\tsrc/index.ts",
      "3\t0\tREADME.md",
      fullHash2,
      "1\t1\tsrc/app.ts",
    ].join("\n");

    mockGitSequence([{ stdout: logOutput }, { stdout: numstatOutput }]);

    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.hash).toBe("abc1234");
    expect(entries[0]!.message).toBe("First commit");
    expect(entries[0]!.filesChanged).toBe(2);
    expect(entries[1]!.hash).toBe("def5678");
    expect(entries[1]!.message).toBe("Second commit");
    expect(entries[1]!.filesChanged).toBe(1);
  });

  it("returns empty array when git log fails (no main branch)", async () => {
    mockGitFailure(new Error("fatal: unknown revision"));
    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("returns empty array for empty log output", async () => {
    mockGitSuccess("");
    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("handles whitespace-only log output", async () => {
    mockGitSuccess("  \n  \n");
    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("skips malformed log lines", async () => {
    const logOutput = [
      "abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Good commit\x002024-06-15T10:00:00Z\x00",
      "bad line with no delimiters",
      "",
    ].join("\n");

    mockGitSequence([{ stdout: logOutput }, { stdout: "" }]);

    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Good commit");
  });

  it("leaves filesChanged at 0 when numstat call fails", async () => {
    const logOutput =
      "abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Commit\x002024-06-15T10:00:00Z\x00";

    mockGitSequence([
      { stdout: logOutput },
      { error: new Error("numstat failed") },
    ]);

    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.filesChanged).toBe(0);
  });

  it("handles special characters in commit messages", async () => {
    const logOutput =
      'abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Fix "quotes" & <angles>\x002024-06-15T10:00:00Z\x00';

    mockGitSequence([{ stdout: logOutput }, { stdout: "" }]);

    const entries = await ops.getCommitLog("/worktree");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe('Fix "quotes" & <angles>');
  });
});

describe("getCommitDiff", () => {
  const mockDiff = {
    files: [{ filePath: "file.ts", additions: 1, deletions: 0, hunks: [] }],
    totalAdditions: 1,
    totalDeletions: 0,
  };

  it("diffs against merge-base for first commit after divergence", async () => {
    mockGitSequence([
      { stdout: "parenthash123\n" },
      { stdout: "" },
      { stdout: "mergebase789\n" },
      { stdout: "diff --git a/file.ts b/file.ts\n" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await ops.getCommitDiff("/worktree", "abc1234");
    expect(result).toEqual(mockDiff);

    const mergeBaseCall = gitMock.mock.calls[2]!;
    expect(mergeBaseCall[0]).toEqual(["merge-base", "main", "abc1234"]);

    const diffCall = gitMock.mock.calls[3]!;
    expect(diffCall[0]).toEqual([
      "diff",
      "mergebase789..abc1234",
      "--unified=3",
    ]);
  });

  it("diffs against parent for subsequent commits", async () => {
    mockGitSequence([
      { stdout: "parenthash123\n" },
      { error: new Error("not ancestor") },
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await ops.getCommitDiff("/worktree", "def5678");
    expect(result).toEqual(mockDiff);

    const diffCall = gitMock.mock.calls[2]!;
    expect(diffCall[0]).toEqual(["diff", "def5678~1..def5678", "--unified=3"]);
  });

  it("falls back to diff against merge-base when rev-parse fails", async () => {
    mockGitSequence([
      { error: new Error("no parent") },
      { stdout: "mergebase789\n" },
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await ops.getCommitDiff("/worktree", "abc1234");
    expect(result).toEqual(mockDiff);

    const mergeBaseCall = gitMock.mock.calls[1]!;
    expect(mergeBaseCall[0]).toEqual(["merge-base", "main", "abc1234"]);

    const diffCall = gitMock.mock.calls[2]!;
    expect(diffCall[0]).toEqual([
      "diff",
      "mergebase789..abc1234",
      "--unified=3",
    ]);
  });

  it("returns empty diff when git diff output is empty", async () => {
    mockGitSequence([
      { stdout: "parenthash\n" },
      { error: new Error("not ancestor") },
      { stdout: "  \n" },
    ]);

    const result = await ops.getCommitDiff("/worktree", "abc1234");
    expect(result).toEqual({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });
    expect(parseDiffMock).not.toHaveBeenCalled();
  });
});

describe("collectChangeSummary", () => {
  it("returns empty string for a clean worktree", async () => {
    mockGitSuccess("");
    const result = await ops.collectChangeSummary("/worktree");
    expect(result).toBe("");
  });

  it("combines file status and per-file change magnitude for a dirty worktree", async () => {
    mockGitSequence([
      { stdout: " M src/index.ts\n?? new-file.ts\n" },
      {
        stdout:
          " src/index.ts | 12 ++++++++----\n 1 file changed, 8 insertions(+), 4 deletions(-)\n",
      },
    ]);

    const result = await ops.collectChangeSummary("/worktree");
    expect(result).toContain(" M src/index.ts");
    expect(result).toContain("?? new-file.ts");
    expect(result).toContain("src/index.ts | 12 ++++++++----");

    expect(gitMock.mock.calls[0]![0]).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(gitMock.mock.calls[1]![0]).toEqual(["diff", "--stat", "HEAD"]);
  });

  it("still names changed files when diff --stat fails (e.g. no HEAD yet)", async () => {
    mockGitSequence([
      { stdout: "?? brand-new.ts\n" },
      { error: new Error("fatal: bad revision 'HEAD'") },
    ]);

    const result = await ops.collectChangeSummary("/worktree");
    expect(result).toContain("?? brand-new.ts");
  });
});

describe("collectChangeSummary (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<void> {
    // Use the sanitized child env (same as the production GitClient) so an
    // inherited GIT_DIR / GIT_INDEX_FILE — e.g. when this suite runs inside a
    // git pre-commit hook — cannot redirect these mutations at the real repo.
    await execFileAsync("git", args, { cwd: repoPath, env: buildChildEnv() });
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "cc-change-summary-"));
    await gitIn(["init"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await writeFile(join(repoPath, "tracked.ts"), "export const a = 1;\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "initial", "--no-verify"]);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("names modified and untracked files with change magnitude", async () => {
    await writeFile(
      join(repoPath, "tracked.ts"),
      "export const a = 1;\nexport const b = 2;\n",
    );
    await writeFile(join(repoPath, "untracked.ts"), "export const c = 3;\n");

    const result = await realOps.collectChangeSummary(repoPath);
    expect(result).toContain("tracked.ts");
    expect(result).toContain("untracked.ts");
    // diff --stat magnitude line for the tracked change
    expect(result).toMatch(/tracked\.ts\s*\|\s*\d+/);
  });

  it("returns empty string for a clean worktree", async () => {
    const result = await realOps.collectChangeSummary(repoPath);
    expect(result).toBe("");
  });
});

describe("real-git isolation under an inherited GIT_DIR (pre-commit hook safety)", () => {
  // Regression: git runs hooks with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE
  // exported into the environment. This suite runs real `git` mutations
  // (init/add/commit). When it executes inside the husky pre-commit hook (which
  // runs `vitest run --project unit`), a git command that inherits those vars
  // commits into the REAL repo instead of its temp fixture — observed as a
  // stray "initial" commit (tree = {tracked.ts}) landing on the actual branch
  // and corrupting HEAD. The fixture git helper must use the sanitized child
  // env so it stays scoped to its own cwd.
  let victimPath: string;
  let sandboxPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const GIT_LEAK_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;

  async function gitRaw(cwd: string, args: string[]): Promise<string> {
    // Reads use the sanitized env so they observe `cwd`, not a leaked GIT_DIR.
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    victimPath = await mkdtemp(join(tmpdir(), "cc-victim-"));
    sandboxPath = await mkdtemp(join(tmpdir(), "cc-sandbox-"));
    // The "victim" stands in for the real repo a pre-commit hook would expose.
    await gitRaw(victimPath, ["init"]);
    await gitRaw(victimPath, ["config", "user.email", "victim@example.com"]);
    await gitRaw(victimPath, ["config", "user.name", "Victim"]);
    await writeFile(join(victimPath, "base.ts"), "export const v = 1;\n");
    await gitRaw(victimPath, ["add", "-A"]);
    await gitRaw(victimPath, ["commit", "-m", "victim base", "--no-verify"]);
  });

  afterEach(async () => {
    for (const key of GIT_LEAK_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(victimPath, { recursive: true, force: true });
    await rm(sandboxPath, { recursive: true, force: true });
  });

  it("does not commit into the ambient repo when GIT_DIR/GIT_INDEX_FILE are inherited", async () => {
    const victimHeadBefore = (
      await gitRaw(victimPath, ["rev-parse", "HEAD"])
    ).trim();

    // Simulate the pre-commit hook leaking the real repo's git env.
    for (const key of GIT_LEAK_KEYS) savedEnv[key] = process.env[key];
    process.env.GIT_DIR = join(victimPath, ".git");
    process.env.GIT_WORK_TREE = victimPath;
    process.env.GIT_INDEX_FILE = join(victimPath, ".git", "index");

    // Run the same mutating sequence the fixture setup uses, in a separate
    // sandbox repo, via the sanitized-env helper. It must touch only sandbox.
    const gitInSandbox = (args: string[]): Promise<string> =>
      gitRaw(sandboxPath, args);
    await gitInSandbox(["init"]);
    await gitInSandbox(["config", "user.email", "test@example.com"]);
    await gitInSandbox(["config", "user.name", "Test"]);
    await writeFile(join(sandboxPath, "tracked.ts"), "export const a = 1;\n");
    await gitInSandbox(["add", "-A"]);
    await gitInSandbox(["commit", "-m", "initial", "--no-verify"]);

    // The victim repo is untouched: HEAD unchanged and no "initial" commit.
    const victimHeadAfter = (
      await gitRaw(victimPath, ["rev-parse", "HEAD"])
    ).trim();
    const victimLog = await gitRaw(victimPath, ["log", "--format=%s"]);
    expect(victimHeadAfter).toBe(victimHeadBefore);
    expect(victimLog).not.toContain("initial");

    // The sandbox repo got its own "initial" commit.
    const sandboxLog = await gitRaw(sandboxPath, ["log", "--format=%s"]);
    expect(sandboxLog).toContain("initial");
  });
});

describe("targetBranch parameter", () => {
  it("getCommitLog uses custom targetBranch in git log range", async () => {
    mockGitSequence([{ stdout: "" }]);

    await ops.getCommitLog("/worktree", "csm/parent");

    expect(gitMock.mock.calls[0]![0]).toEqual([
      "log",
      "csm/parent..HEAD",
      expect.stringContaining("%h"),
    ]);
  });

  it("getCommitDiff uses custom targetBranch in merge-base", async () => {
    mockGitSequence([
      { stdout: "parenthash\n" },
      { stdout: "" },
      { stdout: "mergebase789\n" },
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });

    await ops.getCommitDiff("/worktree", "abc123", "csm/parent");

    expect(gitMock.mock.calls[1]![0]).toEqual([
      "merge-base",
      "--is-ancestor",
      "parenthash",
      "csm/parent",
    ]);
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "merge-base",
      "csm/parent",
      "abc123",
    ]);
  });
});
