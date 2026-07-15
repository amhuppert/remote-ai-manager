import { mkdtemp, rm, writeFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDiff, computeDiff, _resetDiffCacheForTesting } from "./diff";
import type { ComputeDiffDeps } from "./diff";
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
