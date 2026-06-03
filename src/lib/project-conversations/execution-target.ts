import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { getCurrentBranch } from "@/lib/git/commits";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";

export interface ProjectExecutionTargetDeps {
  /** Current branch of the repo-root checkout; null on detached HEAD. */
  getCurrentBranch(repoRootPath: string): Promise<string | null>;
  /** Short SHA of HEAD, used to label the target on detached HEAD. */
  getHeadShortSha(repoRootPath: string): Promise<string | null>;
}

/**
 * Resolve the repo-root `ExecutionTarget` for a project conversation. The
 * project's main worktree IS the repo-root checkout (`projectPath`), so this
 * binds `worktreePath = projectPath` and never creates a branch or worktree.
 * On detached HEAD it labels the branch `detached@<shortSha>` and still yields
 * a well-formed target (a project turn must never be blocked).
 */
export function createProjectExecutionTargetResolver(
  deps: ProjectExecutionTargetDeps,
): { resolve(projectPath: string): Promise<ExecutionTarget> } {
  return {
    async resolve(projectPath: string): Promise<ExecutionTarget> {
      const branch = await deps.getCurrentBranch(projectPath);
      let branchName: string;
      if (branch !== null && branch.length > 0) {
        branchName = branch;
      } else {
        const sha = await deps.getHeadShortSha(projectPath);
        branchName = `detached@${sha ?? "unknown"}`;
      }
      return {
        worktreePath: projectPath,
        branchName,
        isolation: "worktree",
        laneId: null,
      };
    },
  };
}

function makeDefaultDeps(
  client: GitClient = defaultGitClient,
): ProjectExecutionTargetDeps {
  return {
    getCurrentBranch,
    async getHeadShortSha(repoRootPath: string): Promise<string | null> {
      try {
        const { stdout } = await client.git(
          ["rev-parse", "--short", "HEAD"],
          repoRootPath,
        );
        const trimmed = stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
  };
}

const defaultResolver = createProjectExecutionTargetResolver(makeDefaultDeps());

/** Production resolver wired to the default git client. */
export function resolveProjectExecutionTarget(
  projectPath: string,
): Promise<ExecutionTarget> {
  return defaultResolver.resolve(projectPath);
}
