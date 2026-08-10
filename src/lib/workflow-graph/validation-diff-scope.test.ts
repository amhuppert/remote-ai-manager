import { mkdir, mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateScopeForPlacement,
  computeValidationDiffScope,
  renderDiffScopeSection,
  type ValidationDiffScope,
  type ValidationDiffScopeDeps,
} from "./validation-diff-scope";
import {
  computeCandidateTreeHash,
  _resetDiffCacheForTesting,
  WHOLE_TREE_CANDIDATE_SCOPE,
  type CandidateScope,
} from "@/lib/git/diff";
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
  it("returns available with totals and the tree the patch was read from", async () => {
    const diff = sessionDiff([
      fileDiff("src/a.ts", ["const a = 1;"]),
      fileDiff("src/b.ts", ["const b = 2;"], ["const old = 0;"]),
    ]);
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeCandidateSnapshot: vi.fn(async () => ({
        treeHash: "tree-1",
        diff,
      })),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");
    expect(scope.fileCount).toBe(2);
    expect(scope.totalAdditions).toBe(2);
    expect(scope.totalDeletions).toBe(1);
    expect(scope.diff).toBe(diff);
    // The identity of what was rendered travels with the rendering, so a round
    // can prove its reviewers read the tree it froze.
    expect(scope.treeHash).toBe("tree-1");
  });

  it("returns empty carrying the clean tree's identity", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => false),
      computeCandidateSnapshot: vi.fn(async () => ({
        treeHash: "tree-clean",
        diff: sessionDiff([]),
      })),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("empty");
    if (scope.kind !== "empty") throw new Error("expected empty");
    expect(scope.treeHash).toBe("tree-clean");
  });

  it("returns unavailable when the tree is dirty but the diff comes back empty (degraded)", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeCandidateSnapshot: vi.fn(async () => ({
        treeHash: "tree-1",
        diff: sessionDiff([]),
      })),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason.length).toBeGreaterThan(0);
  });

  it("returns unavailable when the status probe throws", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => {
        throw new Error("not a git repository");
      }),
      computeCandidateSnapshot: vi.fn(async () => null),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason).toContain("not a git repository");
  });

  it("returns unavailable when the candidate snapshot cannot be read", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeCandidateSnapshot: vi.fn(async () => null),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason.length).toBeGreaterThan(0);
  });

  it("returns unavailable when reading the candidate throws", async () => {
    const deps: ValidationDiffScopeDeps = {
      hasUncommittedChanges: vi.fn(async () => true),
      computeCandidateSnapshot: vi.fn(async () => {
        throw new Error("diff boom");
      }),
    };

    const scope = await computeValidationDiffScope(
      "/wt",
      WHOLE_TREE_CANDIDATE_SCOPE,
      deps,
    );

    expect(scope.kind).toBe("unavailable");
    if (scope.kind !== "unavailable") throw new Error("expected unavailable");
    expect(scope.reason).toContain("diff boom");
  });
});

