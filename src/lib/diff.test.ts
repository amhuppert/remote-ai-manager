import { describe, it, expect, vi } from "vitest";
import { parseDiff, computeDiff } from "./diff";
import type { ComputeDiffDeps } from "./diff";

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
  mockExec: ReturnType<typeof vi.fn>;
  mockUnlink: ReturnType<typeof vi.fn>;
} {
  const mockExec = vi.fn();
  const mockUnlink = vi.fn().mockResolvedValue(undefined);
  return {
    deps: { execFileAsync: mockExec, unlink: mockUnlink },
    mockExec,
    mockUnlink,
  };
}

describe("computeDiff", () => {
  it("uses temp index to diff working tree against HEAD", async () => {
    const { deps, mockExec, mockUnlink } = createMockDeps();
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
index abc..def 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 line1
+new line
 line2`;

    // 0: git read-tree HEAD, 1: git add -A, 2: git diff
    mockExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: diffOutput, stderr: "" });

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

    // Verify temp index env is set for all git calls
    for (const call of mockExec.mock.calls) {
      const opts = call[2] as { env: Record<string, string> };
      expect(opts.env.GIT_INDEX_FILE).toMatch(/cc-diff-/);
    }

    // Verify temp index cleanup
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff on read-tree failure", async () => {
    const { deps, mockExec, mockUnlink } = createMockDeps();
    mockExec.mockRejectedValueOnce(new Error("git failed"));

    const result = await computeDiff("/projects/repo/.worktrees/test", deps);
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);

    // Temp index cleanup still called
    expect(mockUnlink).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff for empty git diff output", async () => {
    const { deps, mockExec } = createMockDeps();
    mockExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await computeDiff("/projects/repo/.worktrees/test", deps);
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
  });
});
