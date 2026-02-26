import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks – vi.hoisted ensures variables are available in vi.mock factories
// ---------------------------------------------------------------------------

const { execFileMock, parseDiffMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  parseDiffMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("./diff", () => ({
  parseDiff: parseDiffMock,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
import {
  hasUncommittedChanges,
  commitChanges,
  getCommitLog,
  getCommitDiff,
  squashMerge,
  mergeMainIntoFeature,
  isBranchAncestorOfMain,
} from "./git-operations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make execFileMock resolve via the promisified callback pattern */
function mockExecFileSuccess(stdout = "", stderr = "") {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (cb) {
        cb(null, { stdout, stderr });
      }
    },
  );
}

function mockExecFileFailure(error: Error) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (cb) {
        cb(error, { stdout: "", stderr: "" });
      }
    },
  );
}

/** Make execFileMock resolve in sequence for successive calls */
function mockExecFileSequence(
  results: Array<{ error?: Error; stdout?: string; stderr?: string }>,
) {
  let callIndex = 0;
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const result = results[callIndex] ?? results[results.length - 1]!;
      callIndex++;
      if (cb) {
        if (result.error) {
          cb(result.error, { stdout: "", stderr: "" });
        } else {
          cb(null, {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          });
        }
      }
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// hasUncommittedChanges
// ===========================================================================

describe("hasUncommittedChanges", () => {
  it("returns true when git status has output", async () => {
    mockExecFileSuccess(" M src/index.ts\n?? new-file.ts\n");
    const result = await hasUncommittedChanges("/worktree");
    expect(result).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      expect.objectContaining({ cwd: "/worktree" }),
      expect.any(Function),
    );
  });

  it("returns false when git status is empty", async () => {
    mockExecFileSuccess("");
    const result = await hasUncommittedChanges("/worktree");
    expect(result).toBe(false);
  });

  it("returns false for whitespace-only output", async () => {
    mockExecFileSuccess("   \n  ");
    const result = await hasUncommittedChanges("/worktree");
    expect(result).toBe(false);
  });
});

// ===========================================================================
// commitChanges
// ===========================================================================

describe("commitChanges", () => {
  it("stages all and commits, returning the hash", async () => {
    mockExecFileSequence([
      // hasUncommittedChanges → git status
      { stdout: " M file.ts\n" },
      // git add -A
      { stdout: "" },
      // git commit
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    const result = await commitChanges("/worktree", "Add feature");
    expect(result.hash).toBe("abc1234");

    // Verify git add -A was called
    expect(execFileMock.mock.calls[1]![1]).toEqual(["add", "-A"]);
    // Verify git commit with message
    expect(execFileMock.mock.calls[2]![1]).toEqual([
      "commit",
      "-m",
      "Add feature",
    ]);
  });

  it("throws when commit message is empty", async () => {
    await expect(commitChanges("/worktree", "")).rejects.toThrow(
      "Commit message cannot be empty",
    );
    await expect(commitChanges("/worktree", "   ")).rejects.toThrow(
      "Commit message cannot be empty",
    );
  });

  it("throws when there are no uncommitted changes", async () => {
    mockExecFileSuccess(""); // git status returns empty
    await expect(commitChanges("/worktree", "msg")).rejects.toThrow(
      "No uncommitted changes to commit",
    );
  });

  it("passes --no-verify when skipHooks is true", async () => {
    mockExecFileSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] WIP commit\n 1 file changed\n" },
    ]);

    const result = await commitChanges("/worktree", "WIP commit", {
      skipHooks: true,
    });
    expect(result.hash).toBe("abc1234");

    // Verify git commit was called with --no-verify
    expect(execFileMock.mock.calls[2]![1]).toEqual([
      "commit",
      "-m",
      "WIP commit",
      "--no-verify",
    ]);
  });

  it("does not pass --no-verify by default", async () => {
    mockExecFileSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "[csm/my-session abc1234] Add feature\n 1 file changed\n" },
    ]);

    await commitChanges("/worktree", "Add feature");

    // Verify git commit was called WITHOUT --no-verify
    expect(execFileMock.mock.calls[2]![1]).toEqual([
      "commit",
      "-m",
      "Add feature",
    ]);
  });

  it("returns empty hash when git output format is unexpected", async () => {
    mockExecFileSequence([
      { stdout: " M file.ts\n" },
      { stdout: "" },
      { stdout: "Unexpected output format" },
    ]);

    const result = await commitChanges("/worktree", "msg");
    expect(result.hash).toBe("");
  });
});

// ===========================================================================
// getCommitLog
// ===========================================================================

