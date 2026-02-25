import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDiff } from "./diff";
import { createLogger } from "./logging";
import type { SessionDiff } from "@/types";
import type { CommitLogEntry } from "./schemas";

const logger = createLogger("git-operations");

const execFileAsync = promisify(execFile);

/** Execute a git command in the given working directory */
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

// ============================================================
// Commit Operations
// ============================================================

interface CommitResult {
  hash: string;
}

/** Check if a worktree has uncommitted changes (staged or unstaged) */
export async function hasUncommittedChanges(
  worktreePath: string,
): Promise<boolean> {
  const { stdout } = await git(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return stdout.trim().length > 0;
}

/** Stage all changes and commit with the given message */
export async function commitChanges(
  worktreePath: string,
  message: string,
): Promise<CommitResult> {
  if (!message.trim()) {
    throw new Error("Commit message cannot be empty");
  }

  const hasChanges = await hasUncommittedChanges(worktreePath);
  if (!hasChanges) {
    throw new Error("No uncommitted changes to commit");
  }

  logger.info("git.commit", { worktreePath, messageLength: message.length });

  await git(worktreePath, ["add", "-A"]);
  const { stdout } = await git(worktreePath, ["commit", "-m", message]);

  // Extract commit hash from output — git commit prints it in the first line
  // Format: [branchName hashPrefix] message
  const hashMatch = /\[[\w/.-]+ ([a-f0-9]+)\]/.exec(stdout);
  const hash = hashMatch?.[1] ?? "";

  logger.info("git.commit.success", { worktreePath, hash });

  return { hash };
}

// ============================================================
// Commit Log & Diff
// ============================================================

const LOG_FORMAT = "%h%x00%H%x00%s%x00%aI%x00";

/** Parse a single git log entry line into a CommitLogEntry */
function parseLogEntry(line: string): CommitLogEntry | null {
  const parts = line.split("\0");
  if (parts.length < 4) return null;

  const [hash, fullHash, message, date] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (!hash || !fullHash) return null;

  return {
    hash,
    fullHash,
    message: message ?? "",
    date: date ?? "",
    filesChanged: 0, // filled in below
  };
}

/** Get the list of commits since the branch diverged from main */
export async function getCommitLog(
  worktreePath: string,
): Promise<CommitLogEntry[]> {
  let stdout: string;
  try {
    const result = await git(worktreePath, [
      "log",
      "main..HEAD",
      `--format=${LOG_FORMAT}`,
    ]);
    stdout = result.stdout;
  } catch {
    // If main doesn't exist or no commits, return empty
    return [];
  }

  if (!stdout.trim()) {
    return [];
  }

  const entries: CommitLogEntry[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const entry = parseLogEntry(line);
    if (entry) entries.push(entry);
  }

  // Batch-fetch file counts using --stat for all commits in the range
  try {
    const { stdout: statOutput } = await git(worktreePath, [
      "log",
      "main..HEAD",
      "--format=%H",
      "--numstat",
    ]);

    let currentHash = "";
    let fileCount = 0;

    for (const line of statOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Full hash line (40 hex chars)
      if (/^[a-f0-9]{40}$/.test(trimmed)) {
        // Save previous commit's count
        if (currentHash) {
          const entry = entries.find((e) => e.fullHash === currentHash);
          if (entry) entry.filesChanged = fileCount;
        }
        currentHash = trimmed;
        fileCount = 0;
      } else if (trimmed.match(/^\d+\t\d+\t/) || trimmed.startsWith("-\t")) {
        // numstat line: additions\tdeletions\tfilename
        fileCount++;
      }
    }

    // Save last commit's count
    if (currentHash) {
      const entry = entries.find((e) => e.fullHash === currentHash);
      if (entry) entry.filesChanged = fileCount;
    }
  } catch {
    // If stat fails, leave filesChanged at 0
  }

  return entries;
}

/** Get parsed diff for a single commit */
export async function getCommitDiff(
  worktreePath: string,
  commitHash: string,
): Promise<SessionDiff> {
  // Check if the commit's parent is reachable from main — if not,
  // this is the first commit after divergence and we diff against merge-base
  let diffArgs: string[];

  try {
    // Try to find the parent commit
    const { stdout: parentHash } = await git(worktreePath, [
      "rev-parse",
      "--verify",
      `${commitHash}^`,
    ]);

    // Check if the parent is an ancestor of main (i.e., the commit IS the first divergence)
    try {
      await git(worktreePath, [
        "merge-base",
        "--is-ancestor",
        parentHash.trim(),
        "main",
      ]);
      // Parent IS an ancestor of main → first commit after divergence, diff against merge-base
      const { stdout: mergeBase } = await git(worktreePath, [
        "merge-base",
        "main",
        commitHash,
      ]);
      diffArgs = ["diff", `${mergeBase.trim()}..${commitHash}`, "--unified=3"];
    } catch {
      // Parent is NOT an ancestor of main → normal diff against parent
      diffArgs = ["diff", `${commitHash}~1..${commitHash}`, "--unified=3"];
    }
  } catch {
    // No parent (shouldn't normally happen) — diff against merge-base
    const { stdout: mergeBase } = await git(worktreePath, [
      "merge-base",
      "main",
      commitHash,
    ]);
    diffArgs = ["diff", `${mergeBase.trim()}..${commitHash}`, "--unified=3"];
  }

  const { stdout } = await git(worktreePath, diffArgs);

  if (!stdout.trim()) {
    return { files: [], totalAdditions: 0, totalDeletions: 0 };
  }

  return parseDiff(stdout);
}

// ============================================================
// Merge Main into Feature Branch
// ============================================================

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

/** Merge main into the current feature branch in the given worktree.
 *  On conflict the worktree is left in conflict state (merge is NOT aborted). */
export async function mergeMainIntoFeature(
  worktreePath: string,
): Promise<MergeMainResult> {
  try {
    await git(worktreePath, ["merge", "main"]);
    return { status: "clean" };
  } catch (err) {
    const errObj = err as Error & { stderr?: string };
    const stderr = errObj.stderr ?? "";
    const message = errObj.message ?? "";
    const combined = `${stderr}\n${message}`;

    const isConflict =
      combined.includes("CONFLICT") || combined.includes("merge conflict");

    if (!isConflict) {
      throw err;
    }

    // List conflicted (unmerged) files — do NOT abort the merge
    const { stdout } = await git(worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);

    const conflictFiles = stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);

    logger.info("git.mergeMain.conflicts", { worktreePath, conflictFiles });

    return { status: "conflicts", conflictFiles };
  }
}

