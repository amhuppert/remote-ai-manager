import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitClient } from "./client";
import { createWorktreeOperations, parseDirtyPaths } from "./worktree";

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
  gitMock.mockReset();
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

describe("prepareSquashMerge plumbing path", () => {
  const baseInput = {
    projectPath: "/repo",
    featureBranch: "csm/feature",
    featureSha: "feat789",
    targetBranch: "main",
    targetSha: "tar012",
    message: "Merge feature",
    jobId: "job-1",
    forcePath: "plumbing" as const,
  };

  it("produces parked commit on a clean merge", async () => {
    mockGitSequence([
      { stdout: "treeOID123\n" },
      { stdout: "preparedSHA456\n" },
      { stdout: "" },
    ]);

    const result = await ops.prepareSquashMerge(baseInput);

    expect(result).toEqual({
      kind: "prepared",
      preparedSha: "preparedSHA456",
      expectedTargetSha: "tar012",
      parkedRef: "refs/cc-merges/job-1",
    });
    expect(gitMock.mock.calls[0]![0]).toEqual([
      "merge-tree",
      "--write-tree",
      "-z",
      "tar012",
      "feat789",
    ]);
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "commit-tree",
      "treeOID123",
      "-p",
      "tar012",
      "-m",
      "Merge feature",
    ]);
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "update-ref",
      "refs/cc-merges/job-1",
      "preparedSHA456",
    ]);
  });

  it("returns conflicts without creating a commit or parking a ref", async () => {
    const conflictStdout =
      "conflictedTreeOID\x00100644 baseOid 1\tfoo.ts\x00100644 oursOid 2\tfoo.ts\x00100644 theirsOid 3\tfoo.ts\x00\x00Auto-merging foo.ts\nCONFLICT (content): Merge conflict in foo.ts";
    const mergeTreeErr = Object.assign(new Error("merge-tree failed"), {
      code: 1,
      stdout: conflictStdout,
      stderr: "",
    });

    mockGitSequence([{ error: mergeTreeErr }]);

    const result = await ops.prepareSquashMerge(baseInput);

    expect(result).toEqual({
      kind: "conflicts",
      expectedTargetSha: "tar012",
      conflictFiles: ["foo.ts"],
    });
    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  it("returns deduplicated conflict file list for multiple conflicted files", async () => {
    const conflictStdout =
      "tree\x00100644 a 1\tone.ts\x00100644 b 2\tone.ts\x00100644 c 3\tone.ts\x00100644 d 1\ttwo.ts\x00100644 e 2\ttwo.ts\x00100644 f 3\ttwo.ts\x00\x00";
    const mergeTreeErr = Object.assign(new Error("conflict"), {
      code: 1,
      stdout: conflictStdout,
      stderr: "",
    });

    mockGitSequence([{ error: mergeTreeErr }]);

    const result = await ops.prepareSquashMerge(baseInput);

    expect(result.kind).toBe("conflicts");
    if (result.kind !== "conflicts") throw new Error("unexpected");
    expect(result.conflictFiles.sort()).toEqual(["one.ts", "two.ts"]);
  });

  it("rethrows non-exit-1 errors from merge-tree", async () => {
    const fatalErr = Object.assign(new Error("fatal: bad object"), {
      code: 128,
      stdout: "",
      stderr: "fatal: bad object",
    });
    mockGitSequence([{ error: fatalErr }]);

    await expect(ops.prepareSquashMerge(baseInput)).rejects.toThrow(
      "fatal: bad object",
    );
  });
});

