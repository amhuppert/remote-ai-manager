import type { LaneGit } from "../lane-git";
import type { WorkspaceExecutorDeps } from "../executor";
import type { LaneIntegrator } from "../lane-integrator";
import { laneBindingId, type LaneTarget, type WorkspaceBindingRequest } from "../schemas";

/** The lane as a check binding: its own branch and worktree, every path. */
export function laneCheckBinding(lane: LaneTarget): WorkspaceBindingRequest {
  return {
    kind: "lane",
    projectPath: lane.projectPath,
    sessionName: lane.sessionName,
    worktreePath: lane.worktreePath,
    branch: lane.branch,
    scope: { mode: "full" },
  };
}

/**
 * Integration without agents: a conflict or a failing check ends the attempt
 * with the reason, for the owner to fix and retry.
 */
export function createDirectLaneIntegrator(deps: {
  lanes: Pick<LaneGit, "mergeInto">;
  runCheck: WorkspaceExecutorDeps["runCheck"];
}): LaneIntegrator {
  return {
    async integrate({ lane, head, checks, signal }) {
      const merged = await deps.lanes.mergeInto({
        worktreePath: lane.worktreePath,
        commit: head,
        message: `Merge session head ${head} into lane ${lane.laneId}`,
      });
      if (merged.kind === "conflicts")
        return {
          kind: "failed",
          detail: `Merging the session head ${head} into the lane conflicts in ${merged.files.join(", ")}. Resolve them on branch ${lane.branch} in ${lane.worktreePath}, then ask for a new attempt.`,
        };
      for (const command of checks) {
        const result = await deps.runCheck({
          binding: laneCheckBinding(lane),
          bindingId: laneBindingId(lane),
          command,
          signal,
        });
        if (result.status !== "passed")
          return {
            kind: "failed",
            detail: `"${command}" ${result.status === "failed" ? "failed" : "could not run"} on the lane merged with ${head}${result.detail !== undefined ? `: ${result.detail}` : ""}`,
          };
      }
      return { kind: "integrated" };
    },
  };
}
