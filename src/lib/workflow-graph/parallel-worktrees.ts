import { existsSync as defaultExistsSync } from "node:fs";
import path from "node:path";
import { buildChildEnv as defaultBuildChildEnv } from "@/lib/shared/child-env";
import {
  execFile as timedExecFile,
  type ExecFileOptions,
} from "@/lib/shared/exec";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { fastRemoveWorktree as defaultFastRemoveWorktree } from "@/lib/git/worktree-fast-remove";
import { createLogger, type Logger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { getErrorMessage } from "@/lib/shared/errors";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import type { PerRepoConfig } from "@/lib/config/schemas";
import { parseDirtyPaths } from "@/lib/git/worktree";
import type { DirtyPath } from "@/lib/workflow-graph/errors";

type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFileAsync: ExecFileAsync = (cmd, args, opts) =>
  timedExecFile(cmd, args, { ...opts, eventPrefix: "init-script" });

const defaultLogger = createLogger("graph-workflow-parallel-worktrees");

const LANE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface ProvisionInput {
  projectPath: string;
  sessionName: string;
  sessionDir: string;
  sessionBranch: string;
  contextId: string;
}

export interface ProvisionLaneInput {
  projectPath: string;
  sessionName: string;
  sessionDir: string;
  sessionBranch: string;
  laneId: string;
}

export interface ProvisionResult {
  worktreePath: string;
  branchName: string;
}

export interface DisposeInput {
  projectPath: string;
  worktreePath: string;
  branchName: string;
}

export type DisposeResult =
  | { status: "removed" }
  | { status: "failed"; reason: string };

export interface CleanupLaneInput {
  projectPath: string;
  sessionName: string;
  sessionDir: string;
  contextId: string;
}

export interface ParallelWorktrees {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  provisionBatch(inputs: ProvisionInput[]): Promise<ProvisionResult[]>;
  dispose(input: DisposeInput): Promise<DisposeResult>;
  /** Provision a worktree for a stable lane id (generalization of provision). */
  provisionLane(input: ProvisionLaneInput): Promise<ProvisionResult>;
  /** Provision a batch of lane worktrees, rolling back on failure. */
  provisionLaneBatch(inputs: ProvisionLaneInput[]): Promise<ProvisionResult[]>;
  /** Dispose a lane worktree. Identical disk-side semantics to dispose. */
  disposeLane(input: DisposeInput): Promise<DisposeResult>;
  /**
   * Remove the lane worktree and lane branch derived from a lane/context id.
   * A merged lane's content lives on the session branch, so both artifacts
   * are disposable once the lane's contexts have merged.
   */
  cleanupLane(input: CleanupLaneInput): Promise<DisposeResult>;
}

export interface ParallelWorktreesDeps {
  gitClient?: GitClient;
  existsSync?: (p: string) => boolean;
  readRepoConfig?(repoRoot: string): Promise<PerRepoConfig | null>;
  execFileAsync?: ExecFileAsync;
  buildChildEnv?(): NodeJS.ProcessEnv;
  logger?: Logger;
  fastRemoveWorktree?: typeof defaultFastRemoveWorktree;
}

/**
 * Validate that a lane id is safe to splice into a git branch name and a
 * filesystem path. Lane ids and per-context ids share the same constraints —
 * one-context lanes have laneId === contextId, so this single validator
 * covers both. The validator is exported under a context-named alias so
 * existing callers continue to compile while the workflow generalizes to
 * lanes.
 */
export function validateLaneId(laneId: string): void {
  if (!LANE_ID_PATTERN.test(laneId)) {
    throw new Error(
      `Invalid laneId ${JSON.stringify(laneId)}: must match /^[A-Za-z0-9_.-]+$/`,
    );
  }
  if (laneId.startsWith(".") || laneId.startsWith("-")) {
    throw new Error(
      `Invalid laneId ${JSON.stringify(laneId)}: must not start with '.' or '-'`,
    );
  }
  if (laneId.includes("..")) {
    throw new Error(
      `Invalid laneId ${JSON.stringify(laneId)}: must not contain '..'`,
    );
  }
  if (laneId.endsWith(".") || laneId.endsWith("-")) {
    throw new Error(
      `Invalid laneId ${JSON.stringify(laneId)}: must not end with '.' or '-'`,
    );
  }
  if (laneId.endsWith(".lock")) {
    throw new Error(
      `Invalid laneId ${JSON.stringify(laneId)}: must not end with '.lock'`,
    );
  }
}

/** Backward-compatible alias retained while callers migrate to validateLaneId. */
export function validateContextId(contextId: string): void {
  try {
    validateLaneId(contextId);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(err.message.replace(/laneId/g, "contextId"));
    }
    throw err;
  }
}

