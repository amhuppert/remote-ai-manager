import { getErrorMessage } from "@/lib/shared/errors";
import {
  commitChanges as defaultCommitChanges,
  getHeadCommit as defaultGetHeadCommit,
  hasUncommittedChanges as defaultHasUncommittedChanges,
} from "@/lib/git/commits";
import { createLogger } from "@/lib/logging";
import { landingIntentTrailer } from "@/lib/workflow-graph/route-runtime";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionLaneCommitSnapshot,
} from "@/lib/workflow-graph/schemas";
const logger = createLogger("graph-workflow-lane-commit");

/**
 * Append the landing token as a commit trailer (D4 decision D8) so the landing
 * carries its own replayable evidence: reconciliation can probe the branch for
 * the token instead of trusting a runner that may not have survived.
 */
function withLandingTrailer(
  message: string,
  token: string | null | undefined,
): string {
  return token ? `${message}\n\n${landingIntentTrailer(token)}` : message;
}

interface LaneCommitterInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  laneId: string;
  laneWorktreePath: string;
  /** Lane HEAD captured before the context's first turn, or null when the
   *  capture failed/never happened. Baseline for adopting agent-made commits
   *  as the context's snapshot when the commit phase finds a clean worktree. */
  preTurnHeadSha: string | null;
  /** The dispatch-time landing token (D4 decision D8), embedded as a commit
   *  trailer so the landing is replayable from the branch alone. Null for a
   *  context dispatched before intents existed. */
  landingToken?: string | null;
}

type LaneCommitterResult =
  | { status: "committed"; snapshot: GraphWorkflowExecutionLaneCommitSnapshot }
  | { status: "adopted"; snapshot: GraphWorkflowExecutionLaneCommitSnapshot }
  | { status: "skipped" }
  | { status: "failed"; errorMessage: string };

export interface LaneCommitter {
  commit(input: LaneCommitterInput): Promise<LaneCommitterResult>;
  /** Best-effort HEAD capture for the adoption baseline: never throws,
   *  returns null when HEAD cannot be resolved. */
  resolveHead(worktreePath: string): Promise<string | null>;
}

export interface LaneCommitterDeps {
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
  resolveHeadSha(worktreePath: string): Promise<string | null>;
  now(): string;
}

export function createLaneCommitter(
  deps: LaneCommitterDeps = {
    hasUncommittedChanges: defaultHasUncommittedChanges,
    commitChanges: defaultCommitChanges,
    resolveHeadSha: defaultGetHeadCommit,
    now: () => new Date().toISOString(),
  },
): LaneCommitter {
  async function resolveHead(worktreePath: string): Promise<string | null> {
    try {
      return await deps.resolveHeadSha(worktreePath);
    } catch {
      return null;
    }
  }

  return {
    resolveHead,
    async commit(input) {
      const { projectPath, sessionName, contextId, laneId, laneWorktreePath } =
        input;

      const hasChanges = await deps.hasUncommittedChanges(laneWorktreePath);
      if (!hasChanges) {
        // Implementer agents routinely commit their own work during the turn,
        // leaving the worktree clean here. Adopt the moved HEAD as the
        // context's commit snapshot so the evidence chain (lane-commit event
        // → commit evidence → changedCode) still records the delivered work.
        // Without a pre-turn baseline we skip conservatively rather than
        // attribute fork-point or join-merge commits to this context.
        if (input.preTurnHeadSha !== null) {
          const headSha = await resolveHead(laneWorktreePath);
          if (headSha !== null && headSha !== input.preTurnHeadSha) {
            const snapshot: GraphWorkflowExecutionLaneCommitSnapshot = {
              contextId,
              sha: headSha,
              committedAt: deps.now(),
            };
            logger.info("graph-workflow.lane_commit.adopted_head", {
              projectPath,
              sessionName,
              contextId,
              laneId,
              laneWorktreePath,
              preTurnHeadSha: input.preTurnHeadSha,
              hash: headSha,
              committedAt: snapshot.committedAt,
            });
            return { status: "adopted", snapshot };
          }
        }
        logger.info("graph-workflow.lane_commit.skipped", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
        });
        return { status: "skipped" };
      }

      const message = withLandingTrailer(
        `Graph workflow context ${contextId}`,
        input.landingToken,
      );
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
