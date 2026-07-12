import type { SSEEvent } from "@/lib/api/sse-events";
import { broadcastEvent } from "@/lib/events/broadcast-event";
import type { createLogger } from "@/lib/logging";
import {
  ticketChangedEventSchema,
  type TicketChangedEvent,
  type TicketListItem,
} from "./schemas";

type TicketLogger = ReturnType<typeof createLogger>;

export interface PublishTicketChangeInput {
  broadcast(event: SSEEvent): void;
  logger: TicketLogger;
  change: TicketChangedEvent["change"];
  projectName: string;
  ticketNumber: number;
  listItem: TicketListItem | null;
  attachmentIndexChanged: boolean;
  linkedSessionName?: string;
}

/**
 * Single builder for `ticket-changed` events so every ticket surface
 * (service, attachment service, session links) emits the same envelope and
 * schema-validation failures degrade to a structured warning, never a thrown
 * error after a committed mutation.
 */
export function publishTicketChange(input: PublishTicketChangeInput): void {
  broadcastEvent({
    broadcast: input.broadcast,
    logger: input.logger,
    failureEvent: "tickets.service.event_broadcast_failed",
    context: {
      change: input.change,
      projectName: input.projectName,
      ticketNumber: input.ticketNumber,
    },
    build: () =>
      ticketChangedEventSchema.parse({
        type: "ticket-changed",
        change: input.change,
        projectName: input.projectName,
        ticketNumber: input.ticketNumber,
        listItem: input.listItem,
        attachmentIndexChanged: input.attachmentIndexChanged,
        ...(input.linkedSessionName !== undefined
          ? { linkedSessionName: input.linkedSessionName }
          : {}),
      }),
  });
}
