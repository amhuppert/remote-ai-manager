import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { unlink as unlinkDefault } from "node:fs/promises";
import type { SessionDiff, FileDiff, DiffHunk, DiffLine } from "./schemas";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

const logger = createLogger("diff");

const MAX_BUFFER = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  DI for computeDiff                                                 */
/* ------------------------------------------------------------------ */

export interface ComputeDiffDeps {
  gitClient: GitClient;
  unlink(path: string): Promise<void>;
}

const defaultComputeDiffDeps: ComputeDiffDeps = {
  gitClient: defaultGitClient,
  unlink: unlinkDefault,
};

// Cache the parsed SessionDiff per worktree path, keyed on a cheap token built
// from `git rev-parse HEAD` + a hash of `git status --porcelain=v1 -z`. Polling
// clients hit /diff many times per minute; the read-tree/add-A/diff sequence is
// ~1.5s exclusive per call on large worktrees. When HEAD and the working tree
// porcelain are unchanged, the diff is by definition identical — return the
// cached object by reference so React Query short-circuits re-renders.
const DIFF_CACHE_MAX = 100;

interface DiffCacheEntry {
  token: string;
  diff: SessionDiff;
}

const diffCache = new Map<string, DiffCacheEntry>();

export function _resetDiffCacheForTesting(): void {
  diffCache.clear();
}

async function computeCacheToken(
  worktreePath: string,
  deps: ComputeDiffDeps,
): Promise<string | null> {
  try {
    const opts = { maxBuffer: MAX_BUFFER };
    const head = await deps.gitClient.git(
      ["rev-parse", "HEAD"],
      worktreePath,
      opts,
    );
    const status = await deps.gitClient.git(
      ["status", "--porcelain=v1", "-z"],
      worktreePath,
      opts,
    );
    const statusHash = createHash("sha1").update(status.stdout).digest("hex");
    return `${head.stdout.trim()}:${statusHash}`;
  } catch {
    return null;
  }
}

/**
 * Compute a git diff of uncommitted changes in the session worktree.
 * Uses a temporary index so that untracked files are included in the diff
 * without modifying the real index. Diffs the working tree against HEAD
 * so only truly uncommitted changes are shown.
 */
