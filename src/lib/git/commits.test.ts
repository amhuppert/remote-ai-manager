import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  /** rev-parse HEAD^{tree}, then the two nominating probes. */
  function mockProbes(diff: string, others: string) {
    mockGitSequence([
      { stdout: "headtree0000\n" },
      { stdout: diff },
      { stdout: others },
    ]);
  }

  it("returns false without opening a private index when nothing is nominated", async () => {
    mockProbes("", "");
    expect(await ops.hasUncommittedChanges("/worktree")).toBe(false);
    // Three calls and no more: a clean tree hashes nothing.
    expect(gitMock).toHaveBeenCalledTimes(3);
    expect(gitMock.mock.calls[0]![0]).toEqual(["rev-parse", "HEAD^{tree}"]);
  });

  it("stages only the nominated paths into a private index and compares the tree it writes", async () => {
    mockGitSequence([
      { stdout: "headtree0000\n" },
      { stdout: "src/index.ts\0" },
      { stdout: "new-file.ts\0" },
      { stdout: "/repo/.git\n" },
      { stdout: "" }, // read-tree
      { stdout: "" }, // add
      { stdout: "differenttree\n" }, // write-tree
    ]);

    expect(await ops.hasUncommittedChanges("/worktree")).toBe(true);
    expect(gitMock.mock.calls[5]![0]).toEqual([
      "--literal-pathspecs",
      "add",
      "--all",
      "--",
      "src/index.ts",
      "new-file.ts",
    ]);
  });

  it("reports no work when the nominated paths write back HEAD's own tree, which is the stale-index case", async () => {
    mockGitSequence([
      { stdout: "headtree0000\n" },
      { stdout: "src/api/handler.ts\0" },
      { stdout: "" },
      { stdout: "/repo/.git\n" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "headtree0000\n" },
    ]);

    expect(await ops.hasUncommittedChanges("/worktree")).toBe(false);
  });

  it("falls back to status on an unborn branch, where there is no HEAD to differ from", async () => {
    mockGitSequence([
      { error: new Error("fatal: ambiguous argument 'HEAD'") },
      { stdout: "?? first.ts\n" },
    ]);
    expect(await ops.hasUncommittedChanges("/worktree")).toBe(true);
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
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

describe("getHeadCommit", () => {
  it("returns the trimmed sha from git rev-parse HEAD", async () => {
    mockGitSuccess("abc123def456abc123def456abc123def456abcd\n");
    const result = await ops.getHeadCommit("/worktree");
    expect(result).toBe("abc123def456abc123def456abc123def456abcd");
    expect(gitMock).toHaveBeenCalledWith(
      ["rev-parse", "HEAD"],
      "/worktree",
      expect.anything(),
    );
  });

  it("returns null when rev-parse fails (unborn branch or not a repo)", async () => {
    mockGitFailure(
      Object.assign(new Error("fatal: ambiguous argument 'HEAD'"), {
        stderr: "fatal: ambiguous argument 'HEAD'\n",
      }),
    );
    const result = await ops.getHeadCommit("/worktree");
    expect(result).toBeNull();
  });

  it("returns null for empty output", async () => {
    mockGitSuccess("  \n");
    const result = await ops.getHeadCommit("/worktree");
    expect(result).toBeNull();
  });
});

describe("commitContainsPath", () => {
  it("passes pathspec metacharacters to Git as a literal pathspec", async () => {
    mockGitSuccess("docs/[draft].md\n");

    await expect(
      ops.commitContainsPath("/worktree", "abc123def456", "docs/[draft].md"),
    ).resolves.toBe(true);
    expect(gitMock).toHaveBeenCalledWith(
      [
        "ls-tree",
        "--name-only",
        "abc123def456",
        "--",
        ":(literal)docs/[draft].md",
      ],
      "/worktree",
      expect.anything(),
    );
  });

  it("distinguishes an absent tree entry from an operational Git failure", async () => {
    mockGitSuccess("");
    await expect(
      ops.commitContainsPath("/worktree", "abc123def456", "docs/absent.md"),
    ).resolves.toBe(false);

    mockGitFailure(new Error("fatal: bad object abc123def456"));
    await expect(
      ops.commitContainsPath("/worktree", "abc123def456", "docs/design.md"),
    ).rejects.toThrow("bad object");
  });
});

describe("commitContainsPath (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "cc-committed-source-"));
    await gitIn(["init", "-b", "main"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await mkdir(join(repoPath, "docs"));
    await writeFile(join(repoPath, "docs", "design.md"), "# design\n");
    await writeFile(join(repoPath, "docs", "[draft].md"), "# draft\n");
    await symlink("design.md", join(repoPath, "docs", "latest.md"));
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "source fixtures", "--no-verify"]);
    await writeFile(join(repoPath, "docs", "untracked.md"), "# local only\n");
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("recognizes committed files, directories, symlinks, and literal names at HEAD but not untracked paths", async () => {
    const sha = (await gitIn(["rev-parse", "HEAD"])).trim();

    await expect(
      Promise.all([
        realOps.commitContainsPath(repoPath, sha, "docs/design.md"),
        realOps.commitContainsPath(repoPath, sha, "docs"),
        realOps.commitContainsPath(repoPath, sha, "docs/latest.md"),
        realOps.commitContainsPath(repoPath, sha, "docs/untracked.md"),
        realOps.commitContainsPath(repoPath, sha, "docs/[draft].md"),
      ]),
    ).resolves.toEqual([true, true, true, false, true]);
  });
});

describe("commitChanges", () => {
  /**
   * What `hasUncommittedChanges` reads before it can say "yes, there is work":
   * HEAD's tree, the two nominating probes, then the private-index staging that
   * settles whether the nominees really differ. These tests are about what
   * happens AFTER that verdict, so they prepend it rather than restate it.
   */
  const DIRTY_VERDICT = [
    { stdout: "headtree0000\n" },
    { stdout: "file.ts\0" },
    { stdout: "" },
    { stdout: "/repo/.git\n" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "differenttree\n" },
  ];
  /** The conflict-artifact guard's probes, all finding nothing: unmerged
   *  entries, the changed-lines marker check, then the two candidate readings
   *  `--check` cannot see (binary changes, untracked files). */
  const CLEAN_GUARD = [
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
    { stdout: "" },
  ];
  /** Index of the first call `commitChanges` makes past verdict and guard. */
  const AFTER_VERDICT = DIRTY_VERDICT.length + CLEAN_GUARD.length;

  it("stages all and commits, returning the hash", async () => {
    mockGitSequence([
      ...DIRTY_VERDICT,
      ...CLEAN_GUARD,
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    const result = await ops.commitChanges("/worktree", "Add feature");
    expect(result.hash).toBe("abc1234");

    expect(gitMock.mock.calls[DIRTY_VERDICT.length]![0]).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    expect(gitMock.mock.calls[DIRTY_VERDICT.length + 1]![0]).toEqual([
      "diff",
      "HEAD",
      "--check",
    ]);
    expect(gitMock.mock.calls[AFTER_VERDICT]![0]).toEqual(["add", "-A"]);
    expect(gitMock.mock.calls[AFTER_VERDICT + 1]![0]).toEqual([
      "commit",
      "-m",
      "Add feature",
    ]);
  });

  it("throws when commit message is empty", async () => {
    await expect(ops.commitChanges("/worktree", "")).rejects.toThrow(
      "Commit message cannot be empty",
    );
    await expect(ops.commitChanges("/worktree", "   ")).rejects.toThrow(
      "Commit message cannot be empty",
    );
  });

  it("throws when there are no uncommitted changes and no merge in progress", async () => {
    mockGitSequence([
      // HEAD tree, the two nominating probes, then the MERGE_HEAD check.
      { stdout: "headtree0000\n" },
      { stdout: "" },
      { stdout: "" },
      { error: new Error("fatal: Needed a single revision") },
    ]);
    await expect(ops.commitChanges("/worktree", "msg")).rejects.toThrow(
      "No uncommitted changes to commit",
    );
  });

  it("commits with empty porcelain when a merge is in progress (take-ours resolution)", async () => {
    mockGitSequence([
      // A take-ours resolution leaves the tree matching HEAD and nothing
      // untracked, so both nominating probes come back empty.
      { stdout: "headtree0000\n" },
      { stdout: "" },
      { stdout: "" },
      { stdout: "abc1234def5678\n" },
      ...CLEAN_GUARD,
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] resolve merge conflicts\n" },
    ]);

    const result = await ops.commitChanges(
      "/worktree",
      "resolve merge conflicts",
    );
    expect(result.hash).toBe("abc1234");

    expect(gitMock.mock.calls[3]![0]).toEqual([
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    expect(gitMock.mock.calls[9]![0]).toEqual([
      "commit",
      "-m",
      "resolve merge conflicts",
    ]);
  });

  it("passes --no-verify when skipHooks is true", async () => {
    mockGitSequence([
      ...DIRTY_VERDICT,
      ...CLEAN_GUARD,
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] WIP commit\n 1 file changed\n" },
    ]);

    const result = await ops.commitChanges("/worktree", "WIP commit", {
      skipHooks: true,
    });
    expect(result.hash).toBe("abc1234");

    expect(gitMock.mock.calls[AFTER_VERDICT + 1]![0]).toEqual([
      "commit",
      "-m",
      "WIP commit",
      "--no-verify",
    ]);
  });

  it("does not pass --no-verify by default", async () => {
    mockGitSequence([
      ...DIRTY_VERDICT,
      ...CLEAN_GUARD,
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    await ops.commitChanges("/worktree", "Add feature");

    expect(gitMock.mock.calls[AFTER_VERDICT + 1]![0]).toEqual([
      "commit",
      "-m",
      "Add feature",
    ]);
  });

  it("returns empty hash when git output format is unexpected", async () => {
    mockGitSequence([
      ...DIRTY_VERDICT,
      ...CLEAN_GUARD,
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

describe("commitChanges concludes an in-progress merge (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "cc-conclude-merge-"));
    await gitIn(["init", "-b", "main"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'base';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "base", "--no-verify"]);
    // Divergent edits to the same line on main and feature.
    await gitIn(["checkout", "-b", "feature"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'ours';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "feature edit", "--no-verify"]);
    await gitIn(["checkout", "main"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'theirs';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "main edit", "--no-verify"]);
    await gitIn(["checkout", "feature"]);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("commits a take-ours resolution whose tree equals HEAD", async () => {
    // `git merge main` conflicts; resolving take-ours leaves the staged tree
    // identical to HEAD, so porcelain is empty while MERGE_HEAD still exists.
    await expect(
      execFileAsync("git", ["merge", "main"], {
        cwd: repoPath,
        env: buildChildEnv(),
      }),
    ).rejects.toThrow();
    await gitIn(["checkout", "--ours", "file.ts"]);
    await gitIn(["add", "file.ts"]);
    expect((await gitIn(["status", "--porcelain"])).trim()).toBe("");

    const { hash } = await realOps.commitChanges(
      repoPath,
      "resolve merge conflicts",
      { skipHooks: true },
    );
    expect(hash).not.toBe("");

    // The merge is concluded: MERGE_HEAD is gone and HEAD is a merge commit.
    await expect(
      gitIn(["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    ).rejects.toThrow();
    const parents = (await gitIn(["rev-list", "--parents", "-n", "1", "HEAD"]))
      .trim()
      .split(" ");
    expect(parents).toHaveLength(3);
  });
});

describe("commitChanges refuses conflict artifacts (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  /** Leave the worktree mid-merge with markers in file.ts. */
  async function startConflictingMerge(): Promise<void> {
    await expect(gitIn(["merge", "main"])).rejects.toThrow();
  }

  async function headSha(): Promise<string> {
    return (await gitIn(["rev-parse", "HEAD"])).trim();
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "cc-marker-guard-"));
    await gitIn(["init", "-b", "main"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'base';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "base", "--no-verify"]);
    await gitIn(["checkout", "-b", "feature"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'ours';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "feature edit", "--no-verify"]);
    await gitIn(["checkout", "main"]);
    await writeFile(join(repoPath, "file.ts"), "export const v = 'theirs';\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "main edit", "--no-verify"]);
    await gitIn(["checkout", "feature"]);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("refuses while unmerged index entries remain", async () => {
    await startConflictingMerge();
    const before = await headSha();

    await expect(
      realOps.commitChanges(repoPath, "WIP: uncommitted changes", {
        skipHooks: true,
      }),
    ).rejects.toThrow(/Refusing to commit: 1 file\(s\).*file\.ts/s);

    expect(await headSha()).toBe(before);
  });

  it("refuses on a marker-bearing tree whose merge state was already reset away", async () => {
    await startConflictingMerge();
    // What `resyncSharedIndexToHead` does to a mid-merge worktree: MERGE_HEAD
    // and the unmerged entries are gone, the marker-bearing files remain.
    await gitIn(["reset", "--mixed", "--quiet", "HEAD"]);
    await expect(
      gitIn(["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    ).rejects.toThrow();
    expect(
      (await gitIn(["diff", "--name-only", "--diff-filter=U"])).trim(),
    ).toBe("");
    const before = await headSha();

    await expect(
      realOps.commitChanges(repoPath, "WIP: uncommitted changes", {
        skipHooks: true,
      }),
    ).rejects.toThrow(/Refusing to commit.*file\.ts/s);

    expect(await headSha()).toBe(before);
  });

  it("refuses an untracked marker-bearing file, which `git add -A` would stage", async () => {
    await writeFile(
      join(repoPath, "generated.ts"),
      "<<<<<<< HEAD\nexport const v = 'ours';\n=======\nexport const v = 'theirs';\n>>>>>>> main\n",
    );
    const before = await headSha();

    await expect(
      realOps.commitChanges(repoPath, "WIP: uncommitted changes", {
        skipHooks: true,
      }),
    ).rejects.toThrow(/Refusing to commit.*generated\.ts/s);

    expect(await headSha()).toBe(before);
  });

  it("refuses a marker-bearing file git reads as binary", async () => {
    // The NUL byte an auto-merge can leave alongside markers: git's own
    // `--check` skips the file, so only the binary reading catches it.
    await writeFile(
      join(repoPath, "file.ts"),
      "<<<<<<< HEAD\nexport const v = 'ours';\n=======\nexport const v = 'theirs';\n>>>>>>> main\n\0\n",
    );
    const before = await headSha();

    await expect(
      realOps.commitChanges(repoPath, "WIP: uncommitted changes", {
        skipHooks: true,
      }),
    ).rejects.toThrow(/Refusing to commit.*file\.ts/s);

    expect(await headSha()).toBe(before);
  });

  it("commits an ordinary dirty tree", async () => {
    await writeFile(join(repoPath, "file.ts"), "export const v = 'edited';\n");
    await writeFile(join(repoPath, "added.ts"), "export const w = 2;\n");

    const { hash } = await realOps.commitChanges(repoPath, "ordinary work", {
      skipHooks: true,
    });

    expect(hash).not.toBe("");
    expect((await gitIn(["status", "--porcelain"])).trim()).toBe("");
  });

  it("commits a marker-free merge conclusion", async () => {
    await startConflictingMerge();
    await writeFile(join(repoPath, "file.ts"), "export const v = 'merged';\n");
    await gitIn(["add", "file.ts"]);

    const { hash } = await realOps.commitChanges(
      repoPath,
      "resolve merge conflicts",
      { skipHooks: true },
    );

    expect(hash).not.toBe("");
    const parents = (await gitIn(["rev-list", "--parents", "-n", "1", "HEAD"]))
      .trim()
      .split(" ");
    expect(parents).toHaveLength(3);
  });

  it("commits a markdown setext heading that git's own --check flags as a marker", async () => {
    await writeFile(
      join(repoPath, "notes.md"),
      "Release notes\n=======\nShipped.\n",
    );
    await gitIn(["add", "notes.md"]);
    // git's heuristic counts the bare separator, so the guard cannot trust it
    // without confirming the file against the strict marker regex.
    await expect(gitIn(["diff", "HEAD", "--check"])).rejects.toThrow();

    const { hash } = await realOps.commitChanges(repoPath, "add notes", {
      skipHooks: true,
    });

    expect(hash).not.toBe("");
    expect((await gitIn(["status", "--porcelain"])).trim()).toBe("");
  });
});

describe("real-git isolation under an inherited GIT_DIR (pre-commit hook safety)", () => {
  // Regression: git runs hooks with GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE
  // exported into the environment. This suite runs real `git` mutations
  // (init/add/commit). When it executes inside the husky pre-commit hook (which
  // runs the Vitest unit projects), a git command that inherits those vars
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

describe("commitMergeResolution (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  async function head(): Promise<string> {
    return (await gitIn(["rev-parse", "HEAD"])).trim();
  }

  /**
   * `feature` and `main` edit the same line, and the worktree is left with
   * `git merge main` in progress on `feature` — exactly where the machine
   * hands the tree to the resolver.
   */
  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), "cc-merge-resolution-"));
    await gitIn(["init", "-b", "main"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await writeFile(join(repoPath, "shared.txt"), "base\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "base", "--no-verify"]);
    await gitIn(["checkout", "-b", "feature"]);
    await writeFile(join(repoPath, "shared.txt"), "feature\n");
    await gitIn(["commit", "-am", "feature change", "--no-verify"]);
    await gitIn(["checkout", "main"]);
    await writeFile(join(repoPath, "shared.txt"), "main\n");
    await gitIn(["commit", "-am", "main change", "--no-verify"]);
    await gitIn(["checkout", "feature"]);
    await expect(gitIn(["merge", "main"])).rejects.toThrow();
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("commits a staged resolution as the orchestrator and concludes the merge", async () => {
    await writeFile(join(repoPath, "shared.txt"), "feature+main\n");
    await gitIn(["add", "shared.txt"]);

    const result = await realOps.commitMergeResolution(
      repoPath,
      "main",
      "resolve merge conflicts",
    );

    expect(result.committedBy).toBe("orchestrator");
    expect(result.hash).toBe((await head()).slice(0, result.hash.length));
    expect((await gitIn(["log", "-1", "--format=%s"])).trim()).toBe(
      "resolve merge conflicts",
    );
    await expect(
      gitIn(["rev-parse", "-q", "--verify", "MERGE_HEAD"]),
    ).rejects.toThrow();
  });

  it("accepts a merge the resolver already committed instead of failing on the clean tree", async () => {
    await writeFile(join(repoPath, "shared.txt"), "feature+main\n");
    await gitIn(["add", "shared.txt"]);
    // The resolver concluding the merge itself, with git's default message.
    await gitIn(["commit", "--no-edit", "--no-verify"]);
    const resolverCommit = await head();
    const mainTip = (await gitIn(["rev-parse", "main"])).trim();
    expect((await gitIn(["rev-parse", "HEAD^2"])).trim()).toBe(mainTip);

    const result = await realOps.commitMergeResolution(
      repoPath,
      "main",
      "resolve merge conflicts",
    );

    expect(result).toEqual({ hash: resolverCommit, committedBy: "resolver" });
    expect(await head()).toBe(resolverCommit);
  });

  it("still refuses a clean tree whose HEAD does not conclude a merge of the target", async () => {
    await gitIn(["merge", "--abort"]);

    await expect(
      realOps.commitMergeResolution(
        repoPath,
        "main",
        "resolve merge conflicts",
      ),
    ).rejects.toThrow("No uncommitted changes to commit");
  });

  it("refuses a resolver commit that merged something other than the target", async () => {
    await gitIn(["merge", "--abort"]);
    await gitIn(["checkout", "-b", "other", "main~1"]);
    await writeFile(join(repoPath, "other.txt"), "other\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "other change", "--no-verify"]);
    await gitIn(["checkout", "feature"]);
    // A merge commit at HEAD, but of `other`, so the target tip is still absent.
    await gitIn(["merge", "--no-edit", "--no-verify", "other"]);

    await expect(
      realOps.commitMergeResolution(
        repoPath,
        "main",
        "resolve merge conflicts",
      ),
    ).rejects.toThrow("No uncommitted changes to commit");
  });
});
