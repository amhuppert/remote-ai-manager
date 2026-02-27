import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { SessionDiff, FileDiff, DiffHunk, DiffLine } from "@/types";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Compute a git diff of uncommitted changes in the session worktree.
 * Uses a temporary index so that untracked files are included in the diff
 * without modifying the real index. Diffs the working tree against HEAD
 * so only truly uncommitted changes are shown.
 */
export async function computeDiff(worktreePath: string): Promise<SessionDiff> {
  let rawDiff: string;
  const tmpIndex = join(tmpdir(), `cc-diff-${randomUUID()}`);
  try {
    const opts = { cwd: worktreePath, maxBuffer: MAX_BUFFER };
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    const tmpOpts = { ...opts, env: tmpEnv };

    // Build a temp index: seed from HEAD tree, then update with working tree
    await execFileAsync("git", ["read-tree", "HEAD"], tmpOpts);
    await execFileAsync("git", ["add", "-A"], tmpOpts);

    // Diff the temp index (working tree) against HEAD — uncommitted changes only
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--cached", "HEAD", "--unified=3"],
      tmpOpts,
    );
    rawDiff = stdout;
  } catch {
    // If diff fails, return empty
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  } finally {
    await unlink(tmpIndex).catch(() => {});
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
