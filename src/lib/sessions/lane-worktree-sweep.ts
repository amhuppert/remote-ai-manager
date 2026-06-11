import { readdir } from "node:fs/promises";
import path from "node:path";
import { fastRemoveWorktree } from "@/lib/git/worktree-fast-remove";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("sessions");

export interface LaneWorktreeSweepInput {
  projectPath: string;
  sessionWorktreePath: string;
}

export interface LaneWorktreeSweepDeps {
  readdir(dir: string): Promise<string[]>;
  removeWorktree(input: {
    projectPath: string;
    worktreePath: string;
  }): Promise<unknown>;
}

export interface LaneWorktreeSweep {
  /**
   * Remove residual graph-workflow lane worktrees left behind by a session:
   * every entry in the session's `.worktrees/` directory named
   * `<sessionDirName>.<laneId>`. Lane branches follow the session-branch
   * policy — session deletion retains the session branch, so lane branches
   * are retained too. Returns the worktree paths that were removed.
   */
  sweep(input: LaneWorktreeSweepInput): Promise<string[]>;
}

const defaultDeps: LaneWorktreeSweepDeps = {
  readdir(dir) {
    return readdir(dir);
  },
  removeWorktree(input) {
    return fastRemoveWorktree(input);
  },
};

export function createLaneWorktreeSweep(
  deps: LaneWorktreeSweepDeps = defaultDeps,
): LaneWorktreeSweep {
  async function sweep(input: LaneWorktreeSweepInput): Promise<string[]> {
    const worktreesDir = path.dirname(input.sessionWorktreePath);
    const lanePrefix = `${path.basename(input.sessionWorktreePath)}.`;

    let entries: string[];
    try {
      entries = await deps.readdir(worktreesDir);
    } catch (err) {
      logger.warn("session.lane_sweep.readdir_failed", {
        worktreesDir,
        error: getErrorMessage(err),
      });
      return [];
    }

    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(lanePrefix)) continue;
      const worktreePath = path.join(worktreesDir, entry);
      try {
        await deps.removeWorktree({
          projectPath: input.projectPath,
          worktreePath,
        });
        removed.push(worktreePath);
      } catch (err) {
        logger.warn("session.lane_sweep.remove_failed", {
          worktreePath,
          error: getErrorMessage(err),
        });
      }
    }
    return removed;
  }

  return { sweep };
}
