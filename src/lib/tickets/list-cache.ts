/**
 * list-cache.ts — walkers that apply the shared list-filter semantics to every
 * cached ticket list. Optimistic mutation paths and the SSE reducer both go
 * through these, so a ticket delta lands identically no matter the source.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { removeTicketListItem, upsertTicketListItem } from "./list-filters";
import { ticketKeys, ticketListFiltersFromQueryKey } from "./query-keys";
import type { TicketListItem } from "./schemas";

export type TicketListCacheSnapshot = Array<
  [QueryKey, TicketListItem[] | undefined]
>;

export function snapshotTicketListCaches(
  queryClient: QueryClient,
): TicketListCacheSnapshot {
  return queryClient.getQueriesData<TicketListItem[]>({
    queryKey: ticketKeys.lists(),
  });
}

export function restoreTicketListCaches(
  queryClient: QueryClient,
  snapshot: TicketListCacheSnapshot,
): void {
  for (const [queryKey, data] of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

/**
 * Remove the ticket identity from every cached list, then re-insert and
 * re-sort the item only into caches whose typed filters match.
 */
export function upsertTicketInListCaches(
  queryClient: QueryClient,
  item: TicketListItem,
): void {
  for (const [queryKey, data] of snapshotTicketListCaches(queryClient)) {
    const filters = ticketListFiltersFromQueryKey(queryKey);
    if (filters === null || data === undefined) continue;
    queryClient.setQueryData(
      queryKey,
      upsertTicketListItem(data, item, filters),
    );
  }
}

export function removeTicketFromListCaches(
  queryClient: QueryClient,
  ticketId: string,
): void {
  for (const [queryKey, data] of snapshotTicketListCaches(queryClient)) {
    if (data === undefined) continue;
    queryClient.setQueryData(queryKey, removeTicketListItem(data, ticketId));
  }
}

/** The current lean row for an identity, from whichever cache holds it. */
export function findCachedTicketListItem(
  queryClient: QueryClient,
  projectName: string,
  number: number,
): TicketListItem | null {
  for (const [, data] of snapshotTicketListCaches(queryClient)) {
    const hit = data?.find(
      (row) => row.projectName === projectName && row.number === number,
    );
    if (hit) return hit;
  }
  return null;
}
