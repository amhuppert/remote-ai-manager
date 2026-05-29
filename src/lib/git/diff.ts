import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { unlink as unlinkDefault } from "node:fs/promises";
import type { SessionDiff, FileDiff, DiffHunk, DiffLine } from "./schemas";
import { createLogger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";

const execFileAsyncDefault = promisify(execFile);
const logger = createLogger("diff");

const MAX_BUFFER = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  DI for computeDiff                                                 */
/* ------------------------------------------------------------------ */

export interface ComputeDiffDeps {
  execFileAsync: (
    cmd: string,
    args: string[],
    opts: { cwd: string; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  unlink: (path: string) => Promise<void>;
}

const defaultComputeDiffDeps: ComputeDiffDeps = {
  execFileAsync: execFileAsyncDefault,
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
    const opts = { cwd: worktreePath, maxBuffer: MAX_BUFFER };
    const head = await deps.execFileAsync("git", ["rev-parse", "HEAD"], opts);
    const status = await deps.execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z"],
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

async function computeDiffImpl(
  worktreePath: string,
  deps: ComputeDiffDeps,
): Promise<SessionDiff> {
  let rawDiff: string;
  const tmpIndex = join(tmpdir(), `cc-diff-${randomUUID()}`);
  try {
    const opts = { cwd: worktreePath, maxBuffer: MAX_BUFFER };
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const tmpOpts = { ...opts, env: tmpEnv };

    // Build a temp index: seed from HEAD tree, then update with working tree
    await deps.execFileAsync("git", ["read-tree", "HEAD"], tmpOpts);
    await deps.execFileAsync("git", ["add", "-A"], tmpOpts);

    // Diff the temp index (working tree) against HEAD — uncommitted changes only
    const { stdout } = await deps.execFileAsync(
      "git",
      ["diff", "--cached", "HEAD", "--unified=3"],
      tmpOpts,
    );
    rawDiff = stdout;
  } catch {
    // If diff fails, return empty
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  } finally {
    await deps.unlink(tmpIndex).catch(() => {});
  }

  if (!rawDiff.trim()) {
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