describe("prepareSquashMerge fallback path", () => {
  const baseInput = {
    projectPath: "/repo",
    featureBranch: "csm/feature",
    featureSha: "feat789",
    targetBranch: "main",
    targetSha: "tar012",
    message: "Merge feature",
    jobId: "job-2",
    forcePath: "fallback" as const,
  };

  const tempPath = "/repo/.worktrees/__merge_job-2";

  it("produces parked commit using detached worktree on success", async () => {
    mockGitSequence([
      { stdout: "" }, // worktree add --detach
      { stdout: "" }, // merge --squash
      { stdout: "src/changed.ts\n" }, // diff --cached --name-only (no-op check)
      { stdout: "" }, // commit --no-verify
      { stdout: "preparedSHA999\n" }, // rev-parse HEAD
      { stdout: "" }, // update-ref refs/cc-merges/job-2 (park before cleanup)
      { stdout: "" }, // worktree remove -f (cleanup in finally)
    ]);

    const result = await ops.prepareSquashMerge(baseInput);

    expect(result).toEqual({
      kind: "prepared",
      preparedSha: "preparedSHA999",
      expectedTargetSha: "tar012",
      parkedRef: "refs/cc-merges/job-2",
    });

    const calls = gitMock.mock.calls.map((c) => ({ args: c[0], cwd: c[1] }));
    expect(calls[0]).toEqual({
      args: ["worktree", "add", "--detach", tempPath, "tar012"],
      cwd: "/repo",
    });
    expect(calls[1]).toEqual({
      args: ["merge", "--squash", "csm/feature"],
      cwd: tempPath,
    });
    expect(calls[3]).toEqual({
      args: ["commit", "--no-verify", "-m", "Merge feature"],
      cwd: tempPath,
    });
    expect(calls[4]).toEqual({ args: ["rev-parse", "HEAD"], cwd: tempPath });
    // parked ref must be advanced BEFORE the temp worktree is removed
    expect(calls[5]).toEqual({
      args: ["update-ref", "refs/cc-merges/job-2", "preparedSHA999"],
      cwd: "/repo",
    });
    expect(calls[6]).toEqual({
      args: ["worktree", "remove", "-f", tempPath],
      cwd: "/repo",
    });
  });

  it("returns conflicts and cleans up the temp worktree without producing a commit", async () => {
    const conflictErr = Object.assign(
      new Error(
        "CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed",
      ),
      {
        stderr:
          "CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed",
      },
    );

    mockGitSequence([
      { stdout: "" }, // worktree add --detach
      { error: conflictErr }, // merge --squash throws conflict
      { stdout: "src/a.ts\nsrc/b.ts\n" }, // diff --name-only --diff-filter=U
      { stdout: "" }, // worktree remove -f
    ]);

    const result = await ops.prepareSquashMerge(baseInput);

    expect(result).toEqual({
      kind: "conflicts",
      expectedTargetSha: "tar012",
      conflictFiles: ["src/a.ts", "src/b.ts"],
    });

    // verify cleanup happened (worktree remove called)
    const allCommands = gitMock.mock.calls.map((c) => c[0]);
    expect(allCommands).toContainEqual(["worktree", "remove", "-f", tempPath]);
    // verify no commit-tree / no update-ref ran
    expect(allCommands).not.toContainEqual(
      expect.arrayContaining(["update-ref", "refs/cc-merges/job-2"]),
    );
  });

  it("cleans up temp worktree even when commit step throws", async () => {
    const commitErr = Object.assign(new Error("commit failed"), {
      stderr: "husky failed",
      stdout: "",
    });

    mockGitSequence([
      { stdout: "" }, // worktree add --detach
      { stdout: "" }, // merge --squash
      { stdout: "src/x.ts\n" }, // diff --cached --name-only (has staged)
      { error: commitErr }, // commit --no-verify throws
      { stdout: "" }, // worktree remove -f (cleanup)
    ]);

    await expect(ops.prepareSquashMerge(baseInput)).rejects.toThrow();

    const allCommands = gitMock.mock.calls.map((c) => c[0]);
    expect(allCommands).toContainEqual(["worktree", "remove", "-f", tempPath]);
  });
});

