import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  unlink as fsUnlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseDiff,
  computeDiff,
  computeCandidateSnapshot,
  computeCandidateTreeHash,
  hasCandidateScopeChanges,
  _resetDiffCacheForTesting,
} from "./diff";
import type { CandidateScope, ComputeDiffDeps } from "./diff";
import { defaultGitClient } from "./client";
import { buildChildEnv } from "../shared/child-env";

const execFileAsync = promisify(execFile);

describe("parseDiff", () => {
  it("returns empty diff for empty input", () => {
    const result = parseDiff("");
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);
  });

  it("parses a single file diff with one hunk", () => {
    const raw = `diff --git a/src/index.ts b/src/index.ts
index abc1234..def5678 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { foo } from "bar";
+import { baz } from "qux";

 const x = 1;`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);

    const file = result.files[0]!;
    expect(file.filePath).toBe("src/index.ts");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(0);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0]!;
    expect(hunk.header).toMatch(/^@@/);
    // hunk-header + 1 context + 1 add + 1 context + 1 context = 5 lines
    expect(hunk.lines).toHaveLength(5);
    expect(hunk.lines[0]!.type).toBe("hunk-header");
    expect(hunk.lines[1]!.type).toBe("context");
    expect(hunk.lines[2]!.type).toBe("add");
    expect(hunk.lines[2]!.content).toBe('import { baz } from "qux";');
  });

  it("parses deletions", () => {
    const raw = `diff --git a/README.md b/README.md
index abc..def 100644
--- a/README.md
+++ b/README.md
@@ -1,4 +1,3 @@
 # Title
-old line

 content`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.additions).toBe(0);
    expect(result.files[0]!.deletions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });

  it("parses multiple files", () => {
    const raw = `diff --git a/file1.ts b/file1.ts
index abc..def 100644
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/file2.ts b/file2.ts
index abc..def 100644
--- a/file2.ts
+++ b/file2.ts
@@ -1,3 +1,2 @@
 line1
-removed
 line2`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]!.filePath).toBe("file1.ts");
    expect(result.files[0]!.additions).toBe(1);
    expect(result.files[1]!.filePath).toBe("file2.ts");
    expect(result.files[1]!.deletions).toBe(1);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });

  it("parses multiple hunks in one file", () => {
    const raw = `diff --git a/big.ts b/big.ts
index abc..def 100644
--- a/big.ts
+++ b/big.ts
@@ -1,3 +1,4 @@
 first
+added1
 second
 third
@@ -10,3 +11,4 @@
 tenth
+added2
 eleventh
 twelfth`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.hunks).toHaveLength(2);
    expect(result.files[0]!.additions).toBe(2);
  });

  it("handles new file mode lines", () => {
    const raw = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+line1
+line2`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filePath).toBe("new.ts");
    expect(result.files[0]!.additions).toBe(2);
  });

  it("skips deleted file mode metadata lines", () => {
    const raw = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filePath).toBe("old.ts");
    expect(result.files[0]!.deletions).toBe(2);
  });

  it("skips old mode / new mode metadata lines", () => {
    const raw = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
index abc..def
--- a/script.sh
+++ b/script.sh
@@ -1,2 +1,3 @@
 #!/bin/bash
+echo "hello"
 exit 0`;

    const result = parseDiff(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.additions).toBe(1);
    expect(result.files[0]!.deletions).toBe(0);
  });

  it("computes totalAdditions and totalDeletions correctly across files", () => {
    const raw = `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,4 @@
 line1
+add1
+add2
 line2
diff --git a/b.ts b/b.ts
index abc..def 100644
--- a/b.ts
+++ b/b.ts
@@ -1,4 +1,2 @@
 line1
-del1
-del2
 line2`;

    const result = parseDiff(raw);
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(2);
    expect(result.files[0]!.additions).toBe(2);
    expect(result.files[1]!.deletions).toBe(2);
  });

  it("preserves file ordering from diff output", () => {
    const raw = `diff --git a/z-last.ts b/z-last.ts
index abc..def 100644
--- a/z-last.ts
+++ b/z-last.ts
@@ -1 +1,2 @@
 x
+y
diff --git a/a-first.ts b/a-first.ts
index abc..def 100644
--- a/a-first.ts
+++ b/a-first.ts
@@ -1 +1,2 @@
 x
+y`;

    const result = parseDiff(raw);
    expect(result.files[0]!.filePath).toBe("z-last.ts");
    expect(result.files[1]!.filePath).toBe("a-first.ts");
  });
});

