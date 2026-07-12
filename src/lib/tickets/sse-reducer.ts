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

import type { QueryClient } from "@tanstack/react-query";

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
import type { TicketChangedEvent, TicketListItem } from "./schemas";

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

  for (const [queryKey, data] of queryClient.getQueriesData<TicketListItem[]>({
    queryKey: ticketKeys.lists(),
  })) {
    const filters = ticketListFiltersFromQueryKey(queryKey);
    if (filters === null || data === undefined) continue;
    const next = reduceTicketListForEvent(data, filters, effective);
    if (next !== data) {
      queryClient.setQueryData(queryKey, next);
    }
  }

  const detailKey = ticketKeys.detail(event.projectName, event.ticketNumber);
  if (event.change === "deleted") {
    resetDeletedTicketCaches(
      queryClient,
      event.projectName,
      event.ticketNumber,
    );
  } else if (overlay === null) {
    // The lean event carries only list fields, so an open detail view must
    // refetch to reflect changes from any source (req 9.8) — exact single-key
    // invalidation, a refetch only when that detail is actively cached.
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
