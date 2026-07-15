import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
const logger = createLogger("graph-workflow-execution-target-resolver");

export interface ExecutionTarget {
  worktreePath: string;
  branchName: string;
  isolation: "session" | "worktree";
  /**
   * The execution lane this target was resolved through, when the owning
   * context has been assigned to a lane. `null` for legacy per-context
   * worktrees and for solo contexts that have not joined a lane yet.
   */
  laneId: string | null;
}

interface ResolveExecutionTargetInput {
  execution: GraphWorkflowExecution;
  contextId: string;
  session: SessionState;
}

export interface ExecutionTargetResolver {
  resolve(input: ResolveExecutionTargetInput): ExecutionTarget;
}

export function createExecutionTargetResolver(): ExecutionTargetResolver {
  function resolve(input: ResolveExecutionTargetInput): ExecutionTarget {
    const { execution, contextId, session } = input;
    const contextState = execution.contextStates[contextId];
    if (!contextState) {
      throw new Error(
        `ExecutionTargetResolver: contextId ${JSON.stringify(
          contextId,
        )} not found in execution.contextStates (executionId=${execution.id})`,
      );
    }

    const { laneId } = contextState;
    if (laneId !== null) {
      const lane = execution.executionLanes[laneId];
      if (!lane) {
        throw new Error(
          `ExecutionTargetResolver: lane ${JSON.stringify(
            laneId,
          )} (assigned to contextId ${JSON.stringify(
            contextId,
          )}) not found in execution.executionLanes (executionId=${execution.id})`,
        );
      }

      if (lane.kind === "worktree") {
        if (lane.worktreePath === null) {
          throw new Error(
            `ExecutionTargetResolver: lane ${JSON.stringify(
              laneId,
            )} is kind=worktree but worktreePath is null (executionId=${execution.id})`,
          );
        }
        logger.debug("resolve_lane_worktree", {
          executionId: execution.id,
          contextId,
          laneId,
          worktreePath: lane.worktreePath,
          branchName: lane.branchName,
        });
        return {
          worktreePath: lane.worktreePath,
          branchName: lane.branchName,
          isolation: "worktree",
          laneId,
        };
      }

      logger.debug("resolve_lane_session", {
        executionId: execution.id,
        contextId,
        laneId,
        worktreePath: session.worktreePath,
        branchName: session.branchName,
      });
      return {
        worktreePath: session.worktreePath,
        branchName: session.branchName,
        isolation: "session",
        laneId,
      };
    }

    const { worktreePath, branchName } = contextState;
    if (worktreePath !== null && branchName !== null) {
      logger.debug("resolve_worktree", {
        executionId: execution.id,
        contextId,
        worktreePath,
        branchName,
      });
      return {
        worktreePath,
        branchName,
        isolation: "worktree",
        laneId: null,
      };
    }

    logger.debug("resolve_session", {
      executionId: execution.id,
      contextId,
      worktreePath: session.worktreePath,
      branchName: session.branchName,
    });
    return {
      worktreePath: session.worktreePath,
      branchName: session.branchName,
      isolation: "session",
      laneId: null,
    };
  }

  return { resolve };
}