// ============================================================
// Squash Merge
// ============================================================

interface MergeResult {
  mergeHash: string;
}

/** Squash merge a session branch into main, executed in the project root */
export async function squashMerge(
  projectPath: string,
  branchName: string,
  message: string,
): Promise<MergeResult> {
  if (!message.trim()) {
    throw new Error("Merge message cannot be empty");
  }

  // Pre-check: project root must be clean
  const { stdout: rootStatus } = await git(projectPath, [
    "status",
    "--porcelain",
  ]);
  if (rootStatus.trim().length > 0) {
    throw new Error("Main branch has uncommitted changes");
  }

  logger.info("git.merge", { projectPath, branchName });

  // Execute squash merge
  try {
    await git(projectPath, ["merge", "--squash", branchName]);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    const isConflict =
      stderr.includes("CONFLICT") || stderr.includes("merge conflict");

    // Abort the failed merge to leave the project root clean
    await git(projectPath, ["merge", "--abort"]).catch(() => {});
    // Reset any staged changes from the failed squash
    await git(projectPath, ["reset", "--hard", "HEAD"]).catch(() => {});

    if (isConflict) {
      throw new Error(
        "Merge conflicts detected between this session and main. Resolve the conflicts in the worktree and try again.",
      );
    }
    throw err;
  }

  // Commit the squash merge
  let commitOutput: string;
  try {
    const result = await git(projectPath, ["commit", "-m", message]);
    commitOutput = result.stdout;
  } catch (err) {
    if (err instanceof Error) {
      // Capture stderr/stdout from the failed commit (e.g. pre-commit hook output)
      const childErr = err as Error & { stderr?: string; stdout?: string };
      const rawOutput = [childErr.stderr?.trim(), childErr.stdout?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
      const newErr = new Error("Commit failed");
      (newErr as Error & { gitOutput?: string }).gitOutput =
        rawOutput || undefined;
      throw newErr;
    }
    throw err;
  }

  // Extract hash from commit output
  const hashMatch = /\[[\w/.-]+ ([a-f0-9]+)\]/.exec(commitOutput);
  const mergeHash = hashMatch?.[1] ?? "";

  logger.info("git.merge.success", { projectPath, branchName, mergeHash });

  return { mergeHash };
}
