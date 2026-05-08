import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitClient } from "./git-client";
import { createGitOperations } from "./git-operations";

// ---------------------------------------------------------------------------
// Test GitClient — replaces vi.mock("./git-client")
// ---------------------------------------------------------------------------

const gitMock = vi.fn();

const testClient: GitClient = {
  git: gitMock,
};

// Create operations backed by the test client
const ops = createGitOperations(testClient);

// ---------------------------------------------------------------------------
// parseDiff mock — still needed since parseDiff is an external pure function
// ---------------------------------------------------------------------------

const { parseDiffMock } = vi.hoisted(() => ({
  parseDiffMock: vi.fn(),
}));

vi.mock("./diff", () => ({
  parseDiff: parseDiffMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make gitMock resolve with { stdout, stderr } */
function mockGitSuccess(stdout = "", stderr = "") {
  gitMock.mockResolvedValue({ stdout, stderr });
}

function mockGitFailure(error: Error) {
  gitMock.mockRejectedValue(error);
}

/** Queue sequential resolve/reject results for successive gitMock calls */
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

// ===========================================================================
// hasUncommittedChanges
// ===========================================================================

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

// ===========================================================================
// commitChanges
// ===========================================================================

describe("commitChanges", () => {
  it("stages all and commits, returning the hash", async () => {
    mockGitSequence([
      // hasUncommittedChanges → git status
      { stdout: " M file.ts\n" },
      // git add -A
      { stdout: "" },
      // git commit
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    const result = await ops.commitChanges("/worktree", "Add feature");
    expect(result.hash).toBe("abc1234");

    // Verify git add -A was called
    expect(gitMock.mock.calls[1]![0]).toEqual(["add", "-A"]);
    // Verify git commit with message
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
    mockGitSuccess(""); // git status returns empty
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

    // Verify git commit was called with --no-verify
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

    // Verify git commit was called WITHOUT --no-verify
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

// ===========================================================================
// getCommitLog
// ===========================================================================

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

// ===========================================================================
// getCommitDiff
// ===========================================================================

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

// ===========================================================================
// squashMerge
// ===========================================================================

describe("squashMerge", () => {
  it("performs squash merge and returns hash", async () => {
    mockGitSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "src/changed.ts\n" },
      { stdout: "[main abc1234] Merge session\n" },
    ]);

    const result = await ops.squashMerge(
      "/project",
      "csm/my-session",
      "Merge session",
    );
    expect(result.mergeHash).toBe("abc1234");

    expect(gitMock.mock.calls[0]![1]).toBe("/project");
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "merge",
      "--squash",
      "csm/my-session",
    ]);
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "diff",
      "--cached",
      "--name-only",
    ]);
    expect(gitMock.mock.calls[3]![0]).toEqual([
      "commit",
      "--no-verify",
      "-m",
      "Merge session",
    ]);
  });

  it("throws when merge message is empty", async () => {
    await expect(ops.squashMerge("/project", "csm/branch", "")).rejects.toThrow(
      "Merge message cannot be empty",
    );
    await expect(
      ops.squashMerge("/project", "csm/branch", "   "),
    ).rejects.toThrow("Merge message cannot be empty");
  });

  it("throws when merge path has uncommitted changes", async () => {
    mockGitSuccess(" M dirty-file.ts\n");
    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Target branch 'main' has uncommitted changes");
  });

  it("ignores untracked files in merge path cleanliness check", async () => {
    // Untracked files (prefix "??") should not block squash merge
    mockGitSequence([
      { stdout: "?? some-untracked-file.html\n" }, // status --porcelain
      { stdout: "" }, // merge --squash
      { stdout: "src/changed.ts\n" }, // diff --cached --name-only
      { stdout: "[main abc1234] Merge\n" }, // commit
    ]);

    const result = await ops.squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("abc1234");
  });

  it("throws when merge path has tracked changes alongside untracked files", async () => {
    mockGitSequence([{ stdout: "?? untracked.html\n M dirty-file.ts\n" }]);
    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Target branch 'main' has uncommitted changes");
  });

  it("returns empty hash when commit output format is unexpected", async () => {
    mockGitSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "src/changed.ts\n" },
      { stdout: "Unexpected output" },
    ]);

    const result = await ops.squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("");
  });

  it("returns empty hash without committing when squash produced no staged changes", async () => {
    // Sequence:
    //  1. status --porcelain (clean target)
    //  2. merge --squash (succeeds; no-op because feature branch is identical)
    //  3. diff --cached --name-only (empty → no staged changes)
    mockGitSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

    const result = await ops.squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("");

    // Crucially: no `git commit` call is issued.
    const commands = gitMock.mock.calls.map((call) => call[0]);
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["commit", "--no-verify"]),
    );
  });

  it("detects merge conflicts, aborts, and throws descriptive error", async () => {
    mockGitSequence([
      { stdout: "" },
      {
        error: new Error(
          "CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
        ),
      },
      { stdout: "" },
      { stdout: "" },
    ]);

    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Merge conflicts detected");

    expect(gitMock.mock.calls[2]![0]).toEqual(["merge", "--abort"]);
    expect(gitMock.mock.calls[3]![0]).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("resets project root when commit fails (e.g. pre-commit hook)", async () => {
    const commitError = Object.assign(new Error("Command failed: git commit"), {
      stderr: "husky - pre-commit script failed (code 1)",
      stdout: "",
    });

    mockGitSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "src/changed.ts\n" },
      { error: commitError },
      { stdout: "" },
    ]);

    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Commit failed");

    expect(gitMock.mock.calls[4]![0]).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("re-throws non-conflict merge errors without conflict message", async () => {
    mockGitSequence([
      { stdout: "" },
      { error: new Error("fatal: not a valid branch name") },
      { stdout: "" },
      { stdout: "" },
    ]);

    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("fatal: not a valid branch name");
  });
});