describe("prepareSquashMerge auto-detect path", () => {
  const baseInput = {
    projectPath: "/repo",
    featureBranch: "csm/feature",
    featureSha: "feat789",
    targetBranch: "main",
    targetSha: "tar012",
    message: "Merge feature",
    jobId: "job-auto",
  };

  it("uses plumbing when git --version is >= 2.38.0", async () => {
    const opsLocal = createWorktreeOperations(testClient);
    mockGitSequence([
      { stdout: "git version 2.39.2\n" }, // git --version
      { stdout: "treeOID\n" }, // merge-tree
      { stdout: "preparedSHA\n" }, // commit-tree
      { stdout: "" }, // update-ref park
    ]);

    const result = await opsLocal.prepareSquashMerge(baseInput);

    expect(result.kind).toBe("prepared");
    expect(gitMock.mock.calls[0]![0]).toEqual(["--version"]);
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "merge-tree",
      "--write-tree",
      "-z",
      "tar012",
      "feat789",
    ]);
  });

  it("uses fallback when git --version is < 2.38.0", async () => {
    const opsLocal = createWorktreeOperations(testClient);
    mockGitSequence([
      { stdout: "git version 2.37.5\n" }, // git --version
      { stdout: "" }, // worktree add --detach
      { stdout: "" }, // merge --squash
      { stdout: "src/changed.ts\n" }, // diff --cached --name-only
      { stdout: "" }, // commit --no-verify
      { stdout: "preparedSHA\n" }, // rev-parse HEAD
      { stdout: "" }, // update-ref park
      { stdout: "" }, // worktree remove
    ]);

    const result = await opsLocal.prepareSquashMerge(baseInput);

    expect(result.kind).toBe("prepared");
    expect(gitMock.mock.calls[0]![0]).toEqual(["--version"]);
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "worktree",
      "add",
      "--detach",
      "/repo/.worktrees/__merge_job-auto",
      "tar012",
    ]);
  });

  it("caches git --version across calls (single probe per ops instance)", async () => {
    const opsLocal = createWorktreeOperations(testClient);
    mockGitSequence([
      { stdout: "git version 2.40.0\n" }, // git --version (only called once)
      { stdout: "tree1\n" }, // first prepare: merge-tree
      { stdout: "sha1\n" }, // first prepare: commit-tree
      { stdout: "" }, // first prepare: update-ref
      { stdout: "tree2\n" }, // second prepare: merge-tree (no version check!)
      { stdout: "sha2\n" }, // second prepare: commit-tree
      { stdout: "" }, // second prepare: update-ref
    ]);

    await opsLocal.prepareSquashMerge(baseInput);
    await opsLocal.prepareSquashMerge({ ...baseInput, jobId: "job-auto-2" });

    const versionCalls = gitMock.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "--version",
    );
    expect(versionCalls).toHaveLength(1);
  });

  it("forcePath overrides auto-detect and skips git --version probe", async () => {
    const opsLocal = createWorktreeOperations(testClient);
    mockGitSequence([
      { stdout: "treeOID\n" },
      { stdout: "preparedSHA\n" },
      { stdout: "" },
    ]);

    const result = await opsLocal.prepareSquashMerge({
      ...baseInput,
      forcePath: "plumbing",
    });

    expect(result.kind).toBe("prepared");
    const versionCalls = gitMock.mock.calls.filter(
      (c) => Array.isArray(c[0]) && c[0][0] === "--version",
    );
    expect(versionCalls).toHaveLength(0);
  });
});

describe("publishPreparedMerge", () => {
  const baseInput = {
    projectPath: "/repo",
    targetBranch: "main",
    preparedSha: "prepSHA",
    expectedTargetSha: "expTar",
    parkedRef: "refs/cc-merges/job-3",
    cleanTargetWorktreePath: null as string | null,
  };

  it("advances the target ref and deletes the parked ref on CAS success without a target worktree", async () => {
    mockGitSequence([
      { stdout: "" }, // update-ref refs/heads/main preparedSha expectedSha
      { stdout: "" }, // update-ref -d parkedRef preparedSha
    ]);

    const result = await ops.publishPreparedMerge(baseInput);

    expect(result).toEqual({ kind: "published", mergeHash: "prepSHA" });
    expect(gitMock.mock.calls[0]![0]).toEqual([
      "update-ref",
      "refs/heads/main",
      "prepSHA",
      "expTar",
    ]);
    expect(gitMock.mock.calls[1]![0]).toEqual([
      "update-ref",
      "-d",
      "refs/cc-merges/job-3",
      "prepSHA",
    ]);
  });

  it("refreshes a clean target worktree and deletes the parked ref on CAS success", async () => {
    mockGitSequence([
      { stdout: "" }, // update-ref refs/heads/main
      { stdout: "" }, // reset --hard preparedSha (in target worktree)
      { stdout: "" }, // update-ref -d parkedRef
    ]);

    const result = await ops.publishPreparedMerge({
      ...baseInput,
      cleanTargetWorktreePath: "/repo",
    });

    expect(result).toEqual({ kind: "published", mergeHash: "prepSHA" });
    expect(gitMock.mock.calls[1]![1]).toBe("/repo");
    expect(gitMock.mock.calls[1]![0]).toEqual(["reset", "--hard", "prepSHA"]);
  });

  it("surfaces refresh failure as refreshWarning and still deletes the parked ref", async () => {
    const refreshErr = Object.assign(new Error("reset failed"), {
      stderr: "fatal: unable to update worktree",
    });

    mockGitSequence([
      { stdout: "" }, // update-ref
      { error: refreshErr }, // reset --hard fails
      { stdout: "" }, // update-ref -d parkedRef (still runs)
    ]);

    const result = await ops.publishPreparedMerge({
      ...baseInput,
      cleanTargetWorktreePath: "/repo",
    });

    expect(result.kind).toBe("published");
    if (result.kind !== "published") throw new Error("unexpected");
    expect(result.mergeHash).toBe("prepSHA");
    expect(result.refreshWarning).toContain("unable to update worktree");

    const commands = gitMock.mock.calls.map((c) => c[0]);
    expect(commands).toContainEqual([
      "update-ref",
      "-d",
      "refs/cc-merges/job-3",
      "prepSHA",
    ]);
  });

  it("returns cas-lost with actualTargetSha and retains the parked ref on CAS failure", async () => {
    const casErr = Object.assign(new Error("update-ref rejected"), {
      stderr: "fatal: cannot update ref",
    });

    mockGitSequence([
      { error: casErr }, // update-ref CAS fails
      { stdout: "actualSHA\n" }, // rev-parse refs/heads/main
    ]);

    const result = await ops.publishPreparedMerge({
      ...baseInput,
      cleanTargetWorktreePath: "/repo",
    });

    expect(result).toEqual({
      kind: "cas-lost",
      actualTargetSha: "actualSHA",
    });

    const commands = gitMock.mock.calls.map((c) => c[0]);
    // never refresh
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["reset", "--hard", "prepSHA"]),
    );
    // never delete parked ref
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["update-ref", "-d", "refs/cc-merges/job-3"]),
    );
  });
});

