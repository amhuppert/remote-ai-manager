import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeValidationDiffScope,
  renderDiffScopeSection,
  type ValidationDiffScope,
  type ValidationDiffScopeDeps,
} from "./validation-diff-scope";
import { _resetDiffCacheForTesting } from "@/lib/git/diff";
import { buildChildEnv } from "@/lib/shared/child-env";
import type { FileDiff, SessionDiff } from "@/lib/git/schemas";

const execFileAsync = promisify(execFile);

function fileDiff(
  filePath: string,
  addedLines: string[],
  removedLines: string[] = [],
): FileDiff {
  return {
    filePath,
    additions: addedLines.length,
    deletions: removedLines.length,
    hunks: [
      {
        header: `@@ -1,${removedLines.length} +1,${addedLines.length} @@`,
        lines: [
          {
            type: "hunk-header",
            content: `@@ -1,${removedLines.length} +1,${addedLines.length} @@`,
          },
          ...removedLines.map((content) => ({
            type: "remove" as const,
            content,
          })),
          ...addedLines.map((content) => ({ type: "add" as const, content })),
        ],
      },
    ],
  };
}

function sessionDiff(files: FileDiff[]): SessionDiff {
  return {
    files,
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

describe("computeValidationDiffScope", () => {
  it("returns available with totals when the tree is dirty and the diff is non-empty", async () => {
    const diff = sessionDiff([
      fileDiff("src/a.ts", ["const a = 1;"]),
      fileDiff("src/b.ts", ["const b = 2;"], ["const old = 0;"]),
    ]);
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeDiff: vi.fn(async () => diff),
    };

    const scope = await computeValidationDiffScope("/wt", deps);

    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");
    expect(scope.fileCount).toBe(2);
    expect(scope.totalAdditions).toBe(2);
    expect(scope.totalDeletions).toBe(1);
    expect(scope.diff).toBe(diff);
  });

  it("returns empty without computing a diff when the tree is clean", async () => {
    const computeDiff = vi.fn(async () => sessionDiff([]));
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => false),
      computeDiff,
    };

    const scope = await computeValidationDiffScope("/wt", deps);

    expect(scope.kind).toBe("empty");
    expect(computeDiff).not.toHaveBeenCalled();
  });

  it("returns unavailable when the tree is dirty but the diff comes back empty (degraded)", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeDiff: vi.fn(async () => sessionDiff([])),
    };

    const scope = await computeValidationDiffScope("/wt", deps);

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason.length).toBeGreaterThan(0);
  });

  it("returns unavailable when the status probe throws", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => {
        throw new Error("not a git repository");
      }),
      computeDiff: vi.fn(async () => sessionDiff([])),
    };

    const scope = await computeValidationDiffScope("/wt", deps);

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason).toContain("not a git repository");
  });

  it("returns unavailable when computeDiff throws", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeDiff: vi.fn(async () => {
        throw new Error("diff boom");
      }),
    };

    const scope = await computeValidationDiffScope("/wt", deps);

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason).toContain("diff boom");
  });
});

