import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface GitRepoTemplate {
  /**
   * An independent copy of the template repository in its own temporary
   * directory. The caller owns it; `dispose` removes any copy still present.
   */
  fresh(): Promise<string>;
  /** Removes the template and every copy not already removed. */
  dispose(): Promise<void>;
}

/**
 * Builds a repository once and hands each test a copy, so a `beforeEach` pays
 * one directory copy instead of the `git init`, `config`, `add`, and `commit`
 * spawns that built it. A copied repository is a full repository: git stores
 * no absolute paths in a plain (non-worktree) checkout, so the copy behaves
 * exactly as the template did, apart from file stat data the next command
 * refreshes.
 */
export async function createGitRepoTemplate(
  prefix: string,
  build: (repo: string) => Promise<void>,
): Promise<GitRepoTemplate> {
  const template = await mkdtemp(path.join(tmpdir(), `${prefix}template-`));
  await build(template);
  const copies = new Set<string>();
  return {
    async fresh() {
      const copy = await mkdtemp(path.join(tmpdir(), prefix));
      // Symlinks are copied as symlinks: a fixture may commit one, and a
      // dereferenced copy would commit its target's bytes instead.
      await cp(template, copy, { recursive: true, verbatimSymlinks: true });
      copies.add(copy);
      return copy;
    },
    async dispose() {
      await Promise.all(
        [template, ...copies].map((dir) =>
          rm(dir, { recursive: true, force: true }),
        ),
      );
      copies.clear();
    },
  };
}