// ===========================================================================
// mergeTargetIntoFeature
// ===========================================================================

describe("mergeTargetIntoFeature", () => {
  it("returns clean status when git merge main succeeds", async () => {
    mockGitSuccess("Already up to date.\n");

    const result = await ops.mergeTargetIntoFeature("/worktree");
    expect(result).toEqual({ status: "clean" });

    expect(gitMock).toHaveBeenCalledWith(
      ["merge", "main"],
      "/worktree",
      expect.anything(),
    );
  });

  it("returns conflicts with file list when merge has CONFLICT in stderr", async () => {
    mockGitSequence([
      {
        error: Object.assign(
          new Error(
            "CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
          ),
          {
            stderr:
              "CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
          },
        ),
      },
      { stdout: "src/index.ts\nsrc/utils.ts\n" },
    ]);

    const result = await ops.mergeTargetIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/index.ts", "src/utils.ts"],
    });

    expect(gitMock.mock.calls[1]![0]).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
  });

  it("returns conflicts when 'merge conflict' appears in error message", async () => {
    mockGitSequence([
      {
        error: Object.assign(new Error("Automatic merge conflict in file.ts"), {
          stderr: "Automatic merge conflict in file.ts",
        }),
      },
      { stdout: "file.ts\n" },
    ]);

    const result = await ops.mergeTargetIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["file.ts"],
    });
  });

  it("detects CONFLICT from error message when stderr is absent", async () => {
    mockGitSequence([
      {
        error: new Error(
          "CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed",
        ),
      },
      { stdout: "src/app.ts\n" },
    ]);

    const result = await ops.mergeTargetIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/app.ts"],
    });
  });

  it("rethrows non-conflict errors", async () => {
    mockGitFailure(new Error("fatal: not something we can merge"));

    await expect(ops.mergeTargetIntoFeature("/worktree")).rejects.toThrow(
      "fatal: not something we can merge",
    );

    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort the merge on conflict (leaves worktree in conflict state)", async () => {
    mockGitSequence([
      {
        error: Object.assign(
          new Error("CONFLICT (content): Merge conflict in src/index.ts"),
          { stderr: "CONFLICT (content): Merge conflict in src/index.ts" },
        ),
      },
      { stdout: "src/index.ts\n" },
    ]);

    await ops.mergeTargetIntoFeature("/worktree");

    expect(gitMock).toHaveBeenCalledTimes(2);

    const allArgs = gitMock.mock.calls.map(
      (call: unknown[]) => call[0] as string[],
    );
    const hasAbort = allArgs.some((args: string[]) => args.includes("--abort"));
    expect(hasAbort).toBe(false);
  });

  it("filters empty lines from conflicted file list", async () => {
    mockGitSequence([
      {
        error: Object.assign(new Error("CONFLICT (content): Merge conflict"), {
          stderr: "CONFLICT (content): Merge conflict",
        }),
      },
      { stdout: "src/a.ts\n\nsrc/b.ts\n\n" },
    ]);

    const result = await ops.mergeTargetIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
  });
});