/**
 * Compute deterministic, lane-stable branch and worktree paths from a lane id.
 * Per-context worktrees in single-context lanes use laneId === contextId, so
 * the names match the prior per-context derivation byte-for-byte. Pure helper
 * — no git or filesystem side effects.
 */
export function deriveLaneTargets(input: {
  projectPath: string;
  sessionDir: string;
  laneId: string;
}): ProvisionResult {
  const worktreePath = path.join(
    input.projectPath,
    ".worktrees",
    `${input.sessionDir}.${input.laneId}`,
  );
  const branchName = `csm/${input.sessionDir}-${input.laneId}`;
  return { worktreePath, branchName };
}

export function createParallelWorktrees(
  deps: ParallelWorktreesDeps = {},
): ParallelWorktrees {
  const gitClient = deps.gitClient ?? defaultGitClient;
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const readRepoConfig = deps.readRepoConfig ?? defaultReadRepoConfig;
  const execFileAsync = deps.execFileAsync ?? defaultExecFileAsync;
  const buildChildEnv = deps.buildChildEnv ?? defaultBuildChildEnv;
  const logger = deps.logger ?? defaultLogger;
  const fastRemoveWorktree =
    deps.fastRemoveWorktree ?? defaultFastRemoveWorktree;

  async function getBranchForWorktree(
    projectPath: string,
    worktreePath: string,
  ): Promise<string | null> {
    const { stdout } = await gitClient.git(
      ["worktree", "list", "--porcelain"],
      projectPath,
    );
    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split("\n");
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      if (!wtLine) continue;
      const wtPath = wtLine.slice("worktree ".length).trim();
      if (path.resolve(wtPath) !== path.resolve(worktreePath)) continue;
      const branchLine = lines.find((l) => l.startsWith("branch "));
      if (!branchLine) return null;
      const ref = branchLine.slice("branch ".length).trim();
      const prefix = "refs/heads/";
      return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
    }
    return null;
  }

  async function provisionLane(
    input: ProvisionLaneInput,
  ): Promise<ProvisionResult> {
    validateLaneId(input.laneId);
    const targets = deriveLaneTargets({
      projectPath: input.projectPath,
      sessionDir: input.sessionDir,
      laneId: input.laneId,
    });
    return timed(
      logger,
      "worktree.create",
      {
        laneId: input.laneId,
        worktreePath: targets.worktreePath,
        branchName: targets.branchName,
      },
      () => provisionLaneImpl(input, targets),
    );
  }

  async function provisionLaneImpl(
    input: ProvisionLaneInput,
    targets: ProvisionResult,
  ): Promise<ProvisionResult> {
    if (existsSync(targets.worktreePath)) {
      const existingBranch = await getBranchForWorktree(
        input.projectPath,
        targets.worktreePath,
      );
      if (existingBranch === targets.branchName) {
        logger.info("provision_idempotent", {
          projectPath: input.projectPath,
          sessionDir: input.sessionDir,
          laneId: input.laneId,
          worktreePath: targets.worktreePath,
          branchName: targets.branchName,
        });
        return targets;
      }
      throw new Error(
        `Worktree at ${targets.worktreePath} already exists on branch ${
          existingBranch ?? "<unknown>"
        }, expected ${targets.branchName}`,
      );
    }

    logger.info("provision_start", {
      projectPath: input.projectPath,
      sessionDir: input.sessionDir,
      laneId: input.laneId,
      worktreePath: targets.worktreePath,
      branchName: targets.branchName,
      sessionBranch: input.sessionBranch,
    });

    await gitClient.git(
      [
        "worktree",
        "add",
        "-b",
        targets.branchName,
        targets.worktreePath,
        input.sessionBranch,
      ],
      input.projectPath,
    );

    await reportDirtyOnCreate(
      {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        laneId: input.laneId,
      },
      targets,
    );

    try {
      await runInitScript(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          sessionDir: input.sessionDir,
          laneId: input.laneId,
        },
        targets,
      );
    } catch (err) {
      await dispose({
        projectPath: input.projectPath,
        worktreePath: targets.worktreePath,
        branchName: targets.branchName,
      });
      throw err;
    }

    return targets;
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    return provisionLane({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      sessionDir: input.sessionDir,
      sessionBranch: input.sessionBranch,
      laneId: input.contextId,
    });
  }

  interface InitScriptContext {
    projectPath: string;
    sessionName: string;
    sessionDir: string;
    laneId: string;
  }

  async function runInitScript(
    context: InitScriptContext,
    targets: ProvisionResult,
  ): Promise<void> {
    const repoConfig = await readRepoConfig(context.projectPath);
    if (!repoConfig?.initScriptPath) {
      return;
    }

    const scriptPath = path.isAbsolute(repoConfig.initScriptPath)
      ? repoConfig.initScriptPath
      : path.join(context.projectPath, repoConfig.initScriptPath);

    if (!existsSync(scriptPath)) {
      throw new Error(`Init script not found: ${scriptPath}`);
    }

    // A lane worktree is branched from the session branch, so the worktree it
    // was branched from is the session's own worktree at `.worktrees/<dir>`.
    const parentWorktreePath = path.join(
      context.projectPath,
      ".worktrees",
      context.sessionDir,
    );

    logger.info("init_script_start", {
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      laneId: context.laneId,
      worktreePath: targets.worktreePath,
      parentWorktreePath,
      scriptPath,
    });

    try {
      await execFileAsync(scriptPath, [], {
        cwd: targets.worktreePath,
        env: {
          ...buildChildEnv(),
          PROJECT_ROOT: context.projectPath,
          CLAUDE_PROJECT_DIR: context.projectPath,
          WORKTREE_PATH: targets.worktreePath,
          PARENT_WORKTREE_PATH: parentWorktreePath,
          SESSION_NAME: context.sessionName,
          BRANCH_NAME: targets.branchName,
          // Per-context init scripts read CONTEXT_ID. For multi-context lanes,
          // the lane id is set instead so init can branch on lane identity.
          CONTEXT_ID: context.laneId,
          LANE_ID: context.laneId,
        } as NodeJS.ProcessEnv,
      });
    } catch (err) {
      logger.warn("init_script_failed", {
        projectPath: context.projectPath,
        sessionName: context.sessionName,
        laneId: context.laneId,
        scriptPath,
        reason: getErrorMessage(err),
      });
      throw err;
    }

    logger.info("init_script_complete", {
      projectPath: context.projectPath,
      sessionName: context.sessionName,
      laneId: context.laneId,
      scriptPath,
    });
  }

  /**
   * Detect-only post-create cleanliness probe. A freshly-provisioned worktree
   * should always start clean; on APFS we have evidence that `clonefile()` can
   * leave residual modified-time on tracked files which `git status` then
   * reports as modified. We log but do not throw — gathering production
   * evidence before shipping repair logic.
   */
  async function reportDirtyOnCreate(
    context: { projectPath: string; sessionName: string; laneId: string },
    targets: ProvisionResult,
  ): Promise<void> {
    let dirtyPaths: DirtyPath[];
    try {
      const { stdout } = await gitClient.git(
        ["status", "--porcelain"],
        targets.worktreePath,
      );
      dirtyPaths = parseDirtyPaths(stdout);
    } catch (err) {
      logger.warn("provision_dirty_check_failed", {
        worktreePath: targets.worktreePath,
        branchName: targets.branchName,
        laneId: context.laneId,
        contextId: context.laneId,
        error: getErrorMessage(err),
      });
      return;
    }
    if (dirtyPaths.length === 0) return;
    logger.warn("provision_dirty_after_create", {
      projectPath: context.projectPath,
      worktreePath: targets.worktreePath,
      branchName: targets.branchName,
      laneId: context.laneId,
      contextId: context.laneId,
      dirtyCount: dirtyPaths.length,
      dirtyPaths: dirtyPaths.slice(0, 5),
    });
  }

  async function provisionLaneBatch(
    inputs: ProvisionLaneInput[],
  ): Promise<ProvisionResult[]> {
    for (const input of inputs) {
      validateLaneId(input.laneId);
    }
    const created: ProvisionResult[] = [];
    const createdInputs: ProvisionLaneInput[] = [];
    try {
      for (const input of inputs) {
        const result = await provisionLane(input);
        created.push(result);
        createdInputs.push(input);
      }
      return created;
    } catch (err) {
      logger.warn("provision_batch_rollback", {
        rolledBack: createdInputs.length,
        reason: getErrorMessage(err),
      });
      for (const input of createdInputs) {
        const targets = deriveLaneTargets({
          projectPath: input.projectPath,
          sessionDir: input.sessionDir,
          laneId: input.laneId,
        });
        await dispose({
          projectPath: input.projectPath,
          worktreePath: targets.worktreePath,
          branchName: targets.branchName,
        });
      }
      throw err;
    }
  }

  async function provisionBatch(
    inputs: ProvisionInput[],
  ): Promise<ProvisionResult[]> {
    return provisionLaneBatch(
      inputs.map((input) => ({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        sessionDir: input.sessionDir,
        sessionBranch: input.sessionBranch,
        laneId: input.contextId,
      })),
    );
  }

  async function dispose(input: DisposeInput): Promise<DisposeResult> {
    return timed(
      logger,
      "worktree.remove",
      {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
      },
      () => disposeImpl(input),
      (result) => ({ status: result.status }),
    );
  }

  async function disposeImpl(input: DisposeInput): Promise<DisposeResult> {
    try {
      await fastRemoveWorktree({
        projectPath: input.projectPath,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
      });
    } catch (err) {
      const reason = getErrorMessage(err);
      logger.warn("dispose_failed", {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        phase: "worktree_remove",
        reason,
      });
      return { status: "failed", reason };
    }

    logger.info("dispose_removed", {
      worktreePath: input.worktreePath,
      branchName: input.branchName,
    });
    return { status: "removed" };
  }

  async function disposeLane(input: DisposeInput): Promise<DisposeResult> {
    return dispose(input);
  }

  async function cleanupLane(input: CleanupLaneInput): Promise<DisposeResult> {
    validateLaneId(input.contextId);
    const targets = deriveLaneTargets({
      projectPath: input.projectPath,
      sessionDir: input.sessionDir,
      laneId: input.contextId,
    });
    const result = await dispose({
      projectPath: input.projectPath,
      worktreePath: targets.worktreePath,
      branchName: targets.branchName,
    });
    if (result.status === "removed") {
      logger.info("lane.cleaned", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        branch: targets.branchName,
        worktreePath: targets.worktreePath,
      });
    } else {
      logger.warn("lane.cleanup_failed", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        branch: targets.branchName,
        worktreePath: targets.worktreePath,
        reason: result.reason,
      });
    }
    return result;
  }

  return {
    provision,
    provisionBatch,
    dispose,
    provisionLane,
    provisionLaneBatch,
    disposeLane,
    cleanupLane,
  };
}
