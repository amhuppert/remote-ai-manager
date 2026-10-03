import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import type { WorkspaceScope } from "./schemas";

/**
 * Content identity of a workspace scope. Evidence identifies content, not a
 * diff against HEAD, so an owner's commit of unchanged files leaves it equal.
 * Format: `git:<tree>:<scope digest>`; equality compares the digest only.
 */
export interface WorkspaceEvidence {
  capture(worktreePath: string, scope: WorkspaceScope): Promise<string>;
  sameContent(a: string, b: string): boolean;
  /** Repo-relative paths in the scope whose content differs between two captures. */
  changedPaths(
    worktreePath: string,
    scope: WorkspaceScope,
    from: string,
    to: string,
  ): Promise<string[]>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function parse(evidence: string): { tree: string; digest: string } {
  const [prefix, tree, digest] = evidence.split(":");
  if (prefix !== "git" || tree === undefined || digest === undefined) {
    throw new Error(`Unrecognized workspace evidence: ${evidence}`);
  }
  return { tree, digest };
}

function scopePaths(scope: WorkspaceScope): string[] {
  return scope.mode === "owned" ? scope.paths : [];
}

export function createWorkspaceEvidence(
  client: GitClient = defaultGitClient,
): WorkspaceEvidence {
  async function git(
    cwd: string,
    args: string[],
    indexFile?: string,
  ): Promise<string> {
    const { stdout } = await client.git(args, cwd, {
      maxBuffer: MAX_BUFFER,
      ...(indexFile === undefined
        ? {}
        : { env: { GIT_INDEX_FILE: indexFile } }),
    });
    return stdout;
  }

  async function seedIndex(
    worktreePath: string,
    indexFile: string,
  ): Promise<void> {
    // Starting from the worktree's own index reuses its stat cache, so only
    // changed files are rehashed; `add -A` then matches the working tree.
    const realIndex = path.resolve(
      worktreePath,
      (await git(worktreePath, ["rev-parse", "--git-path", "index"])).trim(),
    );
    let copied = true;
    try {
      await copyFile(realIndex, indexFile);
    } catch {
      copied = false;
      await git(worktreePath, ["read-tree", "--empty"], indexFile);
    }
    if (!copied) return;
    // Git rehashes entries whose stat is as new as the index file itself (its
    // racy-entry check). A fresh copy would look newer than every entry, so a
    // same-size edit made in the second the index was written would pass as
    // clean; the copy keeps the original timestamps to preserve that check.
    const { atime, mtime } = await stat(realIndex);
    await utimes(indexFile, atime, mtime);
  }

  return {
    async capture(worktreePath, scope) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cc-evidence-"));
      const indexFile = path.join(dir, "index");
      try {
        await seedIndex(worktreePath, indexFile);
        await git(worktreePath, ["add", "-A", "--", "."], indexFile);
        const tree = (
          await git(worktreePath, ["write-tree"], indexFile)
        ).trim();
        const paths = scopePaths(scope);
        if (paths.length === 0) return `git:${tree}:${tree}`;
        const listing = await git(worktreePath, [
          "ls-tree",
          "-r",
          tree,
          "--",
          ...paths,
        ]);
        const digest = createHash("sha256").update(listing).digest("hex");
        return `git:${tree}:${digest}`;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    sameContent(a, b) {
      return parse(a).digest === parse(b).digest;
    },
    async changedPaths(worktreePath, scope, from, to) {
      const output = await git(worktreePath, [
        "diff-tree",
        "-r",
        "--name-only",
        "--no-renames",
        parse(from).tree,
        parse(to).tree,
        "--",
        ...scopePaths(scope),
      ]);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .sort();
    },
  };
}
