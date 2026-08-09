import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { stopAllForWorktree as defaultStopAllForWorktree } from "@/lib/dev-server/registry";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

const logger = createLogger("graph-workflow-dev-server-cleanup");

/**
 * Collect the distinct worktree paths of an execution's worktree lanes. A
 * terminal sweep reads lane rows directly so it still finds a shared worktree
 * after member state has been cleared. A context-scoped reset preserves a
 * shared lane while any unselected member remains on it.
 */
export function collectLaneWorktreePaths(
  execution: GraphWorkflowExecution,
  opts?: { contextIds?: string[] },
): string[] {
  const filter = opts?.contextIds ? new Set(opts.contextIds) : null;
  const seen = new Set<string>();
  const result: string[] = [];

  const addPath = (worktreePath: string): void => {
    const normalized = path.resolve(worktreePath);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(worktreePath);
  };

  if (filter === null) {
    for (const lane of Object.values(execution.executionLanes)) {
      if (lane.kind !== "worktree" || lane.worktreePath === null) continue;
      addPath(lane.worktreePath);
    }
  }

  for (const cs of Object.values(execution.contextStates)) {
    if (cs.isolation !== "worktree") continue;
    if (filter && !filter.has(cs.contextId)) continue;

    if (filter && cs.laneId !== null) {
      const unselectedMemberRemains = Object.values(
        execution.contextStates,
      ).some(
        (candidate) =>
          candidate.contextId !== cs.contextId &&
          candidate.laneId === cs.laneId &&
          !filter.has(candidate.contextId),
      );
      if (unselectedMemberRemains) continue;
    }

    const lanePath =
      cs.laneId === null
        ? null
        : execution.executionLanes[cs.laneId]?.worktreePath;
    const worktreePath = lanePath ?? cs.worktreePath;
    if (worktreePath === null) continue;
    addPath(worktreePath);
  }
  return result;
}

export interface StopExecutionLaneDevServersDeps {
  stopDevServersForWorktree(input: {
    projectPath: string;
    worktreePath: string;
  }): Promise<void>;
}

const defaultDeps: StopExecutionLaneDevServersDeps = {
  stopDevServersForWorktree: defaultStopAllForWorktree,
};

/**
 * Stop the dev servers running in an execution's lane worktrees. Best-effort
 * per lane — a failed stop never blocks the caller (terminal transition,
 * reset, or clear) and never rejects.
 */
export async function stopExecutionLaneDevServers(
  input: {
    execution: GraphWorkflowExecution;
    projectPath: string;
    contextIds?: string[];
  },
  deps: StopExecutionLaneDevServersDeps = defaultDeps,
): Promise<void> {
  const worktreePaths = collectLaneWorktreePaths(input.execution, {
    contextIds: input.contextIds,
  });
  if (worktreePaths.length === 0) return;

  logger.info("graph-workflow.lane_dev_server_cleanup", {
    executionId: input.execution.id,
    worktreePaths,
    contextIds: input.contextIds,
  });

  await Promise.all(
    worktreePaths.map((worktreePath) =>
      deps
        .stopDevServersForWorktree({
          projectPath: input.projectPath,
          worktreePath,
        })
        .catch((err: unknown) => {
          logger.warn("graph-workflow.lane_dev_server_cleanup_failed", {
            executionId: input.execution.id,
            worktreePath,
            reason: getErrorMessage(err),
          });
        }),
    ),
  );
}
