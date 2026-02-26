import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitIterationMetrics, ReportStatusInput } from "@/types";

const execFileAsync = promisify(execFile);

/** Opaque snapshot of git worktree state before an iteration. */
export type GitSnapshot = string;

/** Capture a pre-iteration git snapshot (hash of working tree diff). */
export async function captureSnapshot(
  worktreePath: string,
): Promise<GitSnapshot> {
  try {
    // Get a hash representing the current working tree state (tracked + untracked)
    const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--stat"], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Compute the git diff between pre and post iteration state. */
export async function computeDiff(
  worktreePath: string,
  preSnapshot: GitSnapshot,
): Promise<GitIterationMetrics> {
  try {
    // Get current state
    const postSnapshot = await captureSnapshot(worktreePath);

    // If snapshots are identical, no changes were made
    if (preSnapshot === postSnapshot) {
      return {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      };
    }

    // Use numstat for precise metrics
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "HEAD", "--numstat"],
      { cwd: worktreePath },
    );

    return parseNumstat(stdout);
  } catch {
    return {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      changedFiles: [],
    };
  }
}

/** Parse git diff --numstat output into metrics. */
export function parseNumstat(numstatOutput: string): GitIterationMetrics {
  const lines = numstatOutput.trim().split("\n").filter(Boolean);
  let linesAdded = 0;
  let linesRemoved = 0;
  const changedFiles: string[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const added = parseInt(parts[0]!, 10);
      const removed = parseInt(parts[1]!, 10);
      const filePath = parts[2]!;

      if (!isNaN(added)) linesAdded += added;
      if (!isNaN(removed)) linesRemoved += removed;
      changedFiles.push(filePath);
    }
  }

  return {
    filesChanged: changedFiles.length,
    linesAdded,
    linesRemoved,
    changedFiles,
  };
}

/**
 * Classify an iteration as progress or no-progress.
 *
 * "no progress" when: zero file changes AND no tasks completed AND
 * status report is missing or reports in_progress (not complete).
 *
 * "progress" when: file changes exist OR status report indicates complete
 * OR tasks were completed/skipped via update_fix_plan.
 */
export function classifyProgress(
  gitMetrics: GitIterationMetrics,
  statusReport: ReportStatusInput | undefined | null,
  tasksCompleted: number,
): "progress" | "no_progress" {
  // File changes indicate progress
  if (gitMetrics.filesChanged > 0) return "progress";

  // Status report saying complete indicates progress
  if (statusReport?.status === "complete") return "progress";

  // Tasks completed/skipped indicates progress
  if (tasksCompleted > 0) return "progress";

  return "no_progress";
}
