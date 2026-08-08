import { existsSync as defaultExistsSync } from "node:fs";
import path from "node:path";
import { buildChildEnv as defaultBuildChildEnv } from "@/lib/shared/child-env";
import {
  execFile as timedExecFile,
  type ExecFileOptions,
} from "@/lib/shared/exec";
import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { fastRemoveWorktree as defaultFastRemoveWorktree } from "@/lib/git/worktree-fast-remove";
import { stopAllForWorktree as defaultStopAllForWorktree } from "@/lib/dev-server/registry";
import { createLogger, type Logger } from "@/lib/logging";
import { timed } from "@/lib/logging/timed";
import { getErrorMessage } from "@/lib/shared/errors";
import { readRepoConfig as defaultReadRepoConfig } from "@/lib/projects/repo-config";
import { readConfig as defaultReadGlobalConfig } from "@/lib/config/loader";
import { resolveBranchPrefix } from "@/lib/config/cascade";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { parseDirtyPaths } from "@/lib/git/worktree";
import type { DirtyPath } from "@/lib/workflow-graph/errors";
import { validateLaneId } from "@/lib/workflow-graph/lane-identity";

type ExecFileAsync = (
  cmd: string,
  args: string[],
  opts?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFileAsync: ExecFileAsync = (cmd, args, opts) =>
  timedExecFile(cmd, args, { ...opts, eventPrefix: "init-script" });

const defaultLogger = createLogger("graph-workflow-parallel-worktrees");

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
  /**
   * Lane branch recorded at provision time (persisted lane state). Cleanup
   * prefers the worktree's actual branch when the worktree still exists; this
   * value covers the worktree-already-gone case. Branch-prefix configuration
   * is never consulted at cleanup time — it can change between provision and
   * cleanup, which would target a branch the lane never lived on.
   */
  branchName?: string | null;
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
   * Remove the lane worktree and lane branch for a lane/context id. A merged
   * lane's content lives on the session branch, so both artifacts are
   * disposable once the lane's contexts have merged. The branch to delete is
   * resolved from the live worktree (or the persisted `branchName`), never
   * from the branch-prefix configuration.
   */
  cleanupLane(input: CleanupLaneInput): Promise<DisposeResult>;
}

export interface ParallelWorktreesDeps {
  gitClient?: GitClient;
  existsSync?: (p: string) => boolean;
  readRepoConfig?(repoRoot: string): Promise<PerRepoConfig | null>;
  readGlobalConfig?(): Promise<Pick<GlobalConfig, "branchPrefix">>;
  execFileAsync?: ExecFileAsync;
  buildChildEnv?(): NodeJS.ProcessEnv;
  logger?: Logger;
  fastRemoveWorktree?: typeof defaultFastRemoveWorktree;
  /**
   * Stop any CC-managed dev servers running in a worktree. Invoked before a
   * worktree is removed (stop-before-remove) so lane dev servers never outlive
   * their worktree. Defaults to the dev-server registry's worktree-scoped stop.
   */
  stopDevServersForWorktree?(input: {
    projectPath: string;
    worktreePath: string;
  }): Promise<void>;
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
  branchPrefix: string;
}): ProvisionResult {
  const worktreePath = deriveLaneWorktreePath(input);
  const unprefixed = `${input.sessionDir}-${input.laneId}`;
  const branchName = input.branchPrefix
    ? `${input.branchPrefix}/${unprefixed}`
    : unprefixed;
  return { worktreePath, branchName };
}

/**
 * Compute the lane worktree path from lane identity alone. Unlike the branch
 * name, the worktree path is independent of the branch-prefix configuration,
 * so cleanup can derive it without consulting config.
 */
export function deriveLaneWorktreePath(input: {
  projectPath: string;
  sessionDir: string;
  laneId: string;
}): string {
  return path.join(
    input.projectPath,
    ".worktrees",
    `${input.sessionDir}.${input.laneId}`,
  );
}

