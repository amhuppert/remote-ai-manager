"use client";

import type { TicketRefAttrs } from "@/lib/tickets/schemas";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { LiveReferenceChip } from "@/components/references/LiveReferenceChip";

export default function TicketRefLinkChip({
  attrs,
}: {
  attrs: TicketRefAttrs;
}): React.JSX.Element {
  return (
    <LiveReferenceChip
      target={{
        kind: "ticket",
        projectName: attrs["project-name"],
        id: attrs["ticket-number"],
      }}
      title={attrs.title}
      identity={attrs.identifier}
      reference={buildTicketRefXml({
        projectName: attrs["project-name"],
        ticketNumber: Number(attrs["ticket-number"]),
        title: attrs.title,
      })}
    />
  );
}
