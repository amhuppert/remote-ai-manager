import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultGitClient, type GitClient } from "./client";
import {
  createGitRepoTemplate,
  type GitRepoTemplate,
} from "../shared/testing/git-repo-template";
import {
  createWorktreeOperations,
  parseDirtyPaths,
  parseWorktreeStatusV2,
  readWorktreeStatusV2,
  ensureCcArtifactsExcluded,
  CC_ARTIFACTS_IGNORE_PATTERN,
} from "./worktree";

async function writeStatusFile(
  repo: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.join(repo, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

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
      { stdout: "targetTreeOID\n" },
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
    expect(gitMock.mock.calls[1]![0]).toEqual(["rev-parse", "tar012^{tree}"]);
    expect(gitMock.mock.calls[2]![0]).toEqual([
      "commit-tree",
      "treeOID123",
      "-p",
      "tar012",
      "-m",
      "Merge feature",
    ]);
    expect(gitMock.mock.calls[3]![0]).toEqual([
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
      { stdout: "targetTreeOID\n" }, // rev-parse <target>^{tree}
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
      { stdout: "targetTree1\n" }, // first prepare: rev-parse <target>^{tree}
      { stdout: "sha1\n" }, // first prepare: commit-tree
      { stdout: "" }, // first prepare: update-ref
      { stdout: "tree2\n" }, // second prepare: merge-tree (no version check!)
      { stdout: "targetTree2\n" }, // second prepare: rev-parse <target>^{tree}
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
      { stdout: "targetTreeOID\n" },
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

describe("prepareSquashMerge on an already-merged branch (real git)", () => {
  const realOps = createWorktreeOperations(defaultGitClient);
  let template: GitRepoTemplate;
  let repo: string;
  let targetSha: string;
  let featureSha: string;

  async function realGit(args: string[], cwd = repo): Promise<string> {
    const { stdout } = await defaultGitClient.git(args, cwd);
    return stdout.trim();
  }

  beforeAll(async () => {
    // `realGit` defaults to `repo`; point it at the template while building.
    template = await createGitRepoTemplate(
      "cc-prepare-uptodate-",
      async (dir) => {
        repo = dir;
        await realGit(["init", "--initial-branch=main", "."]);
        await realGit(["config", "user.email", "engine@command-center.test"]);
        await realGit(["config", "user.name", "Command Center"]);
        await writeFile(path.join(repo, "a.txt"), "base\n", "utf-8");
        await realGit(["add", "-A"]);
        await realGit(["commit", "-m", "base"]);

        // The feature lands on the target, which then moves on: the branch is
        // strictly behind its target yet fully contained in it.
        await realGit(["checkout", "-b", "csm/feature"]);
        await writeFile(path.join(repo, "feature.txt"), "feature\n", "utf-8");
        await realGit(["add", "-A"]);
        await realGit(["commit", "-m", "feature work"]);
        featureSha = await realGit(["rev-parse", "HEAD"]);
        await realGit(["checkout", "main"]);
        await realGit([
          "merge",
          "--no-ff",
          "-m",
          "land feature",
          "csm/feature",
        ]);
        await writeFile(path.join(repo, "b.txt"), "later\n", "utf-8");
        await realGit(["add", "-A"]);
        await realGit(["commit", "-m", "later work on target"]);
        targetSha = await realGit(["rev-parse", "HEAD"]);
      },
    );
  });

  afterAll(() => template.dispose());

  beforeEach(async () => {
    repo = await template.fresh();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const jobId = "job-uptodate";

  for (const forcePath of ["plumbing", "fallback"] as const) {
    it(`reports up-to-date without parking a commit on the ${forcePath} path`, async () => {
      const result = await realOps.prepareSquashMerge({
        projectPath: repo,
        featureBranch: "csm/feature",
        featureSha,
        targetBranch: "main",
        targetSha,
        message: "Merge: feature",
        jobId,
        forcePath,
      });

      expect(result).toEqual({
        kind: "up-to-date",
        expectedTargetSha: targetSha,
      });
      expect(await realGit(["rev-parse", "refs/heads/main"])).toBe(targetSha);
      expect(
        await realGit([
          "for-each-ref",
          "--format=%(refname)",
          "refs/cc-merges/",
        ]),
      ).toBe("");
    });
  }

  it("still prepares a commit when the branch carries work the target lacks", async () => {
    await realGit(["checkout", "csm/feature"]);
    await writeFile(path.join(repo, "feature.txt"), "more feature\n", "utf-8");
    await realGit(["add", "-A"]);
    await realGit(["commit", "-m", "more feature work"]);
    const advancedFeatureSha = await realGit(["rev-parse", "HEAD"]);

    const result = await realOps.prepareSquashMerge({
      projectPath: repo,
      featureBranch: "csm/feature",
      featureSha: advancedFeatureSha,
      targetBranch: "main",
      targetSha,
      message: "Merge: feature",
      jobId,
      forcePath: "plumbing",
    });

    expect(result.kind).toBe("prepared");
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

describe("publishPreparedMerge (real git)", () => {
  const realOps = createWorktreeOperations(defaultGitClient);
  const parkedRef = "refs/cc-merges/job-real";
  let template: GitRepoTemplate;
  let repo: string;
  let baseSha: string;
  let preparedSha: string;

  async function realGit(args: string[], cwd = repo): Promise<string> {
    const { stdout } = await defaultGitClient.git(args, cwd);
    return stdout.trim();
  }

  beforeAll(async () => {
    template = await createGitRepoTemplate(
      "cc-publish-prepared-",
      async (dir) => {
        repo = dir;
        await realGit(["init", "--initial-branch=main", "."]);
        await realGit(["config", "user.email", "engine@command-center.test"]);
        await realGit(["config", "user.name", "Command Center"]);
        await writeFile(path.join(repo, "a.txt"), "base\n", "utf-8");
        await realGit(["add", "-A"]);
        await realGit(["commit", "-m", "base"]);
        baseSha = await realGit(["rev-parse", "HEAD"]);

        // Park a commit whose tree differs from main's, so a stray reset
        // --hard into the target checkout would be visible in the working
        // file.
        await realGit(["checkout", "-b", "prep"]);
        await writeFile(path.join(repo, "a.txt"), "prepared\n", "utf-8");
        await realGit(["commit", "-am", "prepared"]);
        preparedSha = await realGit(["rev-parse", "HEAD"]);
        await realGit(["update-ref", parkedRef, preparedSha]);
        await realGit(["checkout", "main"]);
        await realGit(["branch", "-D", "prep"]);
      },
    );
  });

  afterAll(() => template.dispose());

  beforeEach(async () => {
    repo = await template.fresh();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("reports publish-failed with the git error when update-ref fails but the target ref never moved", async () => {
    // A crashed git leaves this behind; every later update-ref on the branch
    // fails with the tip still where the prepare left it.
    await writeFile(
      path.join(repo, ".git", "refs", "heads", "main.lock"),
      "",
      "utf-8",
    );

    const result = await realOps.publishPreparedMerge({
      projectPath: repo,
      targetBranch: "main",
      preparedSha,
      expectedTargetSha: baseSha,
      parkedRef,
      cleanTargetWorktreePath: repo,
    });

    expect(result.kind).toBe("publish-failed");
    if (result.kind !== "publish-failed") throw new Error("unexpected");
    expect(result.error).toContain("refs/heads/main");
    expect(result.error).toMatch(/lock/i);

    expect(await realGit(["rev-parse", "refs/heads/main"])).toBe(baseSha);
    // Neither the target checkout nor the parked ref may be touched.
    expect(await readFile(path.join(repo, "a.txt"), "utf-8")).toBe("base\n");
    expect(await realGit(["rev-parse", parkedRef])).toBe(preparedSha);
  });

  it("reports cas-lost with the moved tip when the target ref advanced under the prepare", async () => {
    await writeFile(path.join(repo, "b.txt"), "concurrent\n", "utf-8");
    await realGit(["add", "-A"]);
    await realGit(["commit", "-m", "concurrent"]);
    const movedSha = await realGit(["rev-parse", "HEAD"]);

    const result = await realOps.publishPreparedMerge({
      projectPath: repo,
      targetBranch: "main",
      preparedSha,
      expectedTargetSha: baseSha,
      parkedRef,
      cleanTargetWorktreePath: repo,
    });

    expect(result).toEqual({ kind: "cas-lost", actualTargetSha: movedSha });
    expect(await realGit(["rev-parse", parkedRef])).toBe(preparedSha);
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

describe("ensureCcArtifactsExcluded (real git)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "cc-artifacts-exclude-"));
    await defaultGitClient.git(["init"], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("makes the whole .cc namespace git-ignored and is idempotent", async () => {
    const docPath = path.join(repo, ".cc", "graph-workflow-docs", "charter.md");
    const scratchPath = path.join(repo, ".cc", "private-dev", "poll.log");
    await mkdir(path.dirname(docPath), { recursive: true });
    await mkdir(path.dirname(scratchPath), { recursive: true });
    await writeFile(docPath, "charter", "utf-8");
    await writeFile(scratchPath, "polling…", "utf-8");

    const before = await defaultGitClient.git(["status", "--porcelain"], repo);
    expect(before.stdout).toContain(".cc/");

    await ensureCcArtifactsExcluded(repo);

    const excludePath = path.join(repo, ".git", "info", "exclude");
    expect(await readFile(excludePath, "utf-8")).toContain(
      CC_ARTIFACTS_IGNORE_PATTERN,
    );

    // git now genuinely ignores everything under .cc/, so `add -A` sweeps
    // (lane auto-commits) and the dirty-start gate no longer see scratch.
    const after = await defaultGitClient.git(["status", "--porcelain"], repo);
    expect(after.stdout).not.toContain(".cc/");

    // A second call does not duplicate the rule.
    await ensureCcArtifactsExcluded(repo);
    const lineCount = (await readFile(excludePath, "utf-8"))
      .split("\n")
      .filter((line) => line.trim() === CC_ARTIFACTS_IGNORE_PATTERN).length;
    expect(lineCount).toBe(1);
  });

  it("appends the rule even when the legacy docs-only rule is present", async () => {
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, ".cc/graph-workflow-docs/\n", "utf-8");

    await ensureCcArtifactsExcluded(repo);

    const content = await readFile(excludePath, "utf-8");
    expect(content).toContain(".cc/graph-workflow-docs/");
    const lineCount = content
      .split("\n")
      .filter((line) => line.trim() === CC_ARTIFACTS_IGNORE_PATTERN).length;
    expect(lineCount).toBe(1);
  });
});

describe("abortInProgressMerge", () => {
  it("aborts and returns true when MERGE_HEAD exists", async () => {
    mockGitSequence([
      { stdout: "abc123\n" }, // rev-parse -q --verify MERGE_HEAD
      { stdout: "" }, // merge --abort
    ]);

    const aborted = await ops.abortInProgressMerge("/worktree");
    expect(aborted).toBe(true);

    expect(gitMock.mock.calls[0]![0]).toEqual([
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    expect(gitMock.mock.calls[0]![1]).toBe("/worktree");
    expect(gitMock.mock.calls[1]![0]).toEqual(["merge", "--abort"]);
    expect(gitMock.mock.calls[1]![1]).toBe("/worktree");
  });

  it("returns false without aborting when no merge is in progress", async () => {
    mockGitSequence([
      { error: Object.assign(new Error("exit 1"), { code: 1 }) },
    ]);

    const aborted = await ops.abortInProgressMerge("/worktree");
    expect(aborted).toBe(false);
    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure from git merge --abort", async () => {
    mockGitSequence([
      { stdout: "abc123\n" },
      { error: new Error("fatal: could not abort") },
    ]);

    await expect(ops.abortInProgressMerge("/worktree")).rejects.toThrow(
      "could not abort",
    );
  });
});

describe("parseWorktreeStatusV2", () => {
  it("reads the path out of each record kind, past the fixed fields that precede it", () => {
    const stdout = [
      "1 .M N... 100644 100644 100644 aaa bbb src/one.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.txt",
      "? src/untracked.txt",
      "! build/",
      "",
    ].join("\0");

    expect(parseWorktreeStatusV2(stdout)).toEqual([
      { path: "src/one.txt", originalPath: null, kind: "changed" },
      { path: "src/conflict.txt", originalPath: null, kind: "unmerged" },
      { path: "src/untracked.txt", originalPath: null, kind: "untracked" },
      { path: "build", originalPath: null, kind: "ignored" },
    ]);
  });

  it("consumes a rename's source from the following field, so both endpoints are attributable", () => {
    const stdout = [
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/moved.txt",
      "src/moveme.txt",
      "? src/after.txt",
      "",
    ].join("\0");

    expect(parseWorktreeStatusV2(stdout)).toEqual([
      {
        path: "src/moved.txt",
        originalPath: "src/moveme.txt",
        kind: "renamed",
      },
      { path: "src/after.txt", originalPath: null, kind: "untracked" },
    ]);
  });

  it("keeps paths with spaces and skips branch header lines", () => {
    const stdout = [
      "# branch.oid aaa",
      "# branch.head lane-1",
      "1 .M N... 100644 100644 100644 aaa bbb src/two words.txt",
      "",
    ].join("\0");

    expect(parseWorktreeStatusV2(stdout)).toEqual([
      { path: "src/two words.txt", originalPath: null, kind: "changed" },
    ]);
  });
});

describe("readWorktreeStatusV2 (real git)", () => {
  let template: GitRepoTemplate;
  let statusRepo: string;

  beforeAll(async () => {
    template = await createGitRepoTemplate(
      "cc-worktree-status-",
      async (repo) => {
        await defaultGitClient.git(["init", "--initial-branch=lane", "."], repo);
        await defaultGitClient.git(
          ["config", "user.email", "engine@command-center.test"],
          repo,
        );
        await defaultGitClient.git(
          ["config", "user.name", "Command Center"],
          repo,
        );
        await writeStatusFile(repo, ".gitignore", "build/\n*.log\n");
        await writeStatusFile(repo, "src/one.txt", "one\n");
        await writeStatusFile(repo, "src/moveme.txt", "move\n");
        await defaultGitClient.git(["add", "-A"], repo);
        await defaultGitClient.git(["commit", "-m", "base"], repo);
      },
    );
  });

  afterAll(() => template.dispose());

  beforeEach(async () => {
    statusRepo = await template.fresh();
  });

  afterEach(async () => {
    await rm(statusRepo, { recursive: true, force: true });
  });

  it("enumerates modifications, untracked files, and both rename endpoints without quoting names that contain a newline", async () => {
    await writeStatusFile(statusRepo, "src/one.txt", "one changed\n");
    await defaultGitClient.git(
      ["mv", "src/moveme.txt", "src/moved.txt"],
      statusRepo,
    );
    await writeStatusFile(statusRepo, "src/new\nline.txt", "newline\n");
    await writeStatusFile(statusRepo, 'src/we ird".txt', "quotes\n");

    const entries = await readWorktreeStatusV2(statusRepo);

    expect(entries).toContainEqual({
      path: "src/one.txt",
      originalPath: null,
      kind: "changed",
    });
    expect(entries).toContainEqual({
      path: "src/moved.txt",
      originalPath: "src/moveme.txt",
      kind: "renamed",
    });
    // Raw bytes, not git's C-style quoting: the classifier compares these
    // against declared ownership, and a quoted name would never match.
    expect(entries).toContainEqual({
      path: "src/new\nline.txt",
      originalPath: null,
      kind: "untracked",
    });
    expect(entries).toContainEqual({
      path: 'src/we ird".txt',
      originalPath: null,
      kind: "untracked",
    });
  });

  it("omits ignored paths, which ownership is never judged against", async () => {
    await writeStatusFile(statusRepo, "build/out.js", "built\n");
    await writeStatusFile(statusRepo, "debug.log", "log\n");

    expect(await readWorktreeStatusV2(statusRepo)).toEqual([]);
  });

  it("reports every untracked file individually rather than collapsing a new directory", async () => {
    await writeStatusFile(statusRepo, "generated/a.ts", "a\n");
    await writeStatusFile(statusRepo, "generated/b.ts", "b\n");

    expect(await readWorktreeStatusV2(statusRepo)).toEqual([
      { path: "generated/a.ts", originalPath: null, kind: "untracked" },
      { path: "generated/b.ts", originalPath: null, kind: "untracked" },
    ]);
  });

  it("reports a deletion inside the worktree", async () => {
    await rm(path.join(statusRepo, "src/one.txt"));

    expect(await readWorktreeStatusV2(statusRepo)).toEqual([
      { path: "src/one.txt", originalPath: null, kind: "changed" },
    ]);
  });
});

describe("parked merge refs (real git)", () => {
  const realOps = createWorktreeOperations(defaultGitClient);
  let template: GitRepoTemplate;
  let refRepo: string;
  let firstSha: string;

  async function refGit(args: string[]): Promise<string> {
    const { stdout } = await defaultGitClient.git(args, refRepo);
    return stdout.trim();
  }

  beforeAll(async () => {
    // `refGit` binds to `refRepo`; point it at the template while building.
    template = await createGitRepoTemplate("cc-parked-refs-", async (repo) => {
      refRepo = repo;
      await refGit(["init", "--initial-branch=main", "."]);
      await refGit(["config", "user.email", "engine@command-center.test"]);
      await refGit(["config", "user.name", "Command Center"]);
      await writeFile(path.join(refRepo, "a.txt"), "base\n", "utf-8");
      await refGit(["add", "-A"]);
      await refGit(["commit", "-m", "base"]);
      firstSha = await refGit(["rev-parse", "HEAD"]);
    });
  });

  afterAll(() => template.dispose());

  beforeEach(async () => {
    refRepo = await template.fresh();
  });

  afterEach(async () => {
    await rm(refRepo, { recursive: true, force: true });
  });

  it("lists every parked ref with the job id that owns it", async () => {
    await refGit(["update-ref", "refs/cc-merges/job-a", firstSha]);
    await refGit(["update-ref", "refs/cc-merges/job-b", firstSha]);
    await refGit(["update-ref", "refs/heads/unrelated", firstSha]);

    expect(await realOps.listParkedMergeRefs(refRepo)).toEqual([
      { ref: "refs/cc-merges/job-a", jobId: "job-a" },
      { ref: "refs/cc-merges/job-b", jobId: "job-b" },
    ]);
  });

  it("reports no parked refs for a repository that has none", async () => {
    expect(await realOps.listParkedMergeRefs(refRepo)).toEqual([]);
  });

  it("deletes a parked ref and reports the deletion", async () => {
    await refGit(["update-ref", "refs/cc-merges/job-a", firstSha]);

    expect(
      await realOps.deleteParkedMergeRef(refRepo, "refs/cc-merges/job-a"),
    ).toBe(true);

    expect(await realOps.listParkedMergeRefs(refRepo)).toEqual([]);
    // The commit itself is only unreachable, never rewritten: deleting the ref
    // must not touch the branch the prepare was based on.
    expect(await refGit(["rev-parse", "refs/heads/main"])).toBe(firstSha);
  });

  it("reports false for a ref that is already gone instead of throwing", async () => {
    expect(
      await realOps.deleteParkedMergeRef(refRepo, "refs/cc-merges/never"),
    ).toBe(false);
  });
});