// ===========================================================================
// computeDiff — uses injected deps instead of vi.mock
// ===========================================================================

function createMockDeps(): {
  deps: ComputeDiffDeps;
  mockGit: ReturnType<typeof vi.fn>;
  mockUnlink: ReturnType<typeof vi.fn>;
} {
  const mockGit = vi.fn();
  const mockUnlink = vi.fn().mockResolvedValue(undefined);
  return {
    deps: { gitClient: { git: mockGit }, unlink: mockUnlink },
    mockGit,
    mockUnlink,
  };
}

function mockTokenAndDiff(
  mockGit: ReturnType<typeof vi.fn>,
  opts: { headSha: string; porcelain: string; diffStdout: string },
): void {
  // Order: rev-parse HEAD, status --porcelain, read-tree, add -A, diff
  mockGit
    .mockResolvedValueOnce({ stdout: `${opts.headSha}\n`, stderr: "" })
    .mockResolvedValueOnce({ stdout: opts.porcelain, stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: opts.diffStdout, stderr: "" });
}

describe("computeDiff", () => {
  beforeEach(() => {
    _resetDiffCacheForTesting();
  });

  it("uses temp index to diff working tree against HEAD", async () => {
    const { deps, mockGit, mockUnlink } = createMockDeps();
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
index abc..def 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 line1
+new line
 line2`;

    mockTokenAndDiff(mockGit, {
      headSha: "deadbeef",
      porcelain: " M src/app.ts\0",
      diffStdout: diffOutput,
    });

    const result = await computeDiff("/projects/repo/.worktrees/test", deps);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filePath).toBe("src/app.ts");
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(0);
    expect(result.files[0]!.additions).toBe(1);
    expect(result.files[0]!.hunks).toHaveLength(1);
    expect(
      result.files[0]!.hunks[0]!.lines.some(
        (l) => l.type === "add" && l.content === "new line",
      ),
    ).toBe(true);

    // Verify temp index env is set for the index-mutating git calls
    // (rev-parse and status do not use the temp index)
    const indexCalls = mockGit.mock.calls.slice(2);
    for (const call of indexCalls) {
      const opts = call[2] as { env: Record<string, string> };
      expect(opts.env.GIT_INDEX_FILE).toMatch(/cc-diff-/);
    }

    // Verify temp index cleanup
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff on read-tree failure", async () => {
    const { deps, mockGit, mockUnlink } = createMockDeps();
    // rev-parse + status succeed (token probe), then read-tree fails
    mockGit
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("git failed"));

    const result = await computeDiff("/projects/repo/.worktrees/test", deps);
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);

    // Temp index cleanup still called
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff for empty git diff output", async () => {
    const { deps, mockGit } = createMockDeps();
    mockTokenAndDiff(mockGit, {
      headSha: "deadbeef",
      porcelain: "",
      diffStdout: "",
    });

    const result = await computeDiff("/projects/repo/.worktrees/test", deps);
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
  });
});

describe("computeDiff caching", () => {
  beforeEach(() => {
    _resetDiffCacheForTesting();
  });

  it("returns the same diff reference when HEAD and porcelain are unchanged", async () => {
    const { deps, mockGit } = createMockDeps();
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
index abc..def 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 line1
+new line
 line2`;
    // First call: full 5-mock sequence
    mockTokenAndDiff(mockGit, {
      headSha: "deadbeef",
      porcelain: " M src/app.ts\0",
      diffStdout: diffOutput,
    });
    // Second call: only token probes — cache should serve diff
    mockGit
      .mockResolvedValueOnce({ stdout: "deadbeef\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: " M src/app.ts\0", stderr: "" });

    const first = await computeDiff("/projects/repo/.worktrees/test", deps);
    const second = await computeDiff("/projects/repo/.worktrees/test", deps);

    expect(second).toBe(first);
    // Exactly 5 (first compute) + 2 (cached probe) = 7 git invocations
    expect(mockGit).toHaveBeenCalledTimes(7);
  });

  it("recomputes the diff when HEAD changes", async () => {
    const { deps, mockGit } = createMockDeps();
    // First compute
    mockTokenAndDiff(mockGit, {
      headSha: "old-sha",
      porcelain: "",
      diffStdout: "",
    });
    // Second compute: HEAD changed → token miss → full diff sequence
    mockTokenAndDiff(mockGit, {
      headSha: "new-sha",
      porcelain: "",
      diffStdout: `diff --git a/x.ts b/x.ts
index abc..def 100644
--- a/x.ts
+++ b/x.ts
@@ -1 +1,2 @@
 x
+y`,
    });

    const first = await computeDiff("/projects/repo/.worktrees/test", deps);
    const second = await computeDiff("/projects/repo/.worktrees/test", deps);

    expect(second).not.toBe(first);
    expect(first.files).toHaveLength(0);
    expect(second.files).toHaveLength(1);
    expect(second.files[0]!.filePath).toBe("x.ts");
  });

  it("recomputes the diff when worktree status changes", async () => {
    const { deps, mockGit } = createMockDeps();
    mockTokenAndDiff(mockGit, {
      headSha: "same-sha",
      porcelain: "",
      diffStdout: "",
    });
    mockTokenAndDiff(mockGit, {
      headSha: "same-sha",
      porcelain: " M a.ts\0",
      diffStdout: `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1,2 @@
 a
+b`,
    });

    const first = await computeDiff("/projects/repo/.worktrees/test", deps);
    const second = await computeDiff("/projects/repo/.worktrees/test", deps);

    expect(second).not.toBe(first);
    expect(second.files[0]!.filePath).toBe("a.ts");
  });

  it("isolates caches per worktree path", async () => {
    const { deps, mockGit } = createMockDeps();
    mockTokenAndDiff(mockGit, {
      headSha: "sha-a",
      porcelain: "",
      diffStdout: "",
    });
    mockTokenAndDiff(mockGit, {
      headSha: "sha-b",
      porcelain: "",
      diffStdout: `diff --git a/b.ts b/b.ts
index abc..def 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1,2 @@
 b
+c`,
    });

    const a = await computeDiff("/projects/repo/.worktrees/a", deps);
    const b = await computeDiff("/projects/repo/.worktrees/b", deps);

    expect(b).not.toBe(a);
    expect(a.files).toHaveLength(0);
    expect(b.files).toHaveLength(1);
  });
});

// ===========================================================================
// Golden tests — computeDiff over a real git repository with the production
// default deps. Pins the full structured SessionDiff output so the internals
// (temp index, git invocation plumbing) can change without changing behavior.
// ===========================================================================

describe("computeDiff golden (real repo)", () => {
  let repoDir: string;

  async function git(...args: string[]): Promise<string> {
    // Sanitized child env (same as the production GitClient) so an inherited
    // GIT_DIR / GIT_INDEX_FILE — e.g. when this suite runs inside a git
    // hook — cannot leak the fixture's mutations into the real repo.
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoDir = await mkdtemp(join(tmpdir(), "cc-diff-golden-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(join(repoDir, "a.txt"), "alpha\nbeta\ngamma\n");
    await writeFile(join(repoDir, "b.txt"), "one\ntwo\n");
    await git("add", "-A");
    await git("commit", "-m", "baseline");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("pins the structured diff for modify + delete + untracked-add", async () => {
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\ngamma\n");
    await fsUnlink(join(repoDir, "b.txt"));
    await writeFile(join(repoDir, "new.txt"), "fresh\n");

    const diff = await computeDiff(repoDir);

    expect(diff).toEqual({
      totalAdditions: 2,
      totalDeletions: 3,
      files: [
        {
          filePath: "a.txt",
          additions: 1,
          deletions: 1,
          hunks: [
            {
              header: "@@ -1,3 +1,3 @@",
              lines: [
                { type: "hunk-header", content: "@@ -1,3 +1,3 @@" },
                { type: "context", content: "alpha" },
                { type: "remove", content: "beta" },
                { type: "add", content: "BETA" },
                { type: "context", content: "gamma" },
              ],
            },
          ],
        },
        {
          filePath: "b.txt",
          additions: 0,
          deletions: 2,
          hunks: [
            {
              header: "@@ -1,2 +0,0 @@",
              lines: [
                { type: "hunk-header", content: "@@ -1,2 +0,0 @@" },
                { type: "remove", content: "one" },
                { type: "remove", content: "two" },
              ],
            },
          ],
        },
        {
          filePath: "new.txt",
          additions: 1,
          deletions: 0,
          hunks: [
            {
              header: "@@ -0,0 +1 @@",
              lines: [
                { type: "hunk-header", content: "@@ -0,0 +1 @@" },
                { type: "add", content: "fresh" },
                // Trailing empty context line from the diff's final newline —
                // part of the pinned parse output.
                { type: "context", content: "" },
              ],
            },
          ],
        },
      ],
    });

    // Diffing must not touch the real index: b.txt stays a working-tree-only
    // deletion and new.txt stays untracked.
    const porcelain = await git("status", "--porcelain=v1");
    expect(porcelain).toContain(" D b.txt");
    expect(porcelain).toContain("?? new.txt");
  });

  it("returns an empty diff for a clean worktree", async () => {
    const diff = await computeDiff(repoDir);
    expect(diff).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
  });

  it("returns an empty diff for a non-repo directory", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "cc-diff-plain-"));
    try {
      const diff = await computeDiff(plainDir);
      expect(diff).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  it("serves the cached diff object until the worktree status changes", async () => {
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\ngamma\n");

    const first = await computeDiff(repoDir);
    const second = await computeDiff(repoDir);
    expect(second).toBe(first);

    // The cache token is HEAD + a hash of `git status --porcelain=v1 -z`.
    // Porcelain output does not include file content, so editing an
    // already-modified file leaves the token unchanged and the cached diff
    // keeps being served — pinned here as the token's granularity.
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\nGAMMA\n");
    expect(await computeDiff(repoDir)).toBe(first);

    // A status-visible change (new untracked file) rotates the token.
    await writeFile(join(repoDir, "c.txt"), "c\n");
    const third = await computeDiff(repoDir);
    expect(third).not.toBe(first);
    expect(third.totalAdditions).toBe(3);
    expect(third.totalDeletions).toBe(2);
  });
});

describe("computeCandidateTreeHash (real repo)", () => {
  let repoDir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoDir = await mkdtemp(join(tmpdir(), "cc-tree-hash-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "core.fileMode", "true");
    await writeFile(join(repoDir, ".gitignore"), ".cc/\ndist/\n");
    await writeFile(join(repoDir, "a.txt"), "alpha\nbeta\ngamma\n");
    await git("add", "-A");
    await git("commit", "-m", "baseline");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("hashes the HEAD tree for a clean worktree without touching the real index", async () => {
    const hash = await computeCandidateTreeHash(repoDir);

    expect(hash).toBe((await git("rev-parse", "HEAD^{tree}")).trim());
    expect((await git("status", "--porcelain=v1")).trim()).toBe("");
  });

  it("puts untracked content inside the identity and matches the tree `add -A` stages", async () => {
    const baseline = await computeCandidateTreeHash(repoDir);
    await writeFile(join(repoDir, "new.txt"), "fresh\n");

    const withUntracked = await computeCandidateTreeHash(repoDir);
    expect(withUntracked).not.toBe(baseline);

    // The real index is untouched: new.txt is still untracked afterwards.
    expect(await git("status", "--porcelain=v1")).toContain("?? new.txt");

    // Same tree the diff pipeline's temporary index builds: seeded from HEAD,
    // then `add -A`. Staged for real here only after the untouched-index
    // assertion above, so the comparison cannot mask a leak.
    await git("add", "-A");
    expect(withUntracked).toBe((await git("write-tree")).trim());
  });

  it("puts a file-mode change inside the identity", async () => {
    const baseline = await computeCandidateTreeHash(repoDir);
    await chmod(join(repoDir, "a.txt"), 0o755);

    expect(await computeCandidateTreeHash(repoDir)).not.toBe(baseline);
  });

  it("leaves gitignored build artifacts and lane logs outside the identity", async () => {
    const baseline = await computeCandidateTreeHash(repoDir);

    // `.cc/workflow/` is where the script validator writes its failure logs, and
    // `dist/` stands in for build output. Both are gitignored, so neither can
    // move the candidate a cohort is reviewing.
    await mkdir(join(repoDir, ".cc", "workflow"), { recursive: true });
    await writeFile(
      join(repoDir, ".cc", "workflow", "pre-merge.log"),
      "validation output\n",
    );
    await mkdir(join(repoDir, "dist"), { recursive: true });
    await writeFile(join(repoDir, "dist", "bundle.js"), "built\n");

    expect(await computeCandidateTreeHash(repoDir)).toBe(baseline);
  });

  it("moves when tracked content changes, even for an already-modified file", async () => {
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\ngamma\n");
    const first = await computeCandidateTreeHash(repoDir);

    // The diff cache's token (HEAD + porcelain hash) cannot see this edit — an
    // already-modified file stays " M". The candidate identity must, or a round
    // would certify a tree that changed under it.
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\nGAMMA\n");
    expect(await computeCandidateTreeHash(repoDir)).not.toBe(first);
  });

  it("returns null for a directory that is not a git repository", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "cc-tree-hash-plain-"));
    try {
      expect(await computeCandidateTreeHash(plainDir)).toBeNull();
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});

describe("computeCandidateSnapshot (real repo)", () => {
  let repoDir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoDir = await mkdtemp(join(tmpdir(), "cc-candidate-snapshot-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await writeFile(join(repoDir, "a.txt"), "alpha\nbeta\ngamma\n");
    await git("add", "-A");
    await git("commit", "-m", "baseline");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("returns the tree hash and the diff of one and the same temporary index", async () => {
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\ngamma\n");
    await writeFile(join(repoDir, "new.txt"), "fresh\n");

    const snapshot = await computeCandidateSnapshot(repoDir);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.treeHash).toBe(await computeCandidateTreeHash(repoDir));
    expect(snapshot!.diff.files.map((file) => file.filePath).sort()).toEqual([
      "a.txt",
      "new.txt",
    ]);
  });

  it("re-reads content the diff cache cannot see, so the patch is never older than the tree", async () => {
    // The regression this closes: `computeDiff`'s token is HEAD plus a porcelain
    // hash, and a content-only edit to an ALREADY-modified file leaves porcelain
    // at " M a.txt". A round that froze the new tree hash while validators read
    // the cached old patch would certify a tree nobody reviewed.
    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\ngamma\n");
    const cached = await computeDiff(repoDir);
    expect(
      cached.files[0]!.hunks[0]!.lines.some(
        (line) => line.type === "add" && line.content === "BETA",
      ),
    ).toBe(true);

    await writeFile(join(repoDir, "a.txt"), "alpha\nBETA\nGAMMA\n");

    // computeDiff is still serving the stale patch — the porcelain token did
    // not move — which is exactly why the round must not read through it.
    expect(await computeDiff(repoDir)).toBe(cached);

    const snapshot = await computeCandidateSnapshot(repoDir);
    expect(snapshot!.treeHash).toBe(await computeCandidateTreeHash(repoDir));
    expect(
      snapshot!.diff.files[0]!.hunks[0]!.lines.some(
        (line) => line.type === "add" && line.content === "GAMMA",
      ),
    ).toBe(true);
  });

  it("returns null when git state cannot be resolved", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "cc-candidate-plain-"));
    try {
      expect(await computeCandidateSnapshot(plainDir)).toBeNull();
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});

describe("owned-subset candidate scope (real repo)", () => {
  let repoDir: string;

  /** Context A owns `a/`; sibling context B owns `b/` on the same lane. */
  const scopeA: CandidateScope = { mode: "owned", ownedPaths: ["a"] };
  const readOnlyScope: CandidateScope = { mode: "owned", ownedPaths: [] };

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoDir,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoDir = await mkdtemp(join(tmpdir(), "cc-owned-scope-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "core.fileMode", "true");
    await mkdir(join(repoDir, "a"), { recursive: true });
    await mkdir(join(repoDir, "b"), { recursive: true });
    await writeFile(join(repoDir, ".gitignore"), "dist/\n");
    await writeFile(join(repoDir, "a", "owned.txt"), "a-base\n");
    await writeFile(join(repoDir, "a", "doomed.txt"), "a-doomed\n");
    await writeFile(join(repoDir, "b", "sibling.txt"), "b-base\n");
    await writeFile(join(repoDir, "root.txt"), "root-base\n");
    await git("add", "-A");
    await git("commit", "-m", "baseline");
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("carries exactly the owned subset's patch while a sibling writes its own paths", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    await writeFile(join(repoDir, "a", "added.txt"), "a-new\n");
    await rm(join(repoDir, "a", "doomed.txt"));
    // Sibling B's concurrent, uncommitted writes — outside A's ownership.
    await writeFile(join(repoDir, "b", "sibling.txt"), "b-edited\n");
    await writeFile(join(repoDir, "root.txt"), "root-edited\n");

    const snapshot = await computeCandidateSnapshot(repoDir, scopeA);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.diff.files.map((file) => file.filePath).sort()).toEqual([
      "a/added.txt",
      "a/doomed.txt",
      "a/owned.txt",
    ]);
  });

  it("holds its identity across a sibling's dirty writes and landed commits", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    const frozen = await computeCandidateTreeHash(repoDir, scopeA);
    expect(frozen).not.toBeNull();

    // B keeps writing its own paths mid-round.
    await writeFile(join(repoDir, "b", "sibling.txt"), "b-edited\n");
    expect(await computeCandidateTreeHash(repoDir, scopeA)).toBe(frozen);

    // …and then B lands: HEAD moves under A's open round.
    await git("add", "b/sibling.txt");
    await git("commit", "-m", "sibling lands");
    expect(await computeCandidateTreeHash(repoDir, scopeA)).toBe(frozen);

    // The patch A's validators read is unmoved too.
    const snapshot = await computeCandidateSnapshot(repoDir, scopeA);
    expect(snapshot!.treeHash).toBe(frozen);
    expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
      "a/owned.txt",
    ]);
  });

  it("moves its identity for an owned content, mode, or deletion change", async () => {
    const baseline = await computeCandidateTreeHash(repoDir, scopeA);

    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    const afterContent = await computeCandidateTreeHash(repoDir, scopeA);
    expect(afterContent).not.toBe(baseline);

    await chmod(join(repoDir, "a", "owned.txt"), 0o755);
    const afterMode = await computeCandidateTreeHash(repoDir, scopeA);
    expect(afterMode).not.toBe(afterContent);

    await rm(join(repoDir, "a", "doomed.txt"));
    expect(await computeCandidateTreeHash(repoDir, scopeA)).not.toBe(afterMode);
  });

  it("reads an owned path literally, so a metacharacter never widens the subset", async () => {
    await writeFile(join(repoDir, "a", "st*ar.txt"), "star\n");
    await writeFile(join(repoDir, "a", "steer.txt"), "steer\n");
    await git("add", "-A");
    await git("commit", "-m", "glob-shaped names");

    await writeFile(join(repoDir, "a", "st*ar.txt"), "star-edited\n");
    await writeFile(join(repoDir, "a", "steer.txt"), "steer-edited\n");

    const snapshot = await computeCandidateSnapshot(repoDir, {
      mode: "owned",
      ownedPaths: ["a/st*ar.txt"],
    });

    // A pathspec passed unescaped would glob `a/steer.txt` into the subset.
    expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
      "a/st*ar.txt",
    ]);
  });

  it("tolerates an owned path that exists in neither HEAD nor the worktree", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");

    const snapshot = await computeCandidateSnapshot(repoDir, {
      mode: "owned",
      ownedPaths: ["a", "src/not-created-yet"],
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
      "a/owned.txt",
    ]);
    // The status probe has to tolerate it too, or a context that has not created
    // an owned path yet would read as an unavailable candidate.
    expect(
      await hasCandidateScopeChanges(repoDir, {
        mode: "owned",
        ownedPaths: ["a", "src/not-created-yet"],
      }),
    ).toBe(true);
  });

  it("gives a read-only context an empty patch and a stable identity in a dirty worktree", async () => {
    await writeFile(join(repoDir, "b", "sibling.txt"), "b-edited\n");
    const frozen = await computeCandidateTreeHash(repoDir, readOnlyScope);
    expect(frozen).not.toBeNull();

    await writeFile(join(repoDir, "root.txt"), "root-edited\n");
    const snapshot = await computeCandidateSnapshot(repoDir, readOnlyScope);

    expect(snapshot!.treeHash).toBe(frozen);
    expect(snapshot!.diff.files).toEqual([]);
  });

  /**
   * A sibling path git refuses to index — here an untracked nested repository
   * with no commit, which is deterministic and needs no special permissions.
   * It stands in for the whole family the shared worktree exposes A to: a file
   * replaced, truncated, removed, or created unreadable while a command is
   * scanning the sibling's paths.
   */
  async function makeSiblingUnindexable(): Promise<void> {
    const nested = join(repoDir, "b", "nested");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init", "-q"], {
      cwd: nested,
      env: buildChildEnv(),
    });
    await writeFile(join(nested, "x.txt"), "nested\n");
  }

  it("builds the owned candidate without indexing sibling paths, so a sibling git cannot index does not fail A", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    await makeSiblingUnindexable();

    // Staging the whole shared worktree is the reading that cannot survive it:
    // git aborts the add, and A's freeze would collapse into an unresolvable
    // candidate over work A does not own.
    expect(await computeCandidateSnapshot(repoDir)).toBeNull();

    const snapshot = await computeCandidateSnapshot(repoDir, scopeA);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
      "a/owned.txt",
    ]);
    expect(snapshot!.treeHash).toBe(
      await computeCandidateTreeHash(repoDir, scopeA),
    );
  });

  it("gives a read-only context a candidate however unindexable the shared worktree is", async () => {
    await makeSiblingUnindexable();

    const snapshot = await computeCandidateSnapshot(repoDir, readOnlyScope);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.diff.files).toEqual([]);
    expect(snapshot!.treeHash).toBe(
      await computeCandidateTreeHash(repoDir, readOnlyScope),
    );
  });

  it("stages only the owned pathspecs, never the whole shared worktree", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    const commands: string[][] = [];
    const recording: ComputeDiffDeps = {
      gitClient: {
        git: (args, cwd, options) => {
          commands.push(args);
          return defaultGitClient.git(args, cwd, options);
        },
      },
      unlink: fsUnlink,
    };

    const snapshot = await computeCandidateSnapshot(repoDir, scopeA, recording);

    expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
      "a/owned.txt",
    ]);
    // The mechanical guarantee behind the test above: no command in the sequence
    // reads a path outside the subset, so no sibling state can decide whether
    // A's candidate resolves.
    expect(commands.filter((args) => args[0] === "add")).toEqual([
      ["add", "-A", "--", ":(literal)a"],
    ]);
  });

  it("holds A's identity while a sibling churns its own paths throughout snapshot construction", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
    const frozen = await computeCandidateTreeHash(repoDir, scopeA);
    expect(frozen).not.toBeNull();

    // B's writes OVERLAP A's reads rather than merely preceding them: files in
    // B's ownership appear, change, and vanish while A's snapshot is built.
    let churning = true;
    const churn = (async () => {
      for (let round = 0; churning; round++) {
        const transient = join(repoDir, "b", `churn-${round % 8}.txt`);
        await writeFile(transient, `b-${round}\n`);
        await writeFile(join(repoDir, "b", "sibling.txt"), `b-${round}\n`);
        await rm(transient, { force: true });
      }
    })();

    try {
      for (let read = 0; read < 12; read++) {
        const snapshot = await computeCandidateSnapshot(repoDir, scopeA);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.treeHash).toBe(frozen);
        expect(snapshot!.diff.files.map((file) => file.filePath)).toEqual([
          "a/owned.txt",
        ]);
      }
    } finally {
      churning = false;
      await churn;
    }
  });

  it("never collides with the whole-tree identity of the same worktree", async () => {
    await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");

    const scoped = await computeCandidateTreeHash(repoDir, scopeA);
    const wholeTree = await computeCandidateTreeHash(repoDir);

    expect(scoped).not.toBe(wholeTree);
    // The whole-tree form is still a git tree object; the scoped one is not, so
    // the two can never be compared into a false match.
    await git("add", "-A");
    expect(wholeTree).toBe((await git("write-tree")).trim());
    expect(scoped).not.toBe((await git("write-tree")).trim());
  });

  it("returns null for a scoped read of a directory that is not a git repository", async () => {
    const plainDir = await mkdtemp(join(tmpdir(), "cc-owned-scope-plain-"));
    try {
      expect(await computeCandidateTreeHash(plainDir, scopeA)).toBeNull();
      expect(await computeCandidateSnapshot(plainDir, scopeA)).toBeNull();
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  describe("hasCandidateScopeChanges", () => {
    it("ignores dirt outside the owned subset", async () => {
      await writeFile(join(repoDir, "b", "sibling.txt"), "b-edited\n");
      await writeFile(join(repoDir, "root.txt"), "root-edited\n");

      expect(await hasCandidateScopeChanges(repoDir, scopeA)).toBe(false);
      expect(await hasCandidateScopeChanges(repoDir)).toBe(true);
    });

    it("reports an owned modification, addition, or deletion", async () => {
      await writeFile(join(repoDir, "a", "owned.txt"), "a-edited\n");
      expect(await hasCandidateScopeChanges(repoDir, scopeA)).toBe(true);

      await git("stash", "--include-untracked");
      expect(await hasCandidateScopeChanges(repoDir, scopeA)).toBe(false);

      await writeFile(join(repoDir, "a", "added.txt"), "a-new\n");
      expect(await hasCandidateScopeChanges(repoDir, scopeA)).toBe(true);
    });

    it("reports a read-only context as clean however dirty the worktree is", async () => {
      await writeFile(join(repoDir, "b", "sibling.txt"), "b-edited\n");

      expect(await hasCandidateScopeChanges(repoDir, readOnlyScope)).toBe(
        false,
      );
    });

    it("throws when git itself cannot answer", async () => {
      const plainDir = await mkdtemp(join(tmpdir(), "cc-owned-scope-status-"));
      try {
        await expect(
          hasCandidateScopeChanges(plainDir, scopeA),
        ).rejects.toThrow();
      } finally {
        await rm(plainDir, { recursive: true, force: true });
      }
    });
  });
});
