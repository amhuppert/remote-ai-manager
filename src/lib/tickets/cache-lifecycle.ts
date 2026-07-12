/** Shared ticket-cache reactions to session, ticket, and project lifecycle. */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  findCachedTicketListItem,
  snapshotTicketListCaches,
  upsertTicketInListCaches,
} from "./list-cache";
import { ticketListItemFromDetail } from "./list-filters";
import { isAuthoritativelyDeletedTicket } from "./event-version";
import { pendingTicketOverlayFor } from "./pending-overlay";
import { scheduleTicketCacheInvalidation } from "./mutation-coordinator";
import { ticketKeys } from "./query-keys";
import type {
  TicketDetail,
  TicketLinkSummary,
  TicketListItem,
} from "./schemas";

function isTicketDetailForProject(
  queryKey: QueryKey,
  projectName: string,
): boolean {
  return (
    queryKey[0] === "tickets" &&
    queryKey[1] === "detail" &&
    queryKey[2] === projectName
  );
}

function isTicketDetailKeyForProject(
  queryKey: QueryKey,
  projectName: string,
): boolean {
  return (
    queryKey.length === 4 && isTicketDetailForProject(queryKey, projectName)
  );
}

function linkedTicketNumbers(
  queryClient: QueryClient,
  projectName: string,
  sessionNames: ReadonlySet<string>,
): Set<number> {
  const numbers = new Set<number>();
  const linkMap = queryClient.getQueryData<Record<string, TicketLinkSummary>>(
    ticketKeys.sessionLinks(projectName),
  );
  for (const sessionName of sessionNames) {
    const summary = linkMap?.[sessionName];
    if (summary) numbers.add(summary.number);
  }

  for (const [, rows] of queryClient.getQueriesData<TicketListItem[]>({
    queryKey: ticketKeys.lists(),
  })) {
    for (const row of rows ?? []) {
      if (
        row.projectName === projectName &&
        row.activeSessionName !== null &&
        sessionNames.has(row.activeSessionName)
      ) {
        numbers.add(row.number);
      }
    }
  }

  for (const [queryKey, cached] of queryClient.getQueriesData<TicketDetail>({
    queryKey: ticketKeys.details(),
  })) {
    if (!isTicketDetailKeyForProject(queryKey, projectName) || !cached) {
      continue;
    }
    if (
      Array.isArray(cached.sessions) &&
      cached.sessions.some((link) => sessionNames.has(link.sessionName))
    ) {
      numbers.add(cached.number);
    }
  }
  return numbers;
}

export function invalidateTicketSessionLifecycle(
  queryClient: QueryClient,
  projectName: string,
  sessionNames: Iterable<string>,
): void {
  const names = new Set(sessionNames);
  const numbers = linkedTicketNumbers(queryClient, projectName, names);

  scheduleTicketCacheInvalidation(queryClient, {
    includeLists: true,
    details: [...numbers].map((number) => ({ projectName, number })),
  });
  void queryClient.invalidateQueries({
    queryKey: ticketKeys.sessionLinks(projectName),
  });
}

export function resetDeletedTicketCaches(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): void {
  void queryClient.resetQueries({
    queryKey: ticketKeys.detail(projectName, number),
  });
  void queryClient.resetQueries({
    queryKey: ticketKeys.sessionLinks(projectName),
    exact: true,
  });
}

export function removeProjectTicketsOptimistically(
  queryClient: QueryClient,
  projectName: string,
): TicketListItem[] {
  const snapshot = snapshotTicketListCaches(queryClient);
  const removed = new Map<string, TicketListItem>();
  for (const [queryKey, rows] of snapshot) {
    if (!rows) continue;
    for (const row of rows) {
      if (row.projectName === projectName) removed.set(row.id, row);
    }
    queryClient.setQueryData(
      queryKey,
      rows.filter((row) => row.projectName !== projectName),
    );
  }
  return [...removed.values()];
}

export function restoreProjectTicketLists(
  queryClient: QueryClient,
  removedItems: readonly TicketListItem[] | undefined,
): void {
  for (const removed of removedItems ?? []) {
    if (
      isAuthoritativelyDeletedTicket(
        queryClient,
        removed.projectName,
        removed.number,
      ) ||
      pendingTicketOverlayFor(queryClient, removed.projectName, removed.number)
        ?.kind === "remove"
    ) {
      continue;
    }
    const cached = findCachedTicketListItem(
      queryClient,
      removed.projectName,
      removed.number,
    );
    const detail = queryClient.getQueryData<TicketDetail>(
      ticketKeys.detail(removed.projectName, removed.number),
    );
    upsertTicketInListCaches(
      queryClient,
      cached ?? (detail ? ticketListItemFromDetail(detail) : removed),
    );
  }
}

export function resetDeletedProjectTicketCaches(
  queryClient: QueryClient,
  projectName: string,
): void {
  removeProjectTicketsOptimistically(queryClient, projectName);
  scheduleTicketCacheInvalidation(queryClient, {
    includeLists: true,
  });
  void queryClient.resetQueries({
    queryKey: ticketKeys.details(),
    predicate: (query) => isTicketDetailForProject(query.queryKey, projectName),
  });
  void queryClient.resetQueries({
    queryKey: ticketKeys.sessionLinks(projectName),
    exact: true,
  });
}
