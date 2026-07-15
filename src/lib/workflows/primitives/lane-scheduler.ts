/**
 * Lane scheduler for the workflow primitive layer.
 *
 * Enforces worktree-safe concurrency: any lane execution that can write to a
 * session worktree is serialized against other write-capable executions on
 * the same session, while executions that the workflow has explicitly proven
 * to be read-only — or confined to disjoint lane-scoped artifact paths
 * (`artifact_only`) — run without acquiring the write lock.
 *
 * The default — when the caller does not specify `writeCapability` — is
 * `write_capable`, so the shared primitive layer preserves the current
 * single-flight safety model and never silently relaxes it.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import { DEFAULT_LANE_WRITE_CAPABILITY } from "./agent-call-vocabulary";
import type { LaneWriteCapability } from "./lane-vocabulary";

const defaultLogger = createLogger("workflows.primitives.lane.scheduler");

export interface LaneScheduleRequest {
  sessionKey: string;
  writeCapability?: LaneWriteCapability;
  workflowId?: string;
  laneId?: string;
}

export interface LaneScheduler {
  schedule<T>(request: LaneScheduleRequest, fn: () => Promise<T>): Promise<T>;
}

export interface LaneSchedulerDeps {
  logger?: Logger;
}

export function createLaneScheduler(
  deps: LaneSchedulerDeps = {},
): LaneScheduler {
  const writeMutex = createKeyedMutex();
  const log = deps.logger ?? defaultLogger;

  return {
    async schedule(request, fn) {
      const writeCapability =
        request.writeCapability ?? DEFAULT_LANE_WRITE_CAPABILITY;

      if (
        writeCapability === "read_only" ||
        writeCapability === "artifact_only"
      ) {
        log.debug(
          writeCapability === "read_only"
            ? "lane.scheduler.read_only"
            : "lane.scheduler.artifact_only",
          {
            sessionKey: request.sessionKey,
            workflowId: request.workflowId,
            laneId: request.laneId,
          },
        );
        return fn();
      }

      log.debug("lane.scheduler.write_capable_enqueued", {
        sessionKey: request.sessionKey,
        workflowId: request.workflowId,
        laneId: request.laneId,
      });
      // Serialize write-capable executions per session so a failed write does
      // not strand the session lock (the mutex advances on settlement).
      return writeMutex.run(request.sessionKey, fn);
    },
  };
}
