import { getErrorMessage } from "@/lib/errors";
import {
  commitChanges as defaultCommitChanges,
  hasUncommittedChanges as defaultHasUncommittedChanges,
} from "@/lib/git-operations";
import { createLogger } from "@/lib/logging";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionLaneCommitSnapshot,
} from "@/types";

const logger = createLogger("graph-workflow-lane-commit");

export interface LaneCommitterInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  laneId: string;
  laneWorktreePath: string;
}

export type LaneCommitterResult =
  | { status: "committed"; snapshot: GraphWorkflowExecutionLaneCommitSnapshot }
  | { status: "skipped" }
  | { status: "failed"; errorMessage: string };

export interface LaneCommitter {
  commit(input: LaneCommitterInput): Promise<LaneCommitterResult>;
}

export interface LaneCommitterDeps {
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
  now(): string;
}

export function createLaneCommitter(
  deps: LaneCommitterDeps = {
    hasUncommittedChanges: defaultHasUncommittedChanges,
    commitChanges: defaultCommitChanges,
    now: () => new Date().toISOString(),
  },
): LaneCommitter {
  return {
    async commit(input) {
      const { projectPath, sessionName, contextId, laneId, laneWorktreePath } =
        input;

      const hasChanges = await deps.hasUncommittedChanges(laneWorktreePath);
      if (!hasChanges) {
        logger.info("graph-workflow.lane_commit.skipped", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
        });
        return { status: "skipped" };
      }

      const message = `Graph workflow context ${contextId}`;
      logger.info("graph-workflow.lane_commit.started", {
        projectPath,
        sessionName,
        contextId,
        laneId,
        laneWorktreePath,
      });
      try {
        const { hash } = await deps.commitChanges(laneWorktreePath, message, {
          skipHooks: true,
        });
        const snapshot: GraphWorkflowExecutionLaneCommitSnapshot = {
          contextId,
          sha: hash,
          committedAt: deps.now(),
        };
        logger.info("graph-workflow.lane_commit.completed", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
          hash,
          committedAt: snapshot.committedAt,
        });
        return { status: "committed", snapshot };
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        logger.error("graph-workflow.lane_commit.failed", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
          error: errorMessage,
        });
        return { status: "failed", errorMessage };
      }
    },
  };
}

/**
 * Append a commit snapshot to the lane's audit history and update its
 * lastCommittingContextId / updatedAt. Pure: returns a new execution object
 * without mutating the input.
 *
 * The snapshot list is an audit/recovery record only. Git remains the
 * authoritative source for the lane's current HEAD — recovery code must
 * read the current branch state from git, not derive it from the snapshot
 * list, since snapshots can lag behind or omit external commits.
 */
export function applyLaneCommitSnapshot(
  execution: GraphWorkflowExecution,
  laneId: string,
  snapshot: GraphWorkflowExecutionLaneCommitSnapshot,
): GraphWorkflowExecution {
  const lane = execution.executionLanes[laneId];
  if (!lane) {
    throw new Error(
      `applyLaneCommitSnapshot: lane ${JSON.stringify(
        laneId,
      )} not found in execution.executionLanes (executionId=${execution.id})`,
    );
  }

  const includedContextIds = lane.includedContextIds.includes(
    snapshot.contextId,
  )
    ? lane.includedContextIds
    : [...lane.includedContextIds, snapshot.contextId];

  return {
    ...execution,
    executionLanes: {
      ...execution.executionLanes,
      [laneId]: {
        ...lane,
        commitSnapshots: [...lane.commitSnapshots, snapshot],
        lastCommittingContextId: snapshot.contextId,
        updatedAt: snapshot.committedAt,
        includedContextIds,
      },
    },
  };
}
