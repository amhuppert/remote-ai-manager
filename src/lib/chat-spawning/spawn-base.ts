import { defaultGitClient, type GitClient } from "@/lib/git/client";

/**
 * Resolve the base ref a chat-spawned session's branch starts from. The base is
 * the project main worktree's **committed HEAD** — never the working tree — so a
 * worktree created from it (`git worktree add -b <branch> <path> <baseRef>`)
 * carries no uncommitted edits.
 */
export interface SpawnBaseDeps {
  /** Committed HEAD of the repo root — a commit-ish, never a working-tree ref. */
  getHeadRef(repoRootPath: string): Promise<string>;
}

export function createSpawnBaseResolver(deps: SpawnBaseDeps): {
  resolveCommittedHeadBase(projectPath: string): Promise<string>;
} {
  return {
    async resolveCommittedHeadBase(projectPath: string): Promise<string> {
      const ref = (await deps.getHeadRef(projectPath)).trim();
      if (ref.length === 0) {
        throw new Error(
          `Could not resolve committed HEAD for project at ${projectPath}`,
        );
      }
      return ref;
    },
  };
}

/**
 * Production `getHeadRef`: `git rev-parse HEAD` resolves the committed HEAD to a
 * SHA. A SHA is committed by definition, so branching from it never copies the
 * main worktree's uncommitted changes.
 */
export function createGitHeadRef(
  gitClient: GitClient = defaultGitClient,
): SpawnBaseDeps["getHeadRef"] {
  return async (repoRootPath: string): Promise<string> => {
    const result = await gitClient.git(["rev-parse", "HEAD"], repoRootPath);
    return result.stdout.trim();
  };
}

const defaultSpawnBaseResolver = createSpawnBaseResolver({
  getHeadRef: createGitHeadRef(),
});

export const resolveCommittedHeadBase =
  defaultSpawnBaseResolver.resolveCommittedHeadBase;
