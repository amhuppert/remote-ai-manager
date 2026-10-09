import {
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import type { Logger } from "@/lib/logging";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { runChangedEventSchema } from "./event-schemas";

export interface RunChangePublisher {
  /** A run's record or one of its Contexts committed a change. */
  changed(run: {
    runId: string;
    projectPath: string;
    sessionName: string;
  }): void;
}

/**
 * Tells clients a run changed. One effect commits several changes in a burst
 * (a Context, then its Run), so a run's changes are published once per window:
 * the first change schedules the flush through `defer`, and later ones join
 * it. A steady stream of changes still reaches clients once per window rather
 * than waiting for it to stop. Deferred work runs after the committing
 * transaction returns.
 */
export function createRunChangePublisher(deps: {
  publish: PublishFn;
  logger: Pick<Logger, "warn">;
  defer(flush: () => void): void;
}): RunChangePublisher {
  const pending = new Set<string>();
  return {
    changed({ runId, projectPath, sessionName }) {
      if (pending.has(runId)) return;
      pending.add(runId);
      deps.defer(() => {
        pending.delete(runId);
        publishEventBestEffort({
          publish: deps.publish,
          logger: deps.logger,
          failureEvent: "runs.change_publish_failed",
          context: { runId },
          build: () =>
            runChangedEventSchema.parse({
              type: "run-changed",
              projectName: getProjectDisplayName(projectPath),
              sessionName,
              runId,
            }),
        });
      });
    },
  };
}
