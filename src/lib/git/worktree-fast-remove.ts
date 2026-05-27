import { existsSync as defaultExistsSync } from "node:fs";
import {
  mkdir as defaultMkdir,
  rename as defaultRename,
  rm as defaultRm,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { defaultGitClient, type GitClient } from "./client";
import { createLogger, type Logger } from "../logging";
import { getErrorMessage } from "@/lib/shared/errors";

const defaultLogger = createLogger("git-worktree-fast-remove");

export type FastRemoveStatus = "moved" | "absent" | "fallback";

export interface FastRemoveResult {
  status: FastRemoveStatus;
  /** Path the worktree was moved to (set when status === "moved"). */
  trashPath?: string;
  /**
   * Background cleanup promise that resolves when the detached `rm -rf`
   * completes. Callers may ignore this in production; tests await it to
   * assert the eventual outcome.
   */
  backgroundCleanup?: Promise<void>;
  /** Reason a fallback path was taken (set when status === "fallback"). */
  reason?: string;
}

export interface FastRemoveDeps {
  gitClient: GitClient;
  existsSync(p: string): boolean;
  rename(src: string, dst: string): Promise<void>;
  mkdir(p: string, opts: { recursive: true }): Promise<string | undefined>;
  rm(p: string, opts: { recursive: true; force: true }): Promise<void>;
  /**
   * Run an `rm -rf <trashPath>` detached from the current process and resolve
   * when the child exits. Production wires this to a `spawn(...).unref()` so
   * the foreground returns immediately. Tests inject an inline implementation.
   */
  backgroundRm(trashPath: string): Promise<void>;
  logger: Logger;
  now(): number;
  randomSuffix(): string;
}

function defaultBackgroundRm(trashPath: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("rm", ["-rf", "--", trashPath], {
      detached: true,
      stdio: "ignore",
    });
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
    child.unref();
  });
}

export const defaultFastRemoveDeps: FastRemoveDeps = {
  gitClient: defaultGitClient,
  existsSync: defaultExistsSync,
  rename: defaultRename,
  mkdir: defaultMkdir,
  rm: defaultRm,
  backgroundRm: defaultBackgroundRm,
  logger: defaultLogger,
  now: () => Date.now(),
  randomSuffix: () => crypto.randomBytes(3).toString("hex"),
};

export interface FastRemoveInput {
  /** Git project root that owns the worktree's admin entry. */
  projectPath: string;
  /** Absolute path of the worktree directory to remove. */
  worktreePath: string;
  /**
   * Optional branch name to delete after the worktree is removed. When unset,
   * branch cleanup is skipped (caller may do it separately).
   */
  branchName?: string;
}

/**
 * Remove a git worktree off the request critical path.
 *
 * Sequence: rename worktree → `<projectPath>/.worktrees/.trash/<basename>-<ts>-<rand>`,
 * then `git worktree prune` (cleans `.git/worktrees/<name>` admin entry),
 * optional `git branch -D`, then a detached `rm -rf` of the trash dir. The
 * foreground returns once the rename + prune finish — typically ~10ms instead
 * of seconds spent walking a populated `node_modules`.
 *
 * Fallback: if the rename fails (cross-device, permissions), the function
 * synchronously `rm -rf`'s the original path and returns status "fallback".
 */
export async function fastRemoveWorktree(
  input: FastRemoveInput,
  deps: FastRemoveDeps = defaultFastRemoveDeps,
): Promise<FastRemoveResult> {
  const { projectPath, worktreePath, branchName } = input;

  if (!deps.existsSync(worktreePath)) {
    if (branchName) {
      await pruneAndDeleteBranch(projectPath, branchName, deps);
    }
    return { status: "absent" };
  }

  const trashRoot = path.join(projectPath, ".worktrees", ".trash");
  const trashPath = path.join(
    trashRoot,
    `${path.basename(worktreePath)}-${deps.now()}-${deps.randomSuffix()}`,
  );

  try {
    await deps.mkdir(trashRoot, { recursive: true });
    await deps.rename(worktreePath, trashPath);
  } catch (err) {
    const reason = getErrorMessage(err);
    deps.logger.warn("fast_remove_rename_failed", {
      worktreePath,
      trashPath,
      reason,
    });
    try {
      await deps.rm(worktreePath, { recursive: true, force: true });
    } catch (rmErr) {
      deps.logger.error("fast_remove_fallback_rm_failed", {
        worktreePath,
        reason: getErrorMessage(rmErr),
      });
      throw rmErr;
    }
    await pruneAndDeleteBranch(projectPath, branchName, deps);
    return { status: "fallback", reason };
  }

  await pruneAndDeleteBranch(projectPath, branchName, deps);

  const backgroundCleanup = deps.backgroundRm(trashPath).catch((err) => {
    deps.logger.warn("fast_remove_background_rm_failed", {
      trashPath,
      reason: getErrorMessage(err),
    });
  });

  deps.logger.info("fast_remove_moved", { worktreePath, trashPath });

  return { status: "moved", trashPath, backgroundCleanup };
}

async function pruneAndDeleteBranch(
  projectPath: string,
  branchName: string | undefined,
  deps: FastRemoveDeps,
): Promise<void> {
  try {
    await deps.gitClient.git(["worktree", "prune"], projectPath);
  } catch (err) {
    deps.logger.warn("fast_remove_prune_failed", {
      projectPath,
      reason: getErrorMessage(err),
    });
  }

  if (!branchName) return;

  try {
    await deps.gitClient.git(["branch", "-D", branchName], projectPath);
  } catch (err) {
    deps.logger.warn("fast_remove_branch_delete_failed", {
      projectPath,
      branchName,
      reason: getErrorMessage(err),
    });
  }
}
