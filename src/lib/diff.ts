import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionDiff, FileDiff, DiffHunk, DiffLine } from "@/types";

const execFileAsync = promisify(execFile);

/**
 * Compute a git diff of the session worktree vs the merge-base with main.
 * Uses the point where the branch diverged from main, so only the branch's
 * own changes are shown (excludes unrelated commits added to main since).
 */
export async function computeDiff(worktreePath: string): Promise<SessionDiff> {
  let rawDiff: string;
  try {
    const { stdout: mergeBase } = await execFileAsync(
      "git",
      ["merge-base", "main", "HEAD"],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync(
      "git",
      ["diff", mergeBase.trim(), "--unified=3"],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
    );
    rawDiff = stdout;
  } catch {
    // If merge-base or diff fails (e.g., no main branch), return empty
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
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
