import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { stopAllForWorktree as defaultStopAllForWorktree } from "@/lib/dev-server/registry";
import type { GraphWorkflowExecution } from "@/lib/workflows/schemas";

const logger = createLogger("graph-workflow-dev-server-cleanup");

/**
 * Collect the distinct worktree paths of an execution's worktree-isolated
 * contexts (graph-workflow lanes). Pure: derives paths from `contextStates`
 * so it can be read before a terminal transition (e.g. reset) drops the lane
 * association. Pass `contextIds` to scope to specific contexts (used by reset,
 * which affects a single context).
 */
export function collectLaneWorktreePaths(
  execution: GraphWorkflowExecution,
  opts?: { contextIds?: string[] },
): string[] {
  const filter = opts?.contextIds ? new Set(opts.contextIds) : null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cs of Object.values(execution.contextStates)) {
    if (cs.isolation !== "worktree") continue;
    if (cs.worktreePath === null) continue;
    if (filter && !filter.has(cs.contextId)) continue;
    const normalized = path.resolve(cs.worktreePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(cs.worktreePath);
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
