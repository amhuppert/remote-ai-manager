import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  captureTicketEventCursor,
  ticketEventVersionSupersedes,
} from "./event-version";
import { normalizeTicketListFilters } from "./list-filters";
import { ticketKeys } from "./query-keys";
import type { TicketListItem } from "./schemas";

function item(updatedAt: string): TicketListItem {
  return {
    id: "ticket-1",
    projectPath: "/projects/alpha",
    projectName: "alpha",
    number: 1,
    title: "Ticket",
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt,
  };
}

describe("ticketEventVersionSupersedes", () => {
  it("keeps a newer cache refetch authoritative after a cursor was captured", () => {
    const client = new QueryClient();
    const listKey = ticketKeys.list(normalizeTicketListFilters({}));
    client.setQueryData(listKey, [item("2026-07-01T00:00:03.000Z")]);
    captureTicketEventCursor(client, "alpha", 1);
    client.setQueryData(listKey, [item("2026-07-01T00:00:06.000Z")]);

    expect(
      ticketEventVersionSupersedes(
        client,
        "alpha",
        1,
        "2026-07-01T00:00:05.000Z",
      ),
    ).toBe(true);
  });
});