// ===========================================================================
// isBranchAncestorOfTarget
// ===========================================================================

describe("isBranchAncestorOfTarget", () => {
  it("returns true when branch is ancestor and has diverged from merge base", async () => {
    mockGitSequence([
      { stdout: "" },
      { stdout: "abc1234\n" },
      { stdout: "def5678\n" },
    ]);

    const result = await ops.isBranchAncestorOfTarget(
      "/project",
      "csm/my-session",
    );
    expect(result).toBe(true);
  });

  it("returns false when branch tip equals merge base (never diverged)", async () => {
    mockGitSequence([
      { stdout: "" },
      { stdout: "abc1234\n" },
      { stdout: "abc1234\n" },
    ]);

    const result = await ops.isBranchAncestorOfTarget(
      "/project",
      "csm/my-session",
    );
    expect(result).toBe(false);
  });

  it("checks against non-main target branch when specified", async () => {
    mockGitSequence([
      { stdout: "" },
      { stdout: "abc1234\n" },
      { stdout: "def5678\n" },
    ]);

    const result = await ops.isBranchAncestorOfTarget(
      "/project",
      "csm/child",
      "csm/parent",
    );
    expect(result).toBe(true);

    // Verify the target branch was used in merge-base --is-ancestor
    expect(gitMock.mock.calls[0]![0]).toEqual([
      "merge-base",
      "--is-ancestor",
      "csm/child",
      "csm/parent",
    ]);
    // Verify merge-base uses target branch
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "merge-base",
      "csm/child",
      "csm/parent",
    ]);
  });

  it("returns false when branch is not ancestor of target", async () => {
    mockGitSequence([{ error: new Error("not ancestor") }]);

    const result = await ops.isBranchAncestorOfTarget(
      "/project",
      "csm/my-session",
    );
    expect(result).toBe(false);
  });

  it("returns false when git commands fail", async () => {
    mockGitSequence([{ stdout: "" }, { error: new Error("fatal: bad ref") }]);

    const result = await ops.isBranchAncestorOfTarget(
      "/project",
      "csm/my-session",
    );
    expect(result).toBe(false);
  });
});

// ===========================================================================
// targetBranch parameter — cross-cutting tests
// ===========================================================================

describe("targetBranch parameter", () => {
  it("getCommitLog uses custom targetBranch in git log range", async () => {
    mockGitSequence([
      { stdout: "" }, // empty log
    ]);

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
      { stdout: "" }, // is-ancestor succeeds
      { stdout: "mergebase789\n" },
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });

    await ops.getCommitDiff("/worktree", "abc123", "csm/parent");

    // merge-base --is-ancestor should use csm/parent
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "merge-base",
      "--is-ancestor",
      "parenthash",
      "csm/parent",
    ]);
    // merge-base should use csm/parent
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "merge-base",
      "csm/parent",
      "abc123",
    ]);
  });

  it("isBranchMentionedInTargetLog uses custom targetBranch", async () => {
    mockGitSuccess("abc1234 Merge csm/child\n");

    const result = await ops.isBranchMentionedInTargetLog(
      "/project",
      "csm/child",
      "csm/parent",
    );
    expect(result).toBe(true);

    expect(gitMock.mock.calls[0]![0]).toEqual([
      "log",
      "csm/parent",
      "--oneline",
      "-100",
      "--grep=csm/child",
    ]);
  });

  it("mergeTargetIntoFeature uses custom targetBranch", async () => {
    mockGitSuccess("Already up to date.\n");

    await ops.mergeTargetIntoFeature("/worktree", "csm/parent");

    expect(gitMock.mock.calls[0]![0]).toEqual(["merge", "csm/parent"]);
  });

  it("squashMerge uses custom targetBranch in error message", async () => {
    mockGitSuccess(" M dirty.ts\n");

    await expect(
      ops.squashMerge("/parent-worktree", "csm/child", "Merge", "csm/parent"),
    ).rejects.toThrow("Target branch 'csm/parent' has uncommitted changes");
  });
});
