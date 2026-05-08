import { getErrorMessage } from "@/lib/errors";
import {
  commitChanges as defaultCommitChanges,
  hasUncommittedChanges as defaultHasUncommittedChanges,
} from "@/lib/git-operations";
import { createLogger } from "@/lib/logging";

const logger = createLogger("graph-workflow-solo-commit");

export interface SoloContextCommitterInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  sessionWorktreePath: string;
}

export type SoloContextCommitterResult =
  | { status: "committed"; hash: string }
  | { status: "skipped" }
  | { status: "failed"; errorMessage: string };

export interface SoloContextCommitter {
  commit(input: SoloContextCommitterInput): Promise<SoloContextCommitterResult>;
}

export interface SoloContextCommitterDeps {
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
}

export function createSoloContextCommitter(
  deps: SoloContextCommitterDeps = {
    hasUncommittedChanges: defaultHasUncommittedChanges,
    commitChanges: defaultCommitChanges,
  },
): SoloContextCommitter {
  return {
    async commit(input) {
      const { projectPath, sessionName, contextId, sessionWorktreePath } =
        input;

      const hasChanges = await deps.hasUncommittedChanges(sessionWorktreePath);
      if (!hasChanges) {
        logger.info("graph-workflow.solo_commit.skipped", {
          projectPath,
          sessionName,
          contextId,
          sessionWorktreePath,
        });
        return { status: "skipped" };
      }

      const message = `Graph workflow context ${contextId}`;
      logger.info("graph-workflow.solo_commit.started", {
        projectPath,
        sessionName,
        contextId,
        sessionWorktreePath,
      });
      try {
        const { hash } = await deps.commitChanges(
          sessionWorktreePath,
          message,
          { skipHooks: true },
        );
        logger.info("graph-workflow.solo_commit.completed", {
          projectPath,
          sessionName,
          contextId,
          sessionWorktreePath,
          hash,
        });
        return { status: "committed", hash };
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        logger.error("graph-workflow.solo_commit.failed", {
          projectPath,
          sessionName,
          contextId,
          sessionWorktreePath,
          error: errorMessage,
        });
        return { status: "failed", errorMessage };
      }
    },
  };
}