describe("renderDiffScopeSection", () => {
  it("renders the diffstat, instructions, and a fenced patch for an available scope", () => {
    const scope: ValidationDiffScope = {
      kind: "available",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      treeHash: "tree-1",
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
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      treeHash: "tree-1",
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
    const rendered = renderDiffScopeSection({
      kind: "empty",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
      treeHash: "tree-clean",
    });

    expect(rendered.truncated).toBe(false);
    expect(rendered.includedFileCount).toBe(0);
    expect(rendered.section).toContain("## Changes Under Review");
    expect(rendered.section.toLowerCase()).toContain("no file changes");
  });

  it("renders an explicit unavailable note carrying the reason", () => {
    const rendered = renderDiffScopeSection({
      kind: "unavailable",
      candidateScope: WHOLE_TREE_CANDIDATE_SCOPE,
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

  it("reports the tree hash a round freezes on, for the very patch it renders", async () => {
    await writeFile(
      join(repoPath, "tracked.ts"),
      "export const a = 1;\nexport const b = 2;\n",
    );

    const scope = await computeValidationDiffScope(repoPath);

    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");
    expect(scope.treeHash).toBe(await computeCandidateTreeHash(repoPath));
  });

  it("never renders a patch older than the tree it reports", async () => {
    // A content-only edit to an already-modified file leaves `git status
    // --porcelain` at " M tracked.ts", so the shared diff cache keeps serving
    // the first patch. A validation round certifies a tree hash on the strength
    // of what its reviewers read, so the scope must not read through that cache.
    await writeFile(
      join(repoPath, "tracked.ts"),
      "export const a = 1;\nexport const FIRST = 2;\n",
    );
    const first = await computeValidationDiffScope(repoPath);
    expect(renderDiffScopeSection(first).section).toContain(
      "+export const FIRST = 2;",
    );

    await writeFile(
      join(repoPath, "tracked.ts"),
      "export const a = 1;\nexport const SECOND = 2;\n",
    );

    const second = await computeValidationDiffScope(repoPath);

    expect(second.kind).toBe("available");
    if (second.kind !== "available") throw new Error("expected available");
    expect(second.treeHash).toBe(await computeCandidateTreeHash(repoPath));
    const rendered = renderDiffScopeSection(second).section;
    expect(rendered).toContain("+export const SECOND = 2;");
    expect(rendered).not.toContain("+export const FIRST = 2;");
  });
});

describe("candidateScopeForPlacement", () => {
  it("keeps whole-tree semantics for a full-access member", () => {
    expect(
      candidateScopeForPlacement({ lane: "impl", mode: "full" }),
    ).toEqual<CandidateScope>({ mode: "wholeTree" });
  });

  it("scopes an owning member to its declared paths", () => {
    expect(
      candidateScopeForPlacement({
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/a", "src/b.ts"],
      }),
    ).toEqual<CandidateScope>({
      mode: "owned",
      ownedPaths: ["src/a", "src/b.ts"],
    });
  });

  it("scopes a read-only member to nothing at all", () => {
    // Not whole-tree: a read-only context shares the session worktree with
    // everything else running there, so the whole-tree delta is other contexts'
    // work, never its own.
    expect(
      candidateScopeForPlacement({ lane: "session", mode: "readOnly" }),
    ).toEqual<CandidateScope>({ mode: "owned", ownedPaths: [] });
  });

  it("falls back to whole-tree for a context seeded before placement existed", () => {
    expect(candidateScopeForPlacement(undefined)).toEqual<CandidateScope>({
      mode: "wholeTree",
    });
  });
});

describe("computeValidationDiffScope scoped to ownership (real repo)", () => {
  let repoPath: string;
  const scopeA: CandidateScope = { mode: "owned", ownedPaths: ["a"] };

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildChildEnv(),
    });
    return stdout;
  }

  beforeEach(async () => {
    _resetDiffCacheForTesting();
    repoPath = await mkdtemp(join(tmpdir(), "cc-scoped-validation-"));
    await git("init");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await mkdir(join(repoPath, "a"), { recursive: true });
    await mkdir(join(repoPath, "b"), { recursive: true });
    await writeFile(join(repoPath, "a", "owned.ts"), "export const a = 1;\n");
    await writeFile(join(repoPath, "b", "sibling.ts"), "export const b = 1;\n");
    await git("add", "-A");
    await git("commit", "-m", "baseline");
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it("shows only the owned patch and holds its identity while a sibling writes and lands", async () => {
    await writeFile(join(repoPath, "a", "owned.ts"), "export const a = 2;\n");
    await writeFile(join(repoPath, "b", "sibling.ts"), "export const b = 2;\n");

    const scope = await computeValidationDiffScope(repoPath, scopeA);
    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");
    expect(scope.diff.files.map((file) => file.filePath)).toEqual([
      "a/owned.ts",
    ]);
    expect(scope.fileCount).toBe(1);

    const rendered = renderDiffScopeSection(scope).section;
    expect(rendered).toContain("+export const a = 2;");
    expect(rendered).not.toContain("+export const b = 2;");
    // The validator is told the diff is ownership-scoped and which paths it
    // covers, so it cannot read a sibling's absent work as this context's
    // omission.
    expect(rendered).toContain("owned paths");
    expect(rendered).toContain("- a");

    // B lands mid-round: HEAD moves, A's frozen identity does not.
    await git("add", "b/sibling.ts");
    await git("commit", "-m", "sibling lands");
    const reread = await computeValidationDiffScope(repoPath, scopeA);
    expect(reread.kind).toBe("available");
    expect(scope.treeHash).toBe(
      await computeCandidateTreeHash(repoPath, scopeA),
    );
    if (reread.kind !== "available") throw new Error("expected available");
    expect(reread.treeHash).toBe(scope.treeHash);
  });

  it("reports an untouched owned subset as empty even when siblings are dirty", async () => {
    await writeFile(join(repoPath, "b", "sibling.ts"), "export const b = 2;\n");

    const scope = await computeValidationDiffScope(repoPath, scopeA);

    // Unscoped, the porcelain probe would call this dirty and then find no
    // owned patch to show — reported as a degraded read rather than a no-op.
    expect(scope.kind).toBe("empty");
    if (scope.kind !== "empty") throw new Error("expected empty");
    expect(scope.treeHash).toBe(
      await computeCandidateTreeHash(repoPath, scopeA),
    );
  });

  it("keeps the whole-tree diff for a full-access member of the same worktree", async () => {
    await writeFile(join(repoPath, "a", "owned.ts"), "export const a = 2;\n");
    await writeFile(join(repoPath, "b", "sibling.ts"), "export const b = 2;\n");

    const scope = await computeValidationDiffScope(
      repoPath,
      candidateScopeForPlacement({ lane: "impl", mode: "full" }),
    );

    expect(scope.kind).toBe("available");
    if (scope.kind !== "available") throw new Error("expected available");
    expect(scope.diff.files.map((file) => file.filePath).sort()).toEqual([
      "a/owned.ts",
      "b/sibling.ts",
    ]);
    expect(scope.treeHash).toBe(await computeCandidateTreeHash(repoPath));
  });
});
