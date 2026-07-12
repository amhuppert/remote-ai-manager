/** Pure board grouping and status-only drag announcements. */

import type { Announcements } from "@dnd-kit/core";

import type { TicketListItem, TicketStatus } from "@/lib/tickets/schemas";
import { ticketIdentifier } from "../ticket-reference";
import { TICKET_STATUS_ORDER, TICKET_STATUS_VISUALS } from "../ticket-visuals";

export function groupTicketsByStatus(
  items: readonly TicketListItem[],
): Record<TicketStatus, TicketListItem[]> {
  const groups = Object.fromEntries(
    TICKET_STATUS_ORDER.map((status) => [status, [] as TicketListItem[]]),
  ) as Record<TicketStatus, TicketListItem[]>;
  for (const item of items) groups[item.status].push(item);
  return groups;
}

function activeTicket(active: {
  data: { current?: { ticket?: TicketListItem } | undefined };
}): TicketListItem | undefined {
  return active.data.current?.ticket;
}

function statusLabel(id: unknown): string | undefined {
  const visual = TICKET_STATUS_VISUALS[id as TicketStatus];
  return visual?.label;
}

export function buildBoardAnnouncements(): Announcements {
  return {
    onDragStart({ active }) {
      const ticket = activeTicket(active);
      if (!ticket) return undefined;
      return `Picked up ${ticketIdentifier(ticket)}.`;
    },
    onDragOver({ active, over }) {
      const ticket = activeTicket(active);
      if (!ticket) return undefined;
      const label = over ? statusLabel(over.id) : undefined;
      if (!over || label === undefined) {
        return `${ticketIdentifier(ticket)} is no longer over a column.`;
      }
      return `${ticketIdentifier(ticket)} is over ${label}.`;
    },
    onDragEnd({ active, over }) {
      const ticket = activeTicket(active);
      if (!ticket) return undefined;
      const label = over ? statusLabel(over.id) : undefined;
      if (!over || label === undefined) {
        return `${ticketIdentifier(ticket)} was dropped.`;
      }
      return `${ticketIdentifier(ticket)} was dropped on ${label}.`;
    },
    onDragCancel({ active }) {
      const ticket = activeTicket(active);
      if (!ticket) return undefined;
      const home = TICKET_STATUS_VISUALS[ticket.status].label;
      return `Movement cancelled. ${ticketIdentifier(ticket)} returned to ${home}.`;
    },
  };
}
