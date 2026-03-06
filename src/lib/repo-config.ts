import { execFile as execFileCb } from "node:child_process";
import { existsSync as defaultExistsSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildChildEnv as defaultBuildChildEnv } from "./child-env";
import { perRepoConfigSchema, type PerRepoConfig } from "./schemas";
import {
  hasUncommittedChanges as defaultHasUncommittedChanges,
  commitChanges as defaultCommitChanges,
} from "./git-operations";
import { createLogger } from "./logging";

const logger = createLogger("repo-config");

const defaultExecFileAsync = promisify(execFileCb);

// ============================================================
// Types
// ============================================================

export interface RepoConfigDeps {
  existsSync: typeof defaultExistsSync;
  readFile: typeof defaultReadFile;
  execFileAsync: typeof defaultExecFileAsync;
  buildChildEnv: typeof defaultBuildChildEnv;
  hasUncommittedChanges: typeof defaultHasUncommittedChanges;
  commitChanges: typeof defaultCommitChanges;
}

const defaultDeps: RepoConfigDeps = {
  existsSync: defaultExistsSync,
  readFile: defaultReadFile,
  execFileAsync: defaultExecFileAsync,
  buildChildEnv: defaultBuildChildEnv,
  hasUncommittedChanges: defaultHasUncommittedChanges,
  commitChanges: defaultCommitChanges,
};

// ============================================================
// Factory
// ============================================================

export function createRepoConfig(deps: RepoConfigDeps = defaultDeps) {
  const {
    existsSync,
    readFile,
    execFileAsync,
    buildChildEnv,
    hasUncommittedChanges,
    commitChanges,
  } = deps;

  /** Read optional per-repo config */
  async function readRepoConfig(
    repoRoot: string,
  ): Promise<PerRepoConfig | null> {
    const configPath = path.join(repoRoot, "CommandCenter.json");
    if (!existsSync(configPath)) return null;

    const raw = await readFile(configPath, "utf-8");
    return perRepoConfigSchema.parse(JSON.parse(raw));
  }

  /**
   * Run the pre-merge validation command configured in CommandCenter.json.
   * No-op if `preMergeCommand` is absent or null.
   * After the script runs, any uncommitted changes (auto-fixes) are committed
   * with `skipHooks: true` so they are included in the squash merge.
   */
  async function runPreMergeValidation(params: {
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    timeoutMs: number;
  }): Promise<void> {
    const { projectPath, worktreePath, sessionName, branchName, timeoutMs } =
      params;

    const repoConfig = await readRepoConfig(projectPath);
    if (!repoConfig?.preMergeCommand) return;

    const scriptPath = path.isAbsolute(repoConfig.preMergeCommand)
      ? repoConfig.preMergeCommand
      : path.join(projectPath, repoConfig.preMergeCommand);

    if (!existsSync(scriptPath)) {
      throw new Error(`Pre-merge validation script not found: ${scriptPath}`);
    }

    logger.info("pre-merge.validation_start", {
      sessionName,
      scriptPath,
      worktreePath,
    });

    try {
      await execFileAsync(scriptPath, [], {
        cwd: worktreePath,
        env: {
          ...buildChildEnv(),
          PROJECT_ROOT: projectPath,
          CLAUDE_PROJECT_DIR: projectPath,
          WORKTREE_PATH: worktreePath,
          SESSION_NAME: sessionName,
          BRANCH_NAME: branchName,
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      const childErr = err as Error & { stderr?: string; stdout?: string };
      const rawOutput = [childErr.stderr?.trim(), childErr.stdout?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
      const newErr = new Error("Pre-merge validation failed");
      (newErr as Error & { gitOutput?: string }).gitOutput =
        rawOutput || undefined;
      throw newErr;
    }

    // Auto-commit any changes the script made (e.g. prettier/eslint auto-fixes)
    if (await hasUncommittedChanges(worktreePath)) {
      logger.info("pre-merge.auto_commit_fixes", {
        sessionName,
        worktreePath,
      });
      await commitChanges(worktreePath, "auto-fix: pre-merge validation", {
        skipHooks: true,
      });
    }

    logger.info("pre-merge.validation_complete", { sessionName });
  }

  return { readRepoConfig, runPreMergeValidation };
}

// ============================================================
// Default singleton for backward compatibility
// ============================================================

const defaultInstance = createRepoConfig();

export const readRepoConfig = defaultInstance.readRepoConfig;
export const runPreMergeValidation = defaultInstance.runPreMergeValidation;
