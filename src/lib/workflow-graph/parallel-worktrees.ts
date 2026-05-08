import { existsSync as defaultExistsSync } from "node:fs";
import path from "node:path";
import { defaultGitClient, type GitClient } from "@/lib/git-client";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/errors";

const logger = createLogger("graph-workflow-parallel-worktrees");

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface ProvisionInput {
  projectPath: string;
  sessionDir: string;
  sessionBranch: string;
  contextId: string;
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

export interface ParallelWorktrees {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  provisionBatch(inputs: ProvisionInput[]): Promise<ProvisionResult[]>;
  dispose(input: DisposeInput): Promise<DisposeResult>;
}

export interface ParallelWorktreesDeps {
  gitClient?: GitClient;
  existsSync?: (p: string) => boolean;
}

export function validateContextId(contextId: string): void {
  if (!CONTEXT_ID_PATTERN.test(contextId)) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(contextId)}: must match /^[A-Za-z0-9_.-]+$/`,
    );
  }
  if (contextId.startsWith(".") || contextId.startsWith("-")) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(contextId)}: must not start with '.' or '-'`,
    );
  }
  if (contextId.includes("..")) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(contextId)}: must not contain '..'`,
    );
  }
  if (contextId.endsWith(".") || contextId.endsWith("-")) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(contextId)}: must not end with '.' or '-'`,
    );
  }
  if (contextId.endsWith(".lock")) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(contextId)}: must not end with '.lock'`,
    );
  }
}

function deriveTargets(input: ProvisionInput): ProvisionResult {
  const worktreePath = path.join(
    input.projectPath,
    ".worktrees",
    `${input.sessionDir}.${input.contextId}`,
  );
  const branchName = `csm/${input.sessionDir}-${input.contextId}`;
  return { worktreePath, branchName };
}

export function createParallelWorktrees(
  deps: ParallelWorktreesDeps = {},
): ParallelWorktrees {
  const gitClient = deps.gitClient ?? defaultGitClient;
  const existsSync = deps.existsSync ?? defaultExistsSync;

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

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    validateContextId(input.contextId);
    const targets = deriveTargets(input);

    if (existsSync(targets.worktreePath)) {
      const existingBranch = await getBranchForWorktree(
        input.projectPath,
        targets.worktreePath,
      );
      if (existingBranch === targets.branchName) {
        logger.info("provision_idempotent", {
          projectPath: input.projectPath,
          sessionDir: input.sessionDir,
          contextId: input.contextId,
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
      contextId: input.contextId,
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

    return targets;
  }

  async function provisionBatch(
    inputs: ProvisionInput[],
  ): Promise<ProvisionResult[]> {
    for (const input of inputs) {
      validateContextId(input.contextId);
    }
    const created: ProvisionResult[] = [];
    const createdInputs: ProvisionInput[] = [];
    try {
      for (const input of inputs) {
        const result = await provision(input);
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
        const targets = deriveTargets(input);
        await dispose({
          projectPath: input.projectPath,
          worktreePath: targets.worktreePath,
          branchName: targets.branchName,
        });
      }
      throw err;
    }
  }

  async function dispose(input: DisposeInput): Promise<DisposeResult> {
    let removeError: unknown = null;
    try {
      await gitClient.git(
        ["worktree", "remove", "--force", input.worktreePath],
        input.projectPath,
      );
    } catch (err) {
      removeError = err;
      try {
        await gitClient.git(["worktree", "prune"], input.projectPath);
      } catch (pruneErr) {
        logger.warn("dispose_prune_failed", {
          worktreePath: input.worktreePath,
          reason: getErrorMessage(pruneErr),
        });
      }
    }

    if (removeError) {
      const reason = getErrorMessage(removeError);
      logger.warn("dispose_failed", {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        phase: "worktree_remove",
        reason,
      });
      return { status: "failed", reason };
    }

    try {
      await gitClient.git(
        ["branch", "-D", input.branchName],
        input.projectPath,
      );
    } catch (err) {
      const reason = getErrorMessage(err);
      logger.warn("dispose_failed", {
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        phase: "branch_delete",
        reason,
      });
      try {
        await gitClient.git(["worktree", "prune"], input.projectPath);
      } catch (pruneErr) {
        logger.warn("dispose_prune_failed", {
          branchName: input.branchName,
          reason: getErrorMessage(pruneErr),
        });
      }
      return { status: "failed", reason };
    }

    logger.info("dispose_removed", {
      worktreePath: input.worktreePath,
      branchName: input.branchName,
    });
    return { status: "removed" };
  }

  return { provision, provisionBatch, dispose };
}
