import type { SessionState } from "@/lib/sessions/schemas";
import { getSession } from "@/lib/state-store";
import { createLogger } from "@/lib/logging";

const logger = createLogger("git-merge-target");

export interface MergeTarget {
  targetBranch: string;
  targetWorktreePath: string | null;
}

export interface MergeTargetDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
}

/**
 * Resolves the merge target for a session: the branch to merge into and,
 * when targeting a non-main branch, the parent session's worktree path
 * where the merge must run.
 */
export function createMergeTargetResolver(deps: MergeTargetDeps) {
  return async function resolveMergeTarget(
    projectPath: string,
    session: SessionState,
  ): Promise<MergeTarget> {
    const targetBranch = session.targetBranch ?? "main";

    if (targetBranch === "main" || !session.parentSessionName) {
      return { targetBranch, targetWorktreePath: null };
    }

    const parentSession = await deps.getSession(
      projectPath,
      session.parentSessionName,
    );
    const targetWorktreePath = parentSession?.worktreePath ?? null;

    logger.debug("merge_target_resolved", {
      projectPath,
      sessionName: session.sessionName,
      targetBranch,
      parentSessionName: session.parentSessionName,
      parentSessionFound: parentSession !== null,
      targetWorktreePath,
    });

    return { targetBranch, targetWorktreePath };
  };
}

export const resolveMergeTarget = createMergeTargetResolver({ getSession });
