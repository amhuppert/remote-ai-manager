/**
 * Lane scheduler for the workflow primitive layer.
 *
 * Enforces worktree-safe concurrency: any lane execution that can write to a
 * session worktree is serialized against other write-capable executions on
 * the same session, while executions that the workflow has explicitly proven
 * to be read-only run without acquiring the write lock.
 *
 * The default — when the caller does not specify `writeCapability` — is
 * `write_capable`, so the shared primitive layer preserves the current
 * single-flight safety model and never silently relaxes it.
 */

import { createLogger, type Logger } from "@/lib/logging";
import type { LaneWriteCapability } from "./lane-vocabulary";

const defaultLogger = createLogger("workflows.primitives.lane.scheduler");

const DEFAULT_WRITE_CAPABILITY: LaneWriteCapability = "write_capable";

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
  const writeChains = new Map<string, Promise<unknown>>();
  const log = deps.logger ?? defaultLogger;

  return {
    async schedule(request, fn) {
      const writeCapability =
        request.writeCapability ?? DEFAULT_WRITE_CAPABILITY;

      if (writeCapability === "read_only") {
        log.debug("lane.scheduler.read_only", {
          sessionKey: request.sessionKey,
          workflowId: request.workflowId,
          laneId: request.laneId,
        });
        return fn();
      }

      const previous = writeChains.get(request.sessionKey) ?? Promise.resolve();
      // Chain onto the previous write regardless of its outcome so a failed
      // write does not strand the entire session lock.
      const next = previous.then(
        () => fn(),
        () => fn(),
      );
      writeChains.set(request.sessionKey, next);
      log.debug("lane.scheduler.write_capable_enqueued", {
        sessionKey: request.sessionKey,
        workflowId: request.workflowId,
        laneId: request.laneId,
      });

      try {
        return await next;
      } finally {
        if (writeChains.get(request.sessionKey) === next) {
          writeChains.delete(request.sessionKey);
        }
      }
    },
  };
}
