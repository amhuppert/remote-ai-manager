import { existsSync } from "node:fs";
import path from "node:path";

/**
 * How many of the paths a submission named actually exist in the target
 * worktree, counted once per distinct path.
 *
 * Containment is enforced upstream (`validatePathArgs`), and a missing path is
 * deliberately still forwarded so deleted or renamed files reach the wrapper
 * for tool-level handling. That tolerance is what makes a mistyped path narrow
 * a run to nothing while the wrapper still exits 0, so the count exists to make
 * that vacuous run visible rather than to refuse it.
 */
export function countMatchedScopePaths(
  scopePaths: readonly string[],
  worktreePath: string,
  pathExists: (absolutePath: string) => boolean = existsSync,
): number {
  const distinct = new Set(
    scopePaths.map((scopePath) => path.resolve(worktreePath, scopePath)),
  );
  let matched = 0;
  for (const absolutePath of distinct) {
    if (pathExists(absolutePath)) matched += 1;
  }
  return matched;
}
