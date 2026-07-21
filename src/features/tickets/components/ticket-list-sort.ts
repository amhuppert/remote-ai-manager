/**
 * Presentation ordering for the ticket list's sortable column headers. This is
 * a view-layer concern: the cached/server list stays in the canonical
 * `updated` order owned by `list-filters.ts` (the SSE/optimistic contract),
 * and the list view re-orders rows for display only.
 */

import type { TicketListItem } from "@/lib/tickets/schemas";
import type { TicketListSortState } from "@/lib/tickets/ticket-url-state";
import {
  TICKET_STATUS_ORDER,
  TICKET_WORK_TYPE_ORDER,
} from "@/lib/tickets/ticket-visuals";

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rank<T>(order: readonly T[], value: T): number {
  return order.indexOf(value);
}

function compareByColumn(
  column: TicketListSortState["column"],
  a: TicketListItem,
  b: TicketListItem,
): number {
  switch (column) {
    case "ticket":
      return (
        compareStrings(a.projectName, b.projectName) || a.number - b.number
      );
    case "title":
      return a.title.localeCompare(b.title, undefined, {
        sensitivity: "base",
      });
    case "type":
      return (
        rank(TICKET_WORK_TYPE_ORDER, a.workType) -
        rank(TICKET_WORK_TYPE_ORDER, b.workType)
      );
    case "status":
      return (
        rank(TICKET_STATUS_ORDER, a.status) -
        rank(TICKET_STATUS_ORDER, b.status)
      );
    case "ctx":
      return a.attachmentCount - b.attachmentCount;
    case "updated":
      return compareStrings(a.updatedAt, b.updatedAt);
  }
}

export function sortTicketsForDisplay(
  sort: TicketListSortState,
  items: readonly TicketListItem[],
): TicketListItem[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const directed = sign * compareByColumn(sort.column, a, b);
    // Direction-independent id tie-break keeps live re-sorts stable.
    return directed !== 0 ? directed : compareStrings(a.id, b.id);
  });
}