export function createParallelWorktrees(
  deps: ParallelWorktreesDeps = {},
): ParallelWorktrees {
  const gitClient = deps.gitClient ?? defaultGitClient;
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const readRepoConfig = deps.readRepoConfig ?? defaultReadRepoConfig;
  const readGlobalConfig = deps.readGlobalConfig ?? defaultReadGlobalConfig;
  const execFileAsync = deps.execFileAsync ?? defaultExecFileAsync;
  const buildChildEnv = deps.buildChildEnv ?? defaultBuildChildEnv;
  const logger = deps.logger ?? defaultLogger;
  const fastRemoveWorktree =
    deps.fastRemoveWorktree ?? defaultFastRemoveWorktree;
  const stopDevServersForWorktree =
    deps.stopDevServersForWorktree ?? defaultStopAllForWorktree;

  async function resolveLaneBranchPrefix(projectPath: string): Promise<string> {
    const [globalConfig, repoConfig] = await Promise.all([
      readGlobalConfig(),
      readRepoConfig(projectPath),
    ]);
    const branchPrefix = resolveBranchPrefix(globalConfig, repoConfig);
    logger.debug("branch_prefix_resolved", { projectPath, branchPrefix });
    return branchPrefix;
  }

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
      branchPrefix: await resolveLaneBranchPrefix(input.projectPath),
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
      for (const [index, input] of createdInputs.entries()) {
        const targets = created[index];
        if (!targets) continue;
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

  /**
   * Internal dispose target: unlike the public DisposeInput, the branch is
   * nullable so lane cleanup can remove a worktree whose branch could not be
   * resolved without guessing one from configuration.
   */
  interface DisposeTarget {
    projectPath: string;
    worktreePath: string;
    branchName: string | null;
  }

  async function dispose(input: DisposeInput): Promise<DisposeResult> {
    return disposeTarget(input);
  }

  async function disposeTarget(input: DisposeTarget): Promise<DisposeResult> {
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

  async function disposeImpl(input: DisposeTarget): Promise<DisposeResult> {
    // Stop dev servers running in this worktree before removing it, so the
    // directory is never pruned out from under a live process. Best-effort:
    // a failed stop must not block worktree removal.
    try {
      await stopDevServersForWorktree({
        projectPath: input.projectPath,
        worktreePath: input.worktreePath,
      });
    } catch (err) {
      logger.warn("dispose_stop_dev_servers_failed", {
        worktreePath: input.worktreePath,
        reason: getErrorMessage(err),
      });
    }

    try {
      await fastRemoveWorktree({
        projectPath: input.projectPath,
        worktreePath: input.worktreePath,
        branchName: input.branchName ?? undefined,
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

  /**
   * Resolve which branch a lane cleanup should delete. The worktree's actual
   * branch (git ground truth) wins when the worktree still exists; otherwise
   * the branch persisted at provision time is used. Configuration is
   * intentionally not a fallback — the branch prefix is mutable, so a
   * config-derived name can point at a branch the lane never lived on.
   */
  async function resolveLaneCleanupBranch(
    input: CleanupLaneInput,
    worktreePath: string,
  ): Promise<{
    branchName: string | null;
    source: "worktree" | "persisted" | null;
  }> {
    if (existsSync(worktreePath)) {
      const actual = await getBranchForWorktree(
        input.projectPath,
        worktreePath,
      );
      if (actual !== null) return { branchName: actual, source: "worktree" };
    }
    if (input.branchName != null && input.branchName !== "") {
      return { branchName: input.branchName, source: "persisted" };
    }
    return { branchName: null, source: null };
  }

  async function cleanupLane(input: CleanupLaneInput): Promise<DisposeResult> {
    validateLaneId(input.contextId);
    const worktreePath = deriveLaneWorktreePath({
      projectPath: input.projectPath,
      sessionDir: input.sessionDir,
      laneId: input.contextId,
    });
    const { branchName, source } = await resolveLaneCleanupBranch(
      input,
      worktreePath,
    );
    if (branchName === null) {
      logger.warn("lane.cleanup_branch_unresolved", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        worktreePath,
      });
    } else {
      logger.debug("lane.cleanup_branch_resolved", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        worktreePath,
        branch: branchName,
        source,
      });
    }
    const result = await disposeTarget({
      projectPath: input.projectPath,
      worktreePath,
      branchName,
    });
    if (result.status === "removed") {
      logger.info("lane.cleaned", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        branch: branchName,
        branchSource: source,
        worktreePath,
      });
    } else {
      logger.warn("lane.cleanup_failed", {
        sessionName: input.sessionName,
        contextId: input.contextId,
        branch: branchName,
        branchSource: source,
        worktreePath,
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