describe("discoverTargetCheckout", () => {
  it("returns not-checked-out when target branch has no matching worktree", async () => {
    mockGitSequence([
      {
        stdout:
          "worktree /repo\nHEAD abc123\nbranch refs/heads/csm/feature\n\n",
      },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result).toEqual({ kind: "not-checked-out" });
    expect(gitMock.mock.calls[0]![0]).toEqual([
      "worktree",
      "list",
      "--porcelain",
    ]);
  });

  it("returns clean when target worktree has only untracked files", async () => {
    mockGitSequence([
      {
        stdout:
          "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/.worktrees/feature\nHEAD def456\nbranch refs/heads/csm/feature\n\n",
      },
      { stdout: "?? new-untracked.ts\n" },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result).toEqual({ kind: "clean", worktreePath: "/repo" });
    expect(gitMock.mock.calls[1]![1]).toBe("/repo");
    expect(gitMock.mock.calls[1]![0]).toEqual(["status", "--porcelain"]);
  });

  it("returns clean when target worktree is fully clean", async () => {
    mockGitSequence([
      {
        stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n",
      },
      { stdout: "" },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result).toEqual({ kind: "clean", worktreePath: "/repo" });
  });

  it("returns dirty with tracked-only dirty paths when target worktree has tracked changes", async () => {
    mockGitSequence([
      {
        stdout: "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n",
      },
      { stdout: " M src/index.ts\n?? new.ts\n" },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result.kind).toBe("dirty");
    if (result.kind !== "dirty") throw new Error("unexpected");
    expect(result.worktreePath).toBe("/repo");
    expect(result.trackedDirtyPaths).toEqual([
      { path: "src/index.ts", statusCode: " M", tracked: true },
    ]);
  });

  it("matches target branch among multiple worktrees", async () => {
    mockGitSequence([
      {
        stdout:
          "worktree /repo\nHEAD abc\nbranch refs/heads/csm/a\n\nworktree /repo/.worktrees/main\nHEAD def\nbranch refs/heads/main\n\nworktree /repo/.worktrees/b\nHEAD ghi\nbranch refs/heads/csm/b\n\n",
      },
      { stdout: "" },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result).toEqual({
      kind: "clean",
      worktreePath: "/repo/.worktrees/main",
    });
    expect(gitMock.mock.calls[1]![1]).toBe("/repo/.worktrees/main");
  });

  it("returns not-checked-out for detached worktrees with no branch", async () => {
    mockGitSequence([
      {
        stdout: "worktree /repo\nHEAD abc\ndetached\n\n",
      },
    ]);

    const result = await ops.discoverTargetCheckout("/repo", "main");
    expect(result).toEqual({ kind: "not-checked-out" });
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
