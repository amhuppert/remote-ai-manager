import { getErrorMessage } from "@/lib/shared/errors";
import {
  commitChanges as defaultCommitChanges,
  hasUncommittedChanges as defaultHasUncommittedChanges,
} from "@/lib/git/commits";
import { createLogger } from "@/lib/logging";
import { landingIntentTrailer } from "@/lib/workflow-graph/route-runtime";
import type { GraphWorkflowCanonicalOwnership } from "@/lib/workflow-graph/schemas";

const logger = createLogger("graph-workflow-solo-commit");

interface SoloContextCommitterInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  sessionWorktreePath: string;
  /** The dispatch-time landing token (D4 decision D8), embedded as a commit
   *  trailer so the landing is replayable from the branch alone. Null for a
   *  context dispatched before intents existed. */
  landingToken?: string | null;
  /**
   * The write envelope this context was admitted under. Only the read-only
   * grade changes anything here: the session worktree is the one substrate a
   * context can be placed on without being able to write it, so its dirt
   * belongs to the user or to a concurrent reader's siblings, never to the
   * reader whose landing is running.
   */
  ownership?: GraphWorkflowCanonicalOwnership | null;
}

type SoloContextCommitterResult =
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

      if (input.ownership?.mode === "readOnly") {
        logger.info("graph-workflow.solo_commit.read_only_skipped", {
          projectPath,
          sessionName,
          contextId,
          sessionWorktreePath,
        });
        return { status: "skipped" };
      }

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

      const message = input.landingToken
        ? `Graph workflow context ${contextId}\n\n${landingIntentTrailer(input.landingToken)}`
        : `Graph workflow context ${contextId}`;
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
