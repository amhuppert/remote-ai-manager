/**
 * Ticket SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { ticketChangedEventSchema } from "@/lib/tickets/schemas";
import { applyTicketChangedEvent } from "@/lib/tickets/sse-reducer";

export interface TicketSseReactionDeps {
  queryClient: QueryClient;
}

export function registerTicketSseReactions(
  es: EventSource,
  deps: TicketSseReactionDeps,
): void {
  // Ticket deltas → the pure idempotent list reducer + exact invalidations
  // for data absent from the lean event (the one detail key on every
  // surviving change, one project session-link key when a session is named).
  addSseListener(es, "ticket-changed", ticketChangedEventSchema, (data) => {
    applyTicketChangedEvent(deps.queryClient, data);
  });
}
