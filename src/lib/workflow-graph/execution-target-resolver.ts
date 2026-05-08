import { createLogger } from "@/lib/logging";
import type { GraphWorkflowExecution, SessionState } from "@/types";

const logger = createLogger("graph-workflow-execution-target-resolver");

export interface ExecutionTarget {
  worktreePath: string;
  branchName: string;
  isolation: "session" | "worktree";
}

export interface ResolveExecutionTargetInput {
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
    };
  }

  return { resolve };
}
