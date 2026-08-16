/**
 * Startup collection of orphaned prepared-merge refs.
 *
 * A prepared squash-merge commit lives under `refs/cc-merges/<jobId>` between
 * prepare and publish, reachable through nothing else. Publish and discard each
 * delete their own ref, but a job that never reached either — a process killed
 * mid-merge, a session deleted while a candidate was parked — leaves the commit
 * behind forever, and git will not collect it while a ref names it.
 *
 * A ref is garbage exactly when no job row still holds it, asked against the
 * durable rows at the moment of deletion — the rows are shared with every other
 * worker, and a merge dispatched during the walk owns a ref an older answer
 * would have called garbage. The caller supplies which projects to walk and the
 * git ops to walk them with.
 */

import { createLogger } from "../logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { listProjectPaths as defaultListProjectPaths } from "../state-store";
import {
  deleteParkedMergeRef as defaultDeleteParkedMergeRef,
  listParkedMergeRefs as defaultListParkedMergeRefs,
  type ParkedMergeRef,
} from "../git/worktree";
import { getStateDb } from "../state-store/store";
import { createJobsRepo } from "./repo";

const logger = createLogger("background-jobs");

export interface ParkedRefGcDeps {
  listProjectPaths(): Promise<readonly string[]>;
  listParkedMergeRefs(projectPath: string): Promise<ParkedMergeRef[]>;
  deleteParkedMergeRef(projectPath: string, ref: string): Promise<boolean>;
  /** Job ids whose parked commit is still someone's to land. */
  listJobIdsHoldingParkedRefs(): string[];
}

export interface ParkedRefGcSummary {
  scannedProjects: number;
  deleted: number;
  retained: number;
}

function defaultDeps(): ParkedRefGcDeps {
  return {
    listProjectPaths: defaultListProjectPaths,
    listParkedMergeRefs: defaultListParkedMergeRefs,
    deleteParkedMergeRef: defaultDeleteParkedMergeRef,
    listJobIdsHoldingParkedRefs: () =>
      createJobsRepo(getStateDb()).listJobIdsHoldingParkedRefs(),
  };
}

/**
 * Delete every parked ref with no job row still holding it. A project whose
 * repository cannot be read is skipped rather than aborting the sweep — a stale
 * project path must not stop the remaining projects from being collected.
 */
export async function collectOrphanedParkedRefs(
  deps: ParkedRefGcDeps = defaultDeps(),
): Promise<ParkedRefGcSummary> {
  const projectPaths = await deps.listProjectPaths();

  let scannedProjects = 0;
  let deleted = 0;
  let retained = 0;

  for (const projectPath of projectPaths) {
    let parkedRefs: ParkedMergeRef[];
    try {
      parkedRefs = await deps.listParkedMergeRefs(projectPath);
    } catch (err) {
      logger.warn("merge.parked_ref_gc_scan_failed", {
        projectPath,
        error: getErrorMessage(err),
      });
      continue;
    }
    scannedProjects += 1;

    for (const parked of parkedRefs) {
      // Asked here, not once per sweep: the walk is I/O-bound and every worker
      // sharing this database can dispatch a merge while it runs, so a set read
      // earlier would authorize deleting a ref whose owner was registered in
      // the meantime.
      if (deps.listJobIdsHoldingParkedRefs().includes(parked.jobId)) {
        retained += 1;
        continue;
      }
      try {
        if (await deps.deleteParkedMergeRef(projectPath, parked.ref)) {
          deleted += 1;
        }
      } catch (err) {
        logger.warn("merge.parked_ref_gc_delete_failed", {
          projectPath,
          parkedRef: parked.ref,
          error: getErrorMessage(err),
        });
      }
    }
  }

  if (deleted > 0) {
    logger.info("merge.parked_ref_gc_collected", {
      scannedProjects,
      deleted,
      retained,
    });
  }

  return { scannedProjects, deleted, retained };
}