export async function computeDiff(
  worktreePath: string,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<SessionDiff> {
  return timed(
    logger,
    "diff.compute",
    { worktreePath },
    async () => {
      const token = await computeCacheToken(worktreePath, deps);
      if (token !== null) {
        const cached = diffCache.get(worktreePath);
        if (cached && cached.token === token) {
          return cached.diff;
        }
      }

      const diff = await computeDiffImpl(worktreePath, deps);

      if (token !== null) {
        if (diffCache.size >= DIFF_CACHE_MAX) {
          const firstKey = diffCache.keys().next().value;
          if (firstKey !== undefined) diffCache.delete(firstKey);
        }
        diffCache.set(worktreePath, { token, diff });
      }

      return diff;
    },
    (result) => ({ fileCount: result.files.length }),
  );
}

interface TemporaryIndexOpts {
  maxBuffer: number;
  env: { GIT_INDEX_FILE: string };
}

/**
 * Build the temporary index every reader of "the working tree as a candidate"
 * shares — seeded from the HEAD tree, then brought up to the working tree with
 * `add -A` — and hand it to `run` as the git options that address it.
 *
 * The real index is never touched, which is what lets a caller stage untracked
 * files without disturbing the session's own staging area. What `add -A` stages
 * is exactly what lands inside the resulting content: untracked files and file
 * modes are in, gitignored paths are out.
 *
 * Shared rather than duplicated so the diff a validator reads and the tree hash
 * a validation round freezes on cannot describe two different candidates.
 */
async function withTemporaryIndex<T>(
  worktreePath: string,
  deps: ComputeDiffDeps,
  run: (opts: TemporaryIndexOpts) => Promise<T>,
): Promise<T | null> {
  const tmpIndex = join(tmpdir(), `cc-diff-${randomUUID()}`);
  try {
    const tmpOpts: TemporaryIndexOpts = {
      maxBuffer: MAX_BUFFER,
      env: { GIT_INDEX_FILE: tmpIndex },
    };
    await deps.gitClient.git(["read-tree", "HEAD"], worktreePath, tmpOpts);
    await deps.gitClient.git(["add", "-A"], worktreePath, tmpOpts);
    return await run(tmpOpts);
  } catch {
    return null;
  } finally {
    await deps.unlink(tmpIndex).catch(() => {});
  }
}

/**
 * The git tree hash of the worktree's candidate content: the tree object
 * written from the same temporary index {@link computeDiff} builds.
 *
 * This is a content identity for "what a reviewer is looking at" — it moves for
 * any change the rendered diff would show, including a content-only edit to an
 * already-modified file, which the porcelain-based diff cache token cannot see.
 * For that reason it deliberately does not participate in that cache.
 *
 * Null when git state cannot be resolved (not a repository, no HEAD, git
 * failure): the caller decides what an unresolvable identity means rather than
 * receiving a fabricated one.
 */
export async function computeCandidateTreeHash(
  worktreePath: string,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<string | null> {
  const hash = await withTemporaryIndex(worktreePath, deps, async (tmpOpts) => {
    const { stdout } = await deps.gitClient.git(
      ["write-tree"],
      worktreePath,
      tmpOpts,
    );
    return stdout.trim();
  });
  return hash === null || hash.length === 0 ? null : hash;
}

/** A candidate's content identity together with the patch that identity spans. */
export interface CandidateSnapshot {
  treeHash: string;
  diff: SessionDiff;
}

/**
 * Read the candidate ONCE: the tree object and the patch against HEAD, both
 * produced from a single temporary index.
 *
 * The pairing is the point. {@link computeDiff} is cached on HEAD plus a
 * porcelain hash, and porcelain cannot see a content-only edit to a file that
 * was already modified — so a reader that took its tree hash from
 * {@link computeCandidateTreeHash} and its patch from the cache could hold a
 * patch OLDER than the tree it claims to describe. A validation round certifies
 * a tree hash on the strength of what its reviewers read, so it reads through
 * here instead: same index, same instant, no cache.
 *
 * Null when the temporary-index sequence fails, so an unresolvable candidate is
 * distinguishable from a clean one rather than collapsing into an empty diff.
 */
export async function computeCandidateSnapshot(
  worktreePath: string,
  deps: ComputeDiffDeps = defaultComputeDiffDeps,
): Promise<CandidateSnapshot | null> {
  const snapshot = await withTemporaryIndex(
    worktreePath,
    deps,
    async (tmpOpts) => {
      const { stdout: treeHash } = await deps.gitClient.git(
        ["write-tree"],
        worktreePath,
        tmpOpts,
      );
      const { stdout: rawDiff } = await deps.gitClient.git(
        ["diff", "--cached", "HEAD", "--unified=3"],
        worktreePath,
        tmpOpts,
      );
      return { treeHash: treeHash.trim(), rawDiff };
    },
  );

  if (snapshot === null || snapshot.treeHash.length === 0) return null;

  return {
    treeHash: snapshot.treeHash,
    diff: snapshot.rawDiff.trim()
      ? parseDiff(snapshot.rawDiff)
      : { files: [], totalAdditions: 0, totalDeletions: 0 },
  };
}

async function computeDiffImpl(
  worktreePath: string,
  deps: ComputeDiffDeps,
): Promise<SessionDiff> {
  const rawDiff = await withTemporaryIndex(
    worktreePath,
    deps,
    async (tmpOpts) => {
      // Diff the temp index (working tree) against HEAD — uncommitted changes only
      const { stdout } = await deps.gitClient.git(
        ["diff", "--cached", "HEAD", "--unified=3"],
        worktreePath,
        tmpOpts,
      );
      return stdout;
    },
  );

  // A null result means the temp-index sequence failed; an empty diff and a
  // failed diff both render as "no uncommitted changes" here, as before.
  if (rawDiff === null || !rawDiff.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  return parseDiff(rawDiff);
}

/** Parse unified diff output into structured data */
export function parseDiff(raw: string): SessionDiff {
  const files: FileDiff[] = [];
  const lines = raw.split("\n");

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    // New file header: diff --git a/path b/path
    if (line.startsWith("diff --git ")) {
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }

      // Extract file path from "diff --git a/foo b/foo"
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      const filePath = match?.[2] ?? line;

      currentFile = {
        filePath,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    // Skip index, ---, +++ lines
    if (
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    if (line.startsWith("@@")) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }
      currentHunk = {
        header: line,
        lines: [{ type: "hunk-header", content: line }],
      };
      continue;
    }

    if (!currentHunk || !currentFile) continue;

    // Addition
    if (line.startsWith("+")) {
      const diffLine: DiffLine = {
        type: "add",
        content: line.slice(1),
      };
      currentHunk.lines.push(diffLine);
      currentFile.additions++;
      continue;
    }

    // Deletion
    if (line.startsWith("-")) {
      const diffLine: DiffLine = {
        type: "remove",
        content: line.slice(1),
      };
      currentHunk.lines.push(diffLine);
      currentFile.deletions++;
      continue;
    }

    // Context line (starts with space or is empty)
    if (line.startsWith(" ") || line === "") {
      currentHunk.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : "",
      });
    }
  }

  // Push final file/hunk
  if (currentFile) {
    if (currentHunk) {
      currentFile.hunks.push(currentHunk);
    }
    files.push(currentFile);
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return { files, totalAdditions, totalDeletions };
}
