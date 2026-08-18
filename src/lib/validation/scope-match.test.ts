import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countMatchedScopePaths } from "./scope-match";

const worktrees: string[] = [];

function createWorktree(files: readonly string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "cc-scope-match-"));
  worktrees.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  return root;
}

afterEach(() => {
  while (worktrees.length > 0) {
    const root = worktrees.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("countMatchedScopePaths", () => {
  it("counts only the named paths that exist in the worktree", () => {
    const root = createWorktree(["src/a.test.ts", "src/b.test.ts"]);

    expect(
      countMatchedScopePaths(
        ["src/a.test.ts", "src/b.test.ts", "src/typo.test.ts"],
        root,
      ),
    ).toBe(2);
  });

  it("reports zero when every named path is missing", () => {
    const root = createWorktree(["src/a.test.ts"]);

    expect(countMatchedScopePaths(["src/typoo.test.ts"], root)).toBe(0);
  });

  it("reports zero for an empty path list", () => {
    const root = createWorktree(["src/a.test.ts"]);

    expect(countMatchedScopePaths([], root)).toBe(0);
  });

  it("counts a path named twice once", () => {
    const root = createWorktree(["src/a.test.ts"]);

    expect(
      countMatchedScopePaths(["src/a.test.ts", "./src/a.test.ts"], root),
    ).toBe(1);
  });

  it("resolves each path against the worktree, not the process cwd", () => {
    const root = createWorktree(["src/a.test.ts"]);
    const probed: string[] = [];

    const matched = countMatchedScopePaths(
      ["src/a.test.ts"],
      root,
      (target) => {
        probed.push(target);
        return true;
      },
    );

    expect(matched).toBe(1);
    expect(probed).toEqual([path.join(root, "src", "a.test.ts")]);
  });
});