describe("getCommitLog", () => {
  it("parses git log output into CommitLogEntry array", async () => {
    // Full hashes must be exactly 40 hex chars to match the regex in git-operations
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

    mockExecFileSequence([
      // git log main..HEAD --format=...
      { stdout: logOutput },
      // git log main..HEAD --format=%H --numstat
      { stdout: numstatOutput },
    ]);

    const entries = await getCommitLog("/worktree");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.hash).toBe("abc1234");
    expect(entries[0]!.message).toBe("First commit");
    expect(entries[0]!.filesChanged).toBe(2);
    expect(entries[1]!.hash).toBe("def5678");
    expect(entries[1]!.message).toBe("Second commit");
    expect(entries[1]!.filesChanged).toBe(1);
  });

  it("returns empty array when git log fails (no main branch)", async () => {
    mockExecFileFailure(new Error("fatal: unknown revision"));
    const entries = await getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("returns empty array for empty log output", async () => {
    mockExecFileSuccess("");
    const entries = await getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("handles whitespace-only log output", async () => {
    mockExecFileSuccess("  \n  \n");
    const entries = await getCommitLog("/worktree");
    expect(entries).toEqual([]);
  });

  it("skips malformed log lines", async () => {
    const logOutput = [
      "abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Good commit\x002024-06-15T10:00:00Z\x00",
      "bad line with no delimiters",
      "", // empty line
    ].join("\n");

    mockExecFileSequence([
      { stdout: logOutput },
      // numstat call
      { stdout: "" },
    ]);

    const entries = await getCommitLog("/worktree");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("Good commit");
  });

  it("leaves filesChanged at 0 when numstat call fails", async () => {
    const logOutput =
      "abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Commit\x002024-06-15T10:00:00Z\x00";

    mockExecFileSequence([
      { stdout: logOutput },
      { error: new Error("numstat failed") },
    ]);

    const entries = await getCommitLog("/worktree");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.filesChanged).toBe(0);
  });

  it("handles special characters in commit messages", async () => {
    const logOutput =
      'abc1234\x00a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\x00Fix "quotes" & <angles>\x002024-06-15T10:00:00Z\x00';

    mockExecFileSequence([{ stdout: logOutput }, { stdout: "" }]);

    const entries = await getCommitLog("/worktree");
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
    mockExecFileSequence([
      // rev-parse --verify <hash>^ → parent hash
      { stdout: "parenthash123\n" },
      // merge-base --is-ancestor parent main → success means parent IS ancestor of main
      { stdout: "" },
      // merge-base main <hash> → merge-base hash
      { stdout: "mergebase789\n" },
      // git diff <merge-base>..<hash>
      { stdout: "diff --git a/file.ts b/file.ts\n" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await getCommitDiff("/worktree", "abc1234");
    expect(result).toEqual(mockDiff);

    // Verify merge-base was computed
    const mergeBaseCall = execFileMock.mock.calls[2]!;
    expect(mergeBaseCall[1]).toEqual(["merge-base", "main", "abc1234"]);

    // Verify diff was against merge-base
    const diffCall = execFileMock.mock.calls[3]!;
    expect(diffCall[1]).toEqual([
      "diff",
      "mergebase789..abc1234",
      "--unified=3",
    ]);
  });

  it("diffs against parent for subsequent commits", async () => {
    mockExecFileSequence([
      // rev-parse → parent hash
      { stdout: "parenthash123\n" },
      // merge-base --is-ancestor → failure means parent is NOT ancestor of main
      { error: new Error("not ancestor") },
      // git diff <hash>~1..<hash>
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await getCommitDiff("/worktree", "def5678");
    expect(result).toEqual(mockDiff);

    const diffCall = execFileMock.mock.calls[2]!;
    expect(diffCall[1]).toEqual(["diff", "def5678~1..def5678", "--unified=3"]);
  });

  it("falls back to diff against merge-base when rev-parse fails", async () => {
    mockExecFileSequence([
      // rev-parse fails (no parent)
      { error: new Error("no parent") },
      // merge-base main <hash> → merge-base hash
      { stdout: "mergebase789\n" },
      // git diff <merge-base>..<hash>
      { stdout: "diff output" },
    ]);
    parseDiffMock.mockReturnValue(mockDiff);

    const result = await getCommitDiff("/worktree", "abc1234");
    expect(result).toEqual(mockDiff);

    // Verify merge-base was computed
    const mergeBaseCall = execFileMock.mock.calls[1]!;
    expect(mergeBaseCall[1]).toEqual(["merge-base", "main", "abc1234"]);

    // Verify diff was against merge-base
    const diffCall = execFileMock.mock.calls[2]!;
    expect(diffCall[1]).toEqual([
      "diff",
      "mergebase789..abc1234",
      "--unified=3",
    ]);
  });

  it("returns empty diff when git diff output is empty", async () => {
    mockExecFileSequence([
      { stdout: "parenthash\n" },
      { error: new Error("not ancestor") },
      { stdout: "  \n" }, // whitespace only
    ]);

    const result = await getCommitDiff("/worktree", "abc1234");
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
    mockExecFileSequence([
      // git status --porcelain (clean check)
      { stdout: "" },
      // git merge --squash
      { stdout: "" },
      // git commit
      { stdout: "[main abc1234] Merge session\n" },
    ]);

    const result = await squashMerge(
      "/project",
      "csm/my-session",
      "Merge session",
    );
    expect(result.mergeHash).toBe("abc1234");

    // Verify commands were called in project root
    expect(execFileMock.mock.calls[0]![2]).toEqual(
      expect.objectContaining({ cwd: "/project" }),
    );
    // Verify squash merge args
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "merge",
      "--squash",
      "csm/my-session",
    ]);
    // Verify commit args (--no-verify skips hooks since validation runs before squash)
    expect(execFileMock.mock.calls[2]![1]).toEqual([
      "commit",
      "--no-verify",
      "-m",
      "Merge session",
    ]);
  });

  it("throws when merge message is empty", async () => {
    await expect(squashMerge("/project", "csm/branch", "")).rejects.toThrow(
      "Merge message cannot be empty",
    );
    await expect(squashMerge("/project", "csm/branch", "   ")).rejects.toThrow(
      "Merge message cannot be empty",
    );
  });

  it("throws when project root has uncommitted changes", async () => {
    mockExecFileSuccess(" M dirty-file.ts\n");
    await expect(
      squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Main branch has uncommitted changes");
  });

  it("returns empty hash when commit output format is unexpected", async () => {
    mockExecFileSequence([
      { stdout: "" },
      { stdout: "" },
      { stdout: "Unexpected output" },
    ]);

    const result = await squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("");
  });

  it("detects merge conflicts, aborts, and throws descriptive error", async () => {
    mockExecFileSequence([
      // git status --porcelain (clean)
      { stdout: "" },
      // git merge --squash → conflict
      {
        error: new Error(
          "CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
        ),
      },
      // git merge --abort (cleanup)
      { stdout: "" },
      // git reset --hard HEAD (cleanup)
      { stdout: "" },
    ]);

    await expect(
      squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Merge conflicts detected");

    // Verify cleanup: merge --abort and reset --hard were called
    expect(execFileMock.mock.calls[2]![1]).toEqual(["merge", "--abort"]);
    expect(execFileMock.mock.calls[3]![1]).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("resets project root when commit fails (e.g. pre-commit hook)", async () => {
    const commitError = Object.assign(new Error("Command failed: git commit"), {
      stderr: "husky - pre-commit script failed (code 1)",
      stdout: "",
    });

    mockExecFileSequence([
      // git status --porcelain (clean)
      { stdout: "" },
      // git merge --squash (succeeds — changes staged)
      { stdout: "" },
      // git commit → fails (pre-commit hook)
      { error: commitError },
      // git reset --hard HEAD (cleanup)
      { stdout: "" },
    ]);

    await expect(
      squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Commit failed");

    // Verify cleanup: reset --hard to undo staged squash changes
    expect(execFileMock.mock.calls[3]![1]).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("re-throws non-conflict merge errors without conflict message", async () => {
    mockExecFileSequence([
      { stdout: "" },
      // git merge --squash → non-conflict error
      { error: new Error("fatal: not a valid branch name") },
      // cleanup calls
      { stdout: "" },
      { stdout: "" },
    ]);

    await expect(
      squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("fatal: not a valid branch name");
  });
});

// ===========================================================================
// mergeMainIntoFeature
// ===========================================================================

describe("mergeMainIntoFeature", () => {
  it("returns clean status when git merge main succeeds", async () => {
    mockExecFileSuccess("Already up to date.\n");

    const result = await mergeMainIntoFeature("/worktree");
    expect(result).toEqual({ status: "clean" });

    // Verify git merge main was called in the worktree
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["merge", "main"],
      expect.objectContaining({ cwd: "/worktree" }),
      expect.any(Function),
    );
  });

  it("returns conflicts with file list when merge has CONFLICT in stderr", async () => {
    mockExecFileSequence([
      // git merge main → fails with CONFLICT
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
      // git diff --name-only --diff-filter=U → list conflicted files
      { stdout: "src/index.ts\nsrc/utils.ts\n" },
    ]);

    const result = await mergeMainIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/index.ts", "src/utils.ts"],
    });

    // Verify git diff was called to list conflicted files
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
  });

  it("returns conflicts when 'merge conflict' appears in error message", async () => {
    mockExecFileSequence([
      // git merge main → fails with "merge conflict" in message
      {
        error: Object.assign(new Error("Automatic merge conflict in file.ts"), {
          stderr: "Automatic merge conflict in file.ts",
        }),
      },
      // git diff --name-only --diff-filter=U
      { stdout: "file.ts\n" },
    ]);

    const result = await mergeMainIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["file.ts"],
    });
  });

  it("detects CONFLICT from error message when stderr is absent", async () => {
    mockExecFileSequence([
      // git merge main → fails with CONFLICT only in message (no stderr property)
      {
        error: new Error(
          "CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed",
        ),
      },
      // git diff --name-only --diff-filter=U
      { stdout: "src/app.ts\n" },
    ]);

    const result = await mergeMainIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/app.ts"],
    });
  });

  it("rethrows non-conflict errors", async () => {
    mockExecFileFailure(new Error("fatal: not something we can merge"));

    await expect(mergeMainIntoFeature("/worktree")).rejects.toThrow(
      "fatal: not something we can merge",
    );

    // Verify only one call was made (no git diff, no merge --abort)
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort the merge on conflict (leaves worktree in conflict state)", async () => {
    mockExecFileSequence([
      // git merge main → conflict
      {
        error: Object.assign(
          new Error("CONFLICT (content): Merge conflict in src/index.ts"),
          { stderr: "CONFLICT (content): Merge conflict in src/index.ts" },
        ),
      },
      // git diff --name-only --diff-filter=U
      { stdout: "src/index.ts\n" },
    ]);

    await mergeMainIntoFeature("/worktree");

    // Verify exactly 2 calls: git merge main + git diff
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Verify no merge --abort was called
    const allArgs = execFileMock.mock.calls.map(
      (call: unknown[]) => call[1] as string[],
    );
    const hasAbort = allArgs.some((args: string[]) => args.includes("--abort"));
    expect(hasAbort).toBe(false);
  });

  it("filters empty lines from conflicted file list", async () => {
    mockExecFileSequence([
      {
        error: Object.assign(new Error("CONFLICT (content): Merge conflict"), {
          stderr: "CONFLICT (content): Merge conflict",
        }),
      },
      // git diff output with trailing newlines / empty lines
      { stdout: "src/a.ts\n\nsrc/b.ts\n\n" },
    ]);

    const result = await mergeMainIntoFeature("/worktree");
    expect(result).toEqual({
      status: "conflicts",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });
  });
});

// ===========================================================================
// isBranchAncestorOfMain
// ===========================================================================

describe("isBranchAncestorOfMain", () => {
  it("returns true when branch is ancestor and has diverged from merge base", async () => {
    mockExecFileSequence([
      // merge-base --is-ancestor → success (exit 0)
      { stdout: "" },
      // rev-parse branchName → branch tip
      { stdout: "abc1234\n" },
      // merge-base branchName main → different commit
      { stdout: "def5678\n" },
    ]);

    const result = await isBranchAncestorOfMain("/project", "csm/my-session");
    expect(result).toBe(true);
  });

  it("returns false when branch tip equals merge base (never diverged)", async () => {
    mockExecFileSequence([
      // merge-base --is-ancestor → success (exit 0)
      { stdout: "" },
      // rev-parse branchName → branch tip
      { stdout: "abc1234\n" },
      // merge-base branchName main → same commit as branch tip
      { stdout: "abc1234\n" },
    ]);

    const result = await isBranchAncestorOfMain("/project", "csm/my-session");
    expect(result).toBe(false);
  });

  it("returns false when branch is not ancestor of main", async () => {
    mockExecFileSequence([
      // merge-base --is-ancestor → failure (exit 1)
      { error: new Error("not ancestor") },
    ]);

    const result = await isBranchAncestorOfMain("/project", "csm/my-session");
    expect(result).toBe(false);
  });

  it("returns false when git commands fail", async () => {
    mockExecFileSequence([
      // merge-base --is-ancestor → success
      { stdout: "" },
      // rev-parse fails
      { error: new Error("fatal: bad ref") },
    ]);

    const result = await isBranchAncestorOfMain("/project", "csm/my-session");
    expect(result).toBe(false);
  });
});
