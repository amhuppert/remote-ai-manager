import { defaultGitClient, type GitClient } from "./client";
import { createLogger } from "../logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  MergePreconditionFailed,
  type DirtyPath,
} from "@/lib/workflow-graph/errors";

const logger = createLogger("git-worktree");

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Parse output of `git status --porcelain` into structured dirty-path entries.
 * The first two bytes of each line are the status code (e.g. ` M`, `M `, `??`,
 * `R `); the path starts at byte 3. Renames use the form `R  old -> new`; we
 * record the destination path.
 */
export function parseDirtyPaths(porcelain: string): DirtyPath[] {
  const out: DirtyPath[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.length === 0) continue;
    const statusCode = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    if (rest.length === 0) continue;
    const arrowIdx = rest.indexOf(" -> ");
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + " -> ".length) : rest;
    out.push({
      path,
      statusCode,
      tracked: !statusCode.startsWith("??"),
    });
  }
  return out;
}

export type MergeMainResult =
  | { status: "clean" }
  | { status: "conflicts"; conflictFiles: string[] };

/**
 * Create a worktree-level git operations module (merge / squash merge) backed
 * by the given GitClient. Tests can inject a fake client.
 */
export function createWorktreeOperations(client: GitClient = defaultGitClient) {
  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return client.git(args, cwd, { maxBuffer: MAX_BUFFER });
  }

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
    const trackedDirty = parseDirtyPaths(rootStatus).filter((p) => p.tracked);
    if (trackedDirty.length > 0) {
      throw new MergePreconditionFailed(
        `Target branch '${targetBranch}' has ${trackedDirty.length} uncommitted change(s)`,
        {
          targetBranch,
          dirtyPaths: trackedDirty,
          dirtyCount: trackedDirty.length,
        },
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

    // No-op detection: if the feature branch is identical to the merge target,
    // `git merge --squash` succeeds but stages nothing. Attempting to `git
    // commit` would then fail with "nothing to commit, working tree clean".
    // Treat this as a successful no-op merge.
    const { stdout: stagedOut } = await git(mergePath, [
      "diff",
      "--cached",
      "--name-only",
    ]);
    if (stagedOut.trim().length === 0) {
      logger.info("git.merge.noop", { mergePath, branchName, targetBranch });
      return { mergeHash: "" };
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
    mergeTargetIntoFeature,
    squashMerge,
  };
}

// ============================================================
// Default singleton exports
// ============================================================

const defaultOps = createWorktreeOperations();

export const mergeTargetIntoFeature = defaultOps.mergeTargetIntoFeature;
export const squashMerge = defaultOps.squashMerge;
