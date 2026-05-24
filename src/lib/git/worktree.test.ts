import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitClient } from "./client";
import { createWorktreeOperations, parseDirtyPaths } from "./worktree";
import { MergePreconditionFailed } from "../workflow-graph/errors";

const gitMock = vi.fn();

const testClient: GitClient = {
  git: gitMock,
};

const ops = createWorktreeOperations(testClient);

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
    ).rejects.toThrow("Target branch 'main' has");
  });

  it("throws MergePreconditionFailed with structured payload for tracked dirty files", async () => {
    mockGitSuccess(" M dirty-one.ts\nM  dirty-two.ts\n?? new.ts\n");
    try {
      await ops.squashMerge("/project", "csm/branch", "Merge");
      throw new Error("expected MergePreconditionFailed");
    } catch (err) {
      expect(err).toBeInstanceOf(MergePreconditionFailed);
      const typed = err as MergePreconditionFailed;
      expect(typed.targetBranch).toBe("main");
      expect(typed.dirtyCount).toBe(2);
      expect(typed.dirtyPaths.map((p) => p.path)).toEqual([
        "dirty-one.ts",
        "dirty-two.ts",
      ]);
      expect(typed.dirtyPaths.every((p) => p.tracked)).toBe(true);
    }
  });

  it("ignores untracked files in merge path cleanliness check", async () => {
    mockGitSequence([
      { stdout: "?? some-untracked-file.html\n" },
      { stdout: "" },
      { stdout: "src/changed.ts\n" },
      { stdout: "[main abc1234] Merge\n" },
    ]);

    const result = await ops.squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("abc1234");
  });

  it("throws when merge path has tracked changes alongside untracked files", async () => {
    mockGitSequence([{ stdout: "?? untracked.html\n M dirty-file.ts\n" }]);
    await expect(
      ops.squashMerge("/project", "csm/branch", "Merge"),
    ).rejects.toThrow("Target branch 'main' has");
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
    mockGitSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

    const result = await ops.squashMerge("/project", "csm/branch", "Merge");
    expect(result.mergeHash).toBe("");

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

  it("uses custom targetBranch in error message", async () => {
    mockGitSuccess(" M dirty.ts\n");

    await expect(
      ops.squashMerge("/parent-worktree", "csm/child", "Merge", "csm/parent"),
    ).rejects.toThrow("Target branch 'csm/parent' has");
  });
});

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

  it("uses custom targetBranch", async () => {
    mockGitSuccess("Already up to date.\n");

    await ops.mergeTargetIntoFeature("/worktree", "csm/parent");

    expect(gitMock.mock.calls[0]![0]).toEqual(["merge", "csm/parent"]);
  });
});

describe("parseDirtyPaths", () => {
  it("returns empty array for empty input", () => {
    expect(parseDirtyPaths("")).toEqual([]);
    expect(parseDirtyPaths("\n\n")).toEqual([]);
  });

  it("parses modified tracked file", () => {
    expect(parseDirtyPaths(" M src/index.ts\n")).toEqual([
      { path: "src/index.ts", statusCode: " M", tracked: true },
    ]);
  });

  it("parses staged modified file", () => {
    expect(parseDirtyPaths("M  src/index.ts\n")).toEqual([
      { path: "src/index.ts", statusCode: "M ", tracked: true },
    ]);
  });

  it("flags untracked files with tracked=false", () => {
    expect(parseDirtyPaths("?? new-file.ts\n")).toEqual([
      { path: "new-file.ts", statusCode: "??", tracked: false },
    ]);
  });

  it("parses rename and records destination path", () => {
    expect(parseDirtyPaths("R  old-name.ts -> new-name.ts\n")).toEqual([
      { path: "new-name.ts", statusCode: "R ", tracked: true },
    ]);
  });

  it("ignores blank lines and handles mixed entries", () => {
    const input = " M a.ts\n\n?? b.ts\nM  c.ts\n";
    expect(parseDirtyPaths(input)).toEqual([
      { path: "a.ts", statusCode: " M", tracked: true },
      { path: "b.ts", statusCode: "??", tracked: false },
      { path: "c.ts", statusCode: "M ", tracked: true },
    ]);
  });
});
