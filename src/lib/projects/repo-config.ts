import { existsSync as defaultExistsSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { execFileGroup as timedExecFileGroup } from "../shared/exec";
import { buildChildEnv as defaultBuildChildEnv } from "../shared/child-env";
import { perRepoConfigSchema, type PerRepoConfig } from "../config/schemas";
import {
  hasUncommittedChanges as defaultHasUncommittedChanges,
  commitChanges as defaultCommitChanges,
} from "../git/commits";
import { createLogger } from "../logging";

const logger = createLogger("repo-config");

const defaultExecFileAsync = (
  cmd: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> =>
  // Group-aware exec: the pre-merge script forks a deep tree (npx → node →
  // vitest → one worker per core). A plain timeout would SIGTERM only the
  // shell and orphan the workers; this kills the whole process group.
  timedExecFileGroup(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
    timeout: opts?.timeout,
    maxBuffer: opts?.maxBuffer,
    eventPrefix: "pre-merge.script",
  });

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

export interface RepoValidationCommandResult {
  executed: boolean;
  pass: boolean;
  stdout: string;
  stderr: string;
  output: string;
  timedOut: boolean;
  message: string | null;
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

  function resolveValidationScriptPath(
    projectPath: string,
    preMergeCommand: string,
  ): string {
    return path.isAbsolute(preMergeCommand)
      ? preMergeCommand
      : path.join(projectPath, preMergeCommand);
  }

  async function executeRepoValidationCommand(params: {
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    timeoutMs?: number;
  }): Promise<RepoValidationCommandResult> {
    const { projectPath, worktreePath, sessionName, branchName, timeoutMs } =
      params;

    const repoConfig = await readRepoConfig(projectPath);
    if (!repoConfig?.preMergeCommand) {
      return {
        executed: false,
        pass: true,
        stdout: "",
        stderr: "",
        output: "",
        timedOut: false,
        message: null,
      };
    }

    const scriptPath = resolveValidationScriptPath(
      projectPath,
      repoConfig.preMergeCommand,
    );

    if (!existsSync(scriptPath)) {
      throw new Error(`Pre-merge validation script not found: ${scriptPath}`);
    }

    logger.info("pre-merge.validation_start", {
      sessionName,
      scriptPath,
      worktreePath,
    });

    try {
      const result = await execFileAsync(scriptPath, [], {
        cwd: worktreePath,
        env: {
          ...buildChildEnv(),
          PROJECT_ROOT: worktreePath,
          CLAUDE_PROJECT_DIR: projectPath,
          WORKTREE_PATH: worktreePath,
          SESSION_NAME: sessionName,
          BRANCH_NAME: branchName,
        },
        timeout: timeoutMs,
      });

      const stdout = result.stdout?.trim() ?? "";
      const stderr = result.stderr?.trim() ?? "";
      const output = [stderr, stdout].filter(Boolean).join("\n").trim();

      return {
        executed: true,
        pass: true,
        stdout,
        stderr,
        output,
        timedOut: false,
        message: null,
      };
    } catch (err) {
      const childErr = err as Error & {
        stderr?: string;
        stdout?: string;
        killed?: boolean;
      };
      const stderr = childErr.stderr?.trim() ?? "";
      const stdout = childErr.stdout?.trim() ?? "";
      const output = [stderr, stdout].filter(Boolean).join("\n").trim();
      const timedOut = childErr.killed === true;
      const timeoutSec = Math.round((timeoutMs ?? 0) / 1000);

      return {
        executed: true,
        pass: false,
        stdout,
        stderr,
        output,
        timedOut,
        message: timedOut
          ? `Pre-merge validation timed out after ${timeoutSec}s`
          : "Pre-merge validation failed",
      };
    }
  }

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
    const result = await executeRepoValidationCommand(params);
    if (!result.executed) {
      return;
    }

    if (!result.pass) {
      const newErr = new Error(result.message ?? "Pre-merge validation failed");
      (newErr as Error & { gitOutput?: string }).gitOutput =
        result.output || undefined;
      throw newErr;
    }

    // Auto-commit any changes the script made (e.g. prettier/eslint auto-fixes)
    if (await hasUncommittedChanges(params.worktreePath)) {
      logger.info("pre-merge.auto_commit_fixes", {
        sessionName: params.sessionName,
        worktreePath: params.worktreePath,
      });
      await commitChanges(
        params.worktreePath,
        "auto-fix: pre-merge validation",
        {
          skipHooks: true,
        },
      );
    }

    logger.info("pre-merge.validation_complete", {
      sessionName: params.sessionName,
    });
  }

  return {
    readRepoConfig,
    executeRepoValidationCommand,
    runPreMergeValidation,
  };
}

// ============================================================
// Default singleton for backward compatibility
// ============================================================

const defaultInstance = createRepoConfig();

export const readRepoConfig = defaultInstance.readRepoConfig;
export const executeRepoValidationCommand =
  defaultInstance.executeRepoValidationCommand;
export const runPreMergeValidation = defaultInstance.runPreMergeValidation;
