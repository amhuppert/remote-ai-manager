import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitClient } from "./client";
import { createCommitsOperations } from "./commits";

const gitMock = vi.fn();

const testClient: GitClient = {
  git: gitMock,
};

const ops = createCommitsOperations(testClient);

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
