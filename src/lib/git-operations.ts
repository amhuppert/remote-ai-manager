import { defaultGitClient, type GitClient } from "./git-client";
import { parseDiff } from "./diff";
import { createLogger } from "./logging";
import { getErrorMessage } from "@/lib/errors";
import type { SessionDiff } from "@/types";
import type { CommitLogEntry } from "./schemas";

const logger = createLogger("git-operations");

const MAX_BUFFER = 10 * 1024 * 1024;

// ============================================================
// Shared pure helpers
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

// ============================================================
// Types
// ============================================================

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

// ============================================================
// Factory
// ============================================================

/**
 * Create a git operations module backed by the given GitClient.
 * Tests can inject a fake client; production uses the default singleton.
 */
export function createGitOperations(client: GitClient = defaultGitClient) {
  /** Execute a git command in the given working directory */
  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return client.git(args, cwd, { maxBuffer: MAX_BUFFER });
  }

  // ----------------------------------------------------------
  // Commit Operations
  // ----------------------------------------------------------

  /** Check if a worktree has uncommitted changes (staged or unstaged) */
  async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const { stdout } = await git(worktreePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return stdout.trim().length > 0;
  }

  /** Stage all changes and commit with the given message.
   *  When `skipHooks` is true, passes `--no-verify` to skip pre-commit hooks. */
  async function commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }> {
    if (!message.trim()) {
      throw new Error("Commit message cannot be empty");
    }

    const hasChanges = await hasUncommittedChanges(worktreePath);
    if (!hasChanges) {
      throw new Error("No uncommitted changes to commit");
    }

    logger.info("git.commit", { worktreePath, messageLength: message.length });

    await git(worktreePath, ["add", "-A"]);
    const commitArgs = ["commit", "-m", message];
    if (options?.skipHooks) {
      commitArgs.push("--no-verify");
    }
    const { stdout } = await git(worktreePath, commitArgs);

    // Extract commit hash from output — git commit prints it in the first line
    // Format: [branchName hashPrefix] message
    const hashMatch = /\[[\w/.-]+ ([a-f0-9]+)\]/.exec(stdout);
    const hash = hashMatch?.[1] ?? "";

    logger.info("git.commit.success", { worktreePath, hash });

    return { hash };
  }

  // ----------------------------------------------------------
  // Commit Log & Diff
  // ----------------------------------------------------------

  /** Get the list of commits since the branch diverged from the target branch */
  async function getCommitLog(
    worktreePath: string,
    targetBranch = "main",
  ): Promise<CommitLogEntry[]> {
    let stdout: string;
    try {
      const result = await git(worktreePath, [
        "log",
        `${targetBranch}..HEAD`,
        `--format=${LOG_FORMAT}`,
      ]);
      stdout = result.stdout;
    } catch {
      // If target branch doesn't exist or no commits, return empty
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
        `${targetBranch}..HEAD`,
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
  async function getCommitDiff(
    worktreePath: string,
    commitHash: string,
    targetBranch = "main",
  ): Promise<SessionDiff> {
    // Check if the commit's parent is reachable from the target branch — if not,
    // this is the first commit after divergence and we diff against merge-base
    let diffArgs: string[];

    try {
      // Try to find the parent commit
      const { stdout: parentHash } = await git(worktreePath, [
        "rev-parse",
        "--verify",
        `${commitHash}^`,
      ]);

      // Check if the parent is an ancestor of the target branch (i.e., the commit IS the first divergence)
      try {
        await git(worktreePath, [
          "merge-base",
          "--is-ancestor",
          parentHash.trim(),
          targetBranch,
        ]);
        // Parent IS an ancestor of target → first commit after divergence, diff against merge-base
        const { stdout: mergeBase } = await git(worktreePath, [
          "merge-base",
          targetBranch,
          commitHash,
        ]);
        diffArgs = [
          "diff",
          `${mergeBase.trim()}..${commitHash}`,
          "--unified=3",
        ];
      } catch {
        // Parent is NOT an ancestor of target → normal diff against parent
        diffArgs = ["diff", `${commitHash}~1..${commitHash}`, "--unified=3"];
      }
    } catch {
      // No parent (shouldn't normally happen) — diff against merge-base
      const { stdout: mergeBase } = await git(worktreePath, [
        "merge-base",
        targetBranch,
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

  // ----------------------------------------------------------
  // Merge Detection
  // ----------------------------------------------------------

  /**
   * Check if a branch has been merged into the target branch via regular merge commit.
   * Returns true if the branch tip is an ancestor of the target AND the branch
   * actually has commits beyond the merge base (i.e., it diverged from the target
   * at some point). Branches that never diverged (tip == merge-base) are
   * not considered merged — they just never had any unique commits.
   */
  async function isBranchAncestorOfTarget(
    projectPath: string,
    branchName: string,
    targetBranch = "main",
  ): Promise<boolean> {
    try {
      await git(projectPath, [
        "merge-base",
        "--is-ancestor",
        branchName,
        targetBranch,
      ]);

      // Branch is ancestor of target — but did it ever diverge?
      // Compare the branch tip to the merge base. If they're identical,
      // the branch never had unique commits and shouldn't be considered merged.
      const { stdout: branchTip } = await git(projectPath, [
        "rev-parse",
        branchName,
      ]);
      const { stdout: mergeBase } = await git(projectPath, [
        "merge-base",
        branchName,
        targetBranch,
      ]);

      if (branchTip.trim() === mergeBase.trim()) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the target branch's recent commit log mentions the branch name.
   * Catches squash/rebase merges where the commit message references the branch.
   */
  async function isBranchMentionedInTargetLog(
    projectPath: string,
    branchName: string,
    targetBranch = "main",
  ): Promise<boolean> {
    try {
      const { stdout } = await git(projectPath, [
        "log",
        targetBranch,
        "--oneline",
        "-100",
        `--grep=${branchName}`,
      ]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------
  // Merge Target into Feature Branch
  // ----------------------------------------------------------

  /** Merge the target branch into the current feature branch in the given worktree.
   *  On conflict the worktree is left in conflict state (merge is NOT aborted). */
  async function mergeTargetIntoFeature(
    worktreePath: string,
    targetBranch = "main",
  ): Promise<MergeMainResult> {
    try {
      await git(worktreePath, ["merge", targetBranch]);
      return { status: "clean" };
    } catch (err) {
      const errObj = err as Error & { stderr?: string; stdout?: string };
      const stderr = errObj.stderr ?? "";
      const stdout = errObj.stdout ?? "";
      const message = errObj.message ?? "";
      const combined = `${stderr}\n${stdout}\n${message}`;

      const isConflict =
        combined.includes("CONFLICT") || combined.includes("merge conflict");

      if (!isConflict) {
        throw err;
      }

      // List conflicted (unmerged) files — do NOT abort the merge
      const { stdout: diffOut } = await git(worktreePath, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);

      const conflictFiles = diffOut
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      logger.info("git.mergeTarget.conflicts", { worktreePath, conflictFiles });

      return { status: "conflicts", conflictFiles };
    }
  }

  // ----------------------------------------------------------
  // Squash Merge
  // ----------------------------------------------------------

  /** Squash merge a session branch into the target, executed in the merge path
   *  (project root for main, parent worktree for non-main targets). */
  async function squashMerge(
    mergePath: string,
    branchName: string,
    message: string,
    targetBranch = "main",
  ): Promise<{ mergeHash: string }> {
    if (!message.trim()) {
      throw new Error("Merge message cannot be empty");
    }

    // Pre-check: merge path must be clean (ignore untracked files)
    const { stdout: rootStatus } = await git(mergePath, [
      "status",
      "--porcelain",
    ]);
    const hasTrackedChanges = rootStatus
      .split("\n")
      .some((line) => line.length > 0 && !line.startsWith("??"));
    if (hasTrackedChanges) {
      throw new Error(
        `Target branch '${targetBranch}' has uncommitted changes`,
      );
    }

    logger.info("git.merge", { mergePath, branchName, targetBranch });

    // Execute squash merge
    try {
      await git(mergePath, ["merge", "--squash", branchName]);
    } catch (err) {
      const stderr = getErrorMessage(err);
      const isConflict =
        stderr.includes("CONFLICT") || stderr.includes("merge conflict");

      // Abort the failed merge to leave the merge path clean
      await git(mergePath, ["merge", "--abort"]).catch(() => {});
      // Reset any staged changes from the failed squash
      await git(mergePath, ["reset", "--hard", "HEAD"]).catch(() => {});

      if (isConflict) {
        throw new Error(
          `Merge conflicts detected between this session and ${targetBranch}. Resolve the conflicts in the worktree and try again.`,
        );
      }
      throw err;
    }

    // Commit the squash merge
    let commitOutput: string;
    try {
      const result = await git(mergePath, [
        "commit",
        "--no-verify",
        "-m",
        message,
      ]);
      commitOutput = result.stdout;
    } catch (err) {
      // Clean up: reset staged squash changes so merge path stays clean
      await git(mergePath, ["reset", "--hard", "HEAD"]).catch(() => {});

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

    logger.info("git.merge.success", { mergePath, branchName, mergeHash });

    return { mergeHash };
  }

  return {
    hasUncommittedChanges,
    commitChanges,
    getCommitLog,
    getCommitDiff,
    isBranchAncestorOfTarget,
    isBranchMentionedInTargetLog,
    mergeTargetIntoFeature,
    squashMerge,
  };
}

// ============================================================
// Default singleton exports (backward-compatible)
// ============================================================

const defaultOps = createGitOperations();

export const hasUncommittedChanges = defaultOps.hasUncommittedChanges;
export const commitChanges = defaultOps.commitChanges;
export const getCommitLog = defaultOps.getCommitLog;
export const getCommitDiff = defaultOps.getCommitDiff;
export const isBranchAncestorOfTarget = defaultOps.isBranchAncestorOfTarget;
export const isBranchMentionedInTargetLog =
  defaultOps.isBranchMentionedInTargetLog;
export const mergeTargetIntoFeature = defaultOps.mergeTargetIntoFeature;
export const squashMerge = defaultOps.squashMerge;
