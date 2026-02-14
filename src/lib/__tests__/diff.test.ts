import { describe, it, expect } from "vitest";
import { parseDiff } from "../diff";

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
});
