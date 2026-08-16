import { defaultGitClient, type GitClient } from "./client";
import {
  isMergeInProgress,
  scanStagingConflictArtifacts,
} from "./conflict-markers";
import { parseDiff } from "./diff";
import { createOwnedLandingOperations } from "./owned-landing";
import { createLogger } from "../logging";
import type { CommitLogEntry, SessionDiff } from "./schemas";

const logger = createLogger("git-commits");

const MAX_BUFFER = 10 * 1024 * 1024;

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

/**
 * Create a commit/log/diff operations module backed by the given GitClient.
 * Tests can inject a fake client; production uses the default singleton.
 */
export function createCommitsOperations(client: GitClient = defaultGitClient) {
  // Built from the same client, so an injected one governs both halves.
  const { worktreeMatchesHead } = createOwnedLandingOperations(client);

  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return client.git(args, cwd, { maxBuffer: MAX_BUFFER });
  }

  /**
   * Whether a worktree holds work to commit — precisely, whether `git add -A &&
   * git commit` would produce a commit.
   *
   * That is deliberately a comparison of the WORKING TREE against HEAD rather
   * than a reading of the index, which can disagree with both while the
   * worktree matches HEAD exactly: a graph-workflow lane lands owned paths
   * through a private index and never writes the shared one, and a plain `git
   * add` followed by reverting the file does the same thing by hand. Believing
   * the index there sends callers into a commit that stages the phantom away
   * and then fails with "nothing to commit". `worktreeMatchesHead` owns the
   * comparison — see `git/owned-landing.ts` for why the index cannot answer it.
   */
  async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
      return !(await worktreeMatchesHead(worktreePath));
    } catch {
      // No HEAD to compare against (unborn branch): nothing is committed, so
      // the index cannot disagree with it and status is the exact answer.
      const { stdout } = await git(worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      return stdout.trim().length > 0;
    }
  }

  /** Summarize the worktree's current changes as agent-readable text:
   *  file statuses (including untracked files) plus per-file change
   *  magnitude for tracked changes. Returns an empty string when clean. */
  async function collectChangeSummary(worktreePath: string): Promise<string> {
    const { stdout: status } = await git(worktreePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (!status.trim()) {
      return "";
    }

    let stat = "";
    try {
      const { stdout } = await git(worktreePath, ["diff", "--stat", "HEAD"]);
      stat = stdout.trim();
    } catch {
      // No HEAD yet (unborn branch) or stat failure — the status file list
      // alone still names every changed file.
    }

    const sections = [
      `File status (git status --porcelain):\n${status.trimEnd()}`,
    ];
    if (stat) {
      sections.push(`Change magnitude (git diff --stat HEAD):\n${stat}`);
    }
    const summary = sections.join("\n\n");

    logger.debug("git.changeSummary", {
      worktreePath,
      fileCount: status.trim().split("\n").length,
      summaryLength: summary.length,
    });

    return summary;
  }

  /** Read the worktree's currently checked-out branch.
   *  Returns null when HEAD is detached (symbolic-ref fails). */
  async function getCurrentBranch(
    worktreePath: string,
  ): Promise<string | null> {
    try {
      const { stdout } = await git(worktreePath, [
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** Read the worktree's current HEAD commit SHA.
   *  Returns null when HEAD cannot be resolved (unborn branch, not a repo). */
  async function getHeadCommit(worktreePath: string): Promise<string | null> {
    try {
      const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
      const sha = stdout.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  function refuseConflictArtifacts(
    worktreePath: string,
    reason: "unmerged_entries" | "conflict_markers",
    files: string[],
  ): never {
    logger.error("git.commit.refused", { worktreePath, reason, files });
    throw new Error(
      `Refusing to commit: ${files.length} file(s) contain conflict artifacts ` +
        `(${files.join(", ")}). Resolve the conflicts (or abort the merge) ` +
        `before committing.`,
    );
  }

  /**
   * Refuse to stage-and-commit a worktree that still carries conflict
   * artifacts. Unmerged index entries catch every genuinely mid-merge tree;
   * the marker scan catches the poisoned tree an index resync leaves behind,
   * where MERGE_HEAD and the unmerged entries are gone but the markers are
   * still in the files. The scan reaches as far as `git add -A` does, so an
   * untracked file is judged by the same rule as a tracked one.
   */
  async function assertNoConflictArtifacts(
    worktreePath: string,
  ): Promise<void> {
    const artifacts = await scanStagingConflictArtifacts(worktreePath, client);
    if (artifacts.unmergedFiles.length > 0) {
      refuseConflictArtifacts(
        worktreePath,
        "unmerged_entries",
        artifacts.unmergedFiles,
      );
    }
    if (artifacts.markerFiles.length > 0) {
      refuseConflictArtifacts(
        worktreePath,
        "conflict_markers",
        artifacts.markerFiles,
      );
    }
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

    // A conflict resolution that keeps HEAD's content for every conflicted
    // file leaves `git status --porcelain` empty while MERGE_HEAD still
    // exists — `git commit` is still required to conclude the merge.
    const hasChanges = await hasUncommittedChanges(worktreePath);
    if (!hasChanges && !(await isMergeInProgress(worktreePath, client))) {
      throw new Error("No uncommitted changes to commit");
    }

    await assertNoConflictArtifacts(worktreePath);

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

  return {
    hasUncommittedChanges,
    collectChangeSummary,
    getCurrentBranch,
    getHeadCommit,
    commitChanges,
    getCommitLog,
    getCommitDiff,
  };
}

// ============================================================
// Default singleton exports
// ============================================================

const defaultOps = createCommitsOperations();

export const hasUncommittedChanges = defaultOps.hasUncommittedChanges;
export const collectChangeSummary = defaultOps.collectChangeSummary;
export const getCurrentBranch = defaultOps.getCurrentBranch;
export const getHeadCommit = defaultOps.getHeadCommit;
export const commitChanges = defaultOps.commitChanges;
export const getCommitLog = defaultOps.getCommitLog;
export const getCommitDiff = defaultOps.getCommitDiff;
