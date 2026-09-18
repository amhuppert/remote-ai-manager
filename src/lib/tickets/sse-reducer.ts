/**
 * sse-reducer.ts — pure, idempotent application of `ticket-changed` deltas to
 * the query caches. The list reduction shares the filter/order module with the
 * optimistic mutation paths, so an SSE arrival and an optimistic move land the
 * same ticket in the same place regardless of order.
 *
 * The reducer never fights an in-flight optimistic move: before applying an
 * event it consults the pending-overlay registry (`pending-overlay.ts`) and
 * reapplies any registered optimistic fields over the incoming lean item — a
 * delayed delta cannot revert an optimistic status or resurrect an
 * optimistically deleted ticket. Genuine deletion events win over overlays.
 *
 * Data absent from the lean event uses exact invalidation only: the one detail
 * key on every surviving change (req 9.8 — open detail views reflect changes
 * from any source), the one project session-link key when a session is named.
 * Deletion removes the identity everywhere.
 *
 * Client-imported: keep this module free of `node:` builtins.
 */

import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import {
  matchesTicketListFilters,
  sortTicketListItems,
  type TicketListFilters,
} from "./list-filters";
import {
  applyOverlayToTicketChangedEvent,
  pendingTicketOverlayFor,
} from "./pending-overlay";
import { resetDeletedTicketCaches } from "./cache-lifecycle";
import {
  isStaleTicketChangedEvent,
  rememberTicketChangedEvent,
} from "./event-version";
import { ticketKeys, ticketListFiltersFromQueryKey } from "./query-keys";
import type {
  TicketChangedEvent,
  TicketDetail,
  TicketListItem,
  TicketRelationshipPage,
  TicketRelationshipView,
} from "./schemas";

/**
 * Reduce one cached list against one event: remove the ticket identity, then
 * re-insert and re-sort the lean item only when it matches the list's typed
 * filters. Returns the input array unchanged (same reference) when the event
 * does not touch this cache, so no-op events cause no cache writes.
 */
export function reduceTicketListForEvent(
  list: TicketListItem[],
  filters: TicketListFilters,
  event: TicketChangedEvent,
): TicketListItem[] {
  const without = list.filter(
    (row) =>
      !(
        row.projectName === event.projectName &&
        row.number === event.ticketNumber
      ),
  );
  const hadIdentity = without.length !== list.length;

  const insert =
    event.change !== "deleted" &&
    event.listItem !== null &&
    matchesTicketListFilters(filters, event.listItem)
      ? event.listItem
      : null;

  if (insert === null) {
    return hadIdentity ? without : list;
  }
  return sortTicketListItems(filters.sort, [...without, insert]);
}

function invalidateTicketRelationshipReaders(
  queryClient: QueryClient,
  event: TicketChangedEvent,
): void {
  if (
    event.change !== "updated" &&
    event.change !== "session" &&
    event.change !== "deleted"
  )
    return;

  const referencesChangedTicket = (relationship: TicketRelationshipView) =>
    relationship.otherTicket.projectName === event.projectName &&
    relationship.otherTicket.number === event.ticketNumber;

  // Relationship projections embed the other endpoint's title and status,
  // including endpoints in other projects and later pagination pages.
  for (const [queryKey, detail] of queryClient.getQueriesData<TicketDetail>({
    queryKey: ticketKeys.details(),
    predicate: (query) => query.queryKey.length === 4,
  })) {
    if (detail?.relationships?.some(referencesChangedTicket)) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }
  for (const [queryKey, data] of queryClient.getQueriesData<
    InfiniteData<TicketRelationshipPage>
  >({
    queryKey: ticketKeys.details(),
    predicate: (query) => query.queryKey[4] === "relationships",
  })) {
    if (data?.pages.some((page) => page.items.some(referencesChangedTicket))) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }
}

function applyTicketChangedEventToCaches(
  queryClient: QueryClient,
  event: TicketChangedEvent,
  rememberRawEvent: boolean,
): void {
  const overlay = pendingTicketOverlayFor(
    queryClient,
    event.projectName,
    event.ticketNumber,
  );
  if (
    rememberRawEvent &&
    isStaleTicketChangedEvent(queryClient, event, {
      includeCachedVersion: overlay === null,
    })
  ) {
    return;
  }
  void queryClient.cancelQueries({ queryKey: ticketKeys.lists() });
  if (rememberRawEvent) {
    rememberTicketChangedEvent(queryClient, event);
  }
  const effective = applyOverlayToTicketChangedEvent(event, overlay);
  invalidateTicketRelationshipReaders(queryClient, event);

  // Parent rollups are computed across all children by the list read. A child
  // may be absent from a filtered board, so the event carries parent identities.
  const parentNumbers = new Set(
    event.change === "updated" ||
      event.change === "session" ||
      event.change === "relationships"
      ? (event.listItem?.parentTicketNumbers ?? [])
      : [],
  );
  for (const [queryKey, data] of queryClient.getQueriesData<TicketListItem[]>({
    queryKey: ticketKeys.lists(),
  })) {
    const filters = ticketListFiltersFromQueryKey(queryKey);
    if (filters === null || data === undefined) continue;
    const next = reduceTicketListForEvent(data, filters, effective);
    if (next !== data) {
      queryClient.setQueryData(queryKey, next);
    }
    if (
      data.some(
        (item) =>
          item.projectName === event.projectName &&
          parentNumbers.has(item.number),
      )
    ) {
      void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }
  for (const number of parentNumbers) {
    void queryClient.invalidateQueries({
      queryKey: ticketKeys.detail(event.projectName, number),
    });
  }

  const detailKey = ticketKeys.detail(event.projectName, event.ticketNumber);
  if (event.change === "deleted") {
    resetDeletedTicketCaches(
      queryClient,
      event.projectName,
      event.ticketNumber,
    );
  } else if (overlay === null) {
    // The lean event carries only list fields, so the detail-key prefix is
    // invalidated to refresh an active detail and any nested attachment
    // previews while marking inactive matches stale (req 9.8).
    // While an optimistic mutation is pending, refetching the detail would
    // overwrite the optimistic detail patch; the owning mutation's onSettled
    // hygiene invalidation covers the same key once the server has settled.
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }

  if (event.linkedSessionName !== undefined) {
    void queryClient.invalidateQueries({
      queryKey: ticketKeys.sessionLinks(event.projectName),
    });
  }
}

/** Apply one newly received, validated `ticket-changed` event. */
export function applyTicketChangedEvent(
  queryClient: QueryClient,
  event: TicketChangedEvent,
): void {
  applyTicketChangedEventToCaches(queryClient, event, true);
}

/** Reapply an already remembered raw event after an optimistic overlay leaves. */
export function replayTicketChangedEvent(
  queryClient: QueryClient,
  event: TicketChangedEvent,
): void {
  applyTicketChangedEventToCaches(queryClient, event, false);
}
