import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDiff, computeDiff } from "./diff";

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

  // ==========================================================================
  // 4.1 – parseDiff edge cases (Req 2.6, 2.7, 3.4)
  // ==========================================================================

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
// 4.2 – computeDiff integration (Req 1.1, 1.2, 1.4, 1.5)
// ===========================================================================

const { execFileMock, unlinkMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  unlink: unlinkMock,
}));

/** Make execFileMock resolve in sequence for successive calls */
function mockExecSequence(results: Array<{ error?: Error; stdout?: string }>) {
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
      if (!cb) return;
      const r = results[callIndex] ?? results[results.length - 1]!;
      callIndex++;
      if (r.error) {
        cb(r.error, { stdout: "", stderr: "" });
      } else {
        cb(null, { stdout: r.stdout ?? "", stderr: "" });
      }
    },
  );
}

describe("computeDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlinkMock.mockResolvedValue(undefined);
  });

  it("uses temp index to diff working tree against HEAD (Req 1.1, 1.2)", async () => {
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
index abc..def 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 line1
+new line
 line2`;

    mockExecSequence([
      // 0: git read-tree HEAD
      { stdout: "" },
      // 1: git add -A
      { stdout: "" },
      // 2: git diff --cached HEAD --unified=3
      { stdout: diffOutput },
    ]);

    const result = await computeDiff("/projects/repo/.worktrees/test");

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.filePath).toBe("src/app.ts");
    expect(result.totalAdditions).toBe(1);

    // Verify read-tree seeds the temp index from HEAD
    expect(execFileMock.mock.calls[0]![1]).toEqual(["read-tree", "HEAD"]);

    // Verify add -A stages everything into temp index
    expect(execFileMock.mock.calls[1]![1]).toEqual(["add", "-A"]);

    // Verify diff --cached against HEAD
    expect(execFileMock.mock.calls[2]![1]).toEqual([
      "diff",
      "--cached",
      "HEAD",
      "--unified=3",
    ]);

    // Verify temp index env is set for all calls
    for (const i of [0, 1, 2]) {
      const opts = execFileMock.mock.calls[i]![2] as {
        env: Record<string, string>;
      };
      expect(opts.env.GIT_INDEX_FILE).toMatch(/cc-diff-/);
    }

    // Verify temp index cleanup
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff on read-tree failure (Req 1.5)", async () => {
    mockExecSequence([{ error: new Error("git failed") }]);

    const result = await computeDiff("/projects/repo/.worktrees/test");
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
    expect(result.totalDeletions).toBe(0);

    // Temp index cleanup still called
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty diff for empty git diff output (Req 1.6)", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

    const result = await computeDiff("/projects/repo/.worktrees/test");
    expect(result.files).toHaveLength(0);
    expect(result.totalAdditions).toBe(0);
  });
});
