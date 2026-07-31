/**
 * "Move the linked ticket to Done?" suggestion after a native merge lands.
 *
 * A merge that fully succeeds is the moment the session's work reached the
 * target branch, so the ticket it was started from is the obvious Done
 * candidate. This module owns the whole decision — which job outcomes count as
 * a landed merge, which session the ticket is reached through, and when the
 * suggestion is redundant — so the SSE reaction only has to enqueue whatever
 * comes back.
 *
 * The session-link map keeps a session's row after the link ends (the merge
 * itself ends it with `endReason: "finished"`), so the ticket is still
 * resolvable from the cache at the moment the completion event arrives.
 */

import type { QueryClient } from "@tanstack/react-query";

import type { JobStatusEvent } from "@/lib/jobs/schemas";
import { findCachedTicketListItem } from "./list-cache";
import { ticketKeys } from "./query-keys";
import type { TicketDetail, TicketLinkSummary, TicketStatus } from "./schemas";

export interface MergeDoneTicketPrompt {
  /** Completion that raised the suggestion; also the queue's dedupe key. */
  jobId: string;
  projectName: string;
  sessionName: string;
  ticketNumber: number;
  ticketTitle: string;
}

/**
 * Statuses that make the suggestion redundant. `closed` is excluded too:
 * re-opening a closed ticket to Done would be a regression, not a completion.
 */
const SETTLED_STATUSES: readonly TicketStatus[] = ["done", "closed"];

/**
 * Both job types run the same merge machine and reach `completed` only through
 * the publish actor, so either one completing means the branch landed.
 */
function isLandedMerge(event: JobStatusEvent): boolean {
  return (
    event.status === "completed" &&
    (event.jobType === "merge" || event.jobType === "resolve-conflicts")
  );
}

/** Current status from whichever ticket cache holds it; null when uncached. */
function cachedTicketStatus(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): TicketStatus | null {
  const listItem = findCachedTicketListItem(queryClient, projectName, number);
  if (listItem) return listItem.status;
  const detail = queryClient.getQueryData<TicketDetail>(
    ticketKeys.detail(projectName, number),
  );
  return detail?.status ?? null;
}

export function resolveMergeDoneTicketPrompt(
  queryClient: QueryClient,
  event: JobStatusEvent,
): MergeDoneTicketPrompt | null {
  if (!isLandedMerge(event)) return null;

  const links = queryClient.getQueryData<Record<string, TicketLinkSummary>>(
    ticketKeys.sessionLinks(event.projectName),
  );
  const link = links?.[event.sessionName];
  if (link === undefined) return null;

  // An unknown status still gets the suggestion: the link proves a ticket is
  // there, and the user is the one deciding.
  const status = cachedTicketStatus(queryClient, link.projectName, link.number);
  if (status !== null && SETTLED_STATUSES.includes(status)) return null;

  return {
    jobId: event.jobId,
    projectName: link.projectName,
    sessionName: event.sessionName,
    ticketNumber: link.number,
    ticketTitle: link.title,
  };
}
