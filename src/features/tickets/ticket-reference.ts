/**
 * Object-arg adapters over the canonical ticket reference contract
 * (`@/lib/tickets/references`) for the feature's item shapes
 * (`TicketListItem`/`TicketDetail` carry `projectName` + `number`).
 */

import {
  buildTicketRefXml,
  formatTicketIdentifier,
} from "@/lib/tickets/references";

export interface TicketRefIdentity {
  projectName: string;
  number: number;
}

export function ticketIdentifier(identity: TicketRefIdentity): string {
  return formatTicketIdentifier(identity.projectName, identity.number);
}

export function ticketReferenceXml(
  identity: TicketRefIdentity & { title: string },
): string {
  return buildTicketRefXml({
    projectName: identity.projectName,
    ticketNumber: identity.number,
    title: identity.title,
  });
}