describe("renderDiffScopeSection", () => {
  it("renders the diffstat, instructions, and a fenced patch for an available scope", () => {
    const scope: ValidationDiffScope = {
      kind: "available",
      diff: sessionDiff([
        fileDiff("src/a.ts", ["const a = 1;"], ["const a = 0;"]),
      ]),
      fileCount: 1,
      totalAdditions: 1,
      totalDeletions: 1,
    };

    const rendered = renderDiffScopeSection(scope);

    expect(rendered.truncated).toBe(false);
    expect(rendered.includedFileCount).toBe(1);
    expect(rendered.omittedFileCount).toBe(0);
    expect(rendered.section).toContain("## Changes Under Review");
    expect(rendered.section).toContain("src/a.ts (+1 -1)");
    expect(rendered.section).toContain("Files changed: 1 (+1 -1 total)");
    expect(rendered.section).toContain("```diff");
    expect(rendered.section).toContain("+const a = 1;");
    expect(rendered.section).toContain("-const a = 0;");
    // "diff first, not diff only" guidance is present.
    expect(rendered.section.toLowerCase()).toContain("changed files first");
  });

  it("always lists every file in the diffstat but truncates patch bodies past the budget", () => {
    const big = Array.from(
      { length: 50 },
      (_, i) => `line ${i} ${"x".repeat(40)}`,
    );
    const scope: ValidationDiffScope = {
      kind: "available",
      diff: sessionDiff([
        fileDiff("src/first.ts", big),
        fileDiff("src/second.ts", big),
        fileDiff("src/third.ts", big),
      ]),
      fileCount: 3,
      totalAdditions: 150,
      totalDeletions: 0,
    };

    // Tiny budget: floor(10 * 4 * 0.25) = 10 bytes — forces truncation after file 1.
    const rendered = renderDiffScopeSection(scope, { contextLimitTokens: 10 });

    expect(rendered.truncated).toBe(true);
    expect(rendered.includedFileCount).toBe(1);
    expect(rendered.omittedFileCount).toBe(2);
    // Full diffstat still names every file.
    expect(rendered.section).toContain("src/first.ts");
    expect(rendered.section).toContain("src/second.ts");
    expect(rendered.section).toContain("src/third.ts");
    // Truncation disclosure names the omitted files and tells the validator to read them.
    expect(rendered.section.toLowerCase()).toContain("truncat");
    expect(rendered.section).toContain("- src/second.ts");
    expect(rendered.section).toContain("- src/third.ts");
  });

  it("renders a no-changes message for an empty scope", () => {
    const rendered = renderDiffScopeSection({ kind: "empty" });

    expect(rendered.truncated).toBe(false);
    expect(rendered.includedFileCount).toBe(0);
    expect(rendered.section).toContain("## Changes Under Review");
    expect(rendered.section.toLowerCase()).toContain("no file changes");
  });

  it("renders an explicit unavailable note carrying the reason", () => {
    const rendered = renderDiffScopeSection({
      kind: "unavailable",
      reason: "status probe failed: boom",
    });

    expect(rendered.truncated).toBe(false);
    expect(rendered.section).toContain("## Changes Under Review");
    expect(rendered.section.toLowerCase()).toContain("unavailable");
    expect(rendered.section).toContain("status probe failed: boom");
  });
});

describe("computeValidationDiffScope (real git repo)", () => {
  let repoPath: string;

  async function gitIn(args: string[]): Promise<void> {
    // Sanitized child env (matching the production GitClient) so an inherited
    // GIT_DIR / GIT_INDEX_FILE cannot redirect these mutations at the real repo.
    await execFileAsync("git", args, { cwd: repoPath, env: buildChildEnv() });
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoPath = await mkdtemp(join(tmpdir(), "cc-diff-scope-"));
    await gitIn(["init"]);
    await gitIn(["config", "user.email", "test@example.com"]);
    await gitIn(["config", "user.name", "Test"]);
    await writeFile(join(repoPath, "tracked.ts"), "export const a = 1;\n");
    await writeFile(join(repoPath, "todelete.ts"), "export const gone = 1;\n");
    await writeFile(join(repoPath, "torename.ts"), "export const moved = 1;\n");
    await gitIn(["add", "-A"]);
    await gitIn(["commit", "-m", "initial", "--no-verify"]);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("returns empty for a clean worktree", async () => {
    const scope = await computeValidationDiffScope(repoPath);
    expect(scope.kind).toBe("empty");
  });

  it("captures modified, deleted, renamed, and untracked changes against HEAD", async () => {
    // Modify a tracked file.
    await writeFile(
      join(repoPath, "tracked.ts"),
      "export const a = 1;\nexport const b = 2;\n",
    );
    // Delete a tracked file.
    await rm(join(repoPath, "todelete.ts"));
    // Rename a tracked file.
    await rename(join(repoPath, "torename.ts"), join(repoPath, "renamed.ts"));
    // Add an untracked file (must be included via the temp-index path).
    await writeFile(join(repoPath, "newfile.ts"), "export const c = 3;\n");

    const scope = await computeValidationDiffScope(repoPath);

    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");

    const paths = scope.diff.files.map((file) => file.filePath);
    expect(paths).toContain("tracked.ts");
    expect(paths).toContain("todelete.ts");
    expect(paths).toContain("renamed.ts");
    expect(paths).toContain("newfile.ts");
    expect(scope.totalAdditions).toBeGreaterThan(0);
    expect(scope.totalDeletions).toBeGreaterThan(0);

    // The rendered section surfaces the new untracked file's content.
    const rendered = renderDiffScopeSection(scope);
    expect(rendered.section).toContain("+export const c = 3;");
  });
});
