/**
 * Background-job SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { addSseListener, type SseEventTarget } from "@/lib/api/sse";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  backgroundJobSchema,
  jobStatusEventSchema,
  type BackgroundJob,
  type JobStatusEvent,
} from "@/lib/jobs/schemas";
import { reconnectReconcile } from "@/lib/events/sse-reconnect";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { invalidateTicketSessionLifecycle } from "@/lib/tickets/cache-lifecycle";
import {
  resolveMergeDoneTicketPrompt,
  type MergeDoneTicketPrompt,
} from "@/lib/tickets/merge-done-prompt";

const logger = createClientLogger("jobs.sse-reactions");

const reconciledJobsSchema = z.array(backgroundJobSchema);

export interface JobSseReactionDeps {
  queryClient: QueryClient;
  /** Routes the live job state into the notification store (topbar jobs). */
  addOrUpdateJob(event: JobStatusEvent): void;
  /** Queues the post-merge "move the linked ticket to Done?" suggestion. */
  enqueueMergeDonePrompt(prompt: MergeDoneTicketPrompt): void;
}

export function registerJobSseReactions(
  es: EventSource,
  deps: JobSseReactionDeps,
): void {
  addSseListener(es, "job-status", jobStatusEventSchema, (data) => {
    deps.addOrUpdateJob(data);

    // Resolved before the invalidations below so the suggestion reads the
    // session-link map this event is about to refresh.
    const mergeDonePrompt = resolveMergeDoneTicketPrompt(
      deps.queryClient,
      data,
    );
    if (mergeDonePrompt) deps.enqueueMergeDonePrompt(mergeDonePrompt);

    // On completed merge/commit/resolve: invalidate session queries
    if (
      data.status === "completed" &&
      (data.jobType === "merge" ||
        data.jobType === "commit" ||
        data.jobType === "resolve-conflicts")
    ) {
      void deps.queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(data.projectName, data.sessionName),
      });
      if (data.jobType === "merge") {
        invalidateTicketSessionLifecycle(deps.queryClient, data.projectName, [
          data.sessionName,
        ]);
      }
    }
  });
}

export interface JobsReconnectReactionDeps {
  queryClient: QueryClient;
  /** Replaces the notification-store job list with the server's authority. */
  reconcileJobs(jobs: BackgroundJob[]): void;
  /** Injectable for tests; defaults to the shared reconnect orchestrator. */
  reconnectReconcile?: typeof reconnectReconcile;
}

/**
 * Reconnect reconciliation for background jobs.
 *
 * After the SSE stream drops and re-opens, live job events published during the
 * gap were missed, so the cached job list can be stale. On the first `onopen`
 * following an error this asks the shared reconnect orchestrator to refetch
 * everything event-driven, then parses the returned `/api/jobs` payload with
 * `backgroundJobSchema` and reconciles it into the notification store. A
 * malformed payload is logged and dropped (the store keeps its prior state)
 * rather than corrupting the topbar job list.
 *
 * Owns the `onerror`/`onopen` reconnect wiring so the client assembly point
 * (`NotificationListener`) stays assembly-only. Job parsing/reconciliation is
 * jobs-domain knowledge and lives here, not in the global composition
 * component.
 */
export function registerJobsReconnectReconciliation(
  es: SseEventTarget,
  deps: JobsReconnectReactionDeps,
): void {
  const reconcile = deps.reconnectReconcile ?? reconnectReconcile;
  let hadError = false;

  es.addEventListener("error", () => {
    hadError = true;
  });

  es.addEventListener("open", () => {
    if (!hadError) return;
    hadError = false;
    void reconcile(deps.queryClient, (jobs) => {
      const parsed = reconciledJobsSchema.safeParse(jobs);
      if (!parsed.success) {
        logger.warn("jobs.reconnect.reconcile_rejected", {
          reason: "schema-mismatch",
          issueCount: parsed.error.issues.length,
        });
        return;
      }
      deps.reconcileJobs(parsed.data);
    });
  });
}
