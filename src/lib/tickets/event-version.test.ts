import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  captureTicketEventCursor,
  isStaleTicketChangedEvent,
  rememberAuthoritativeTicketDeletion,
  rememberTicketChangedEvent,
  ticketEventVersionSupersedes,
} from "./event-version";
import { normalizeTicketListFilters } from "./list-filters";
import { ticketKeys } from "./query-keys";
import type { TicketChangedEvent, TicketListItem } from "./schemas";

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

describe("isStaleTicketChangedEvent", () => {
  it("accepts the first SSE frame at an HTTP-cached revision", () => {
    const client = new QueryClient();
    const updatedAt = "2026-08-02T00:00:00.000Z";
    client.setQueryData(ticketKeys.list(normalizeTicketListFilters({})), [
      item(updatedAt),
    ]);

    expect(
      isStaleTicketChangedEvent(client, {
        type: "ticket-changed",
        change: "status_updates",
        projectName: "alpha",
        ticketNumber: 1,
        listItem: item(updatedAt),
        attachmentIndexChanged: false,
      }),
    ).toBe(false);
  });

  it.each(["relationships", "status_updates"] as const)(
    "treats duplicate and older %s revisions as stale",
    (change) => {
      const client = new QueryClient();
      const event: TicketChangedEvent = {
        type: "ticket-changed",
        change,
        projectName: "alpha",
        ticketNumber: 1,
        listItem: item("2026-08-02T00:00:00.000Z"),
        attachmentIndexChanged: false,
      };

      expect(isStaleTicketChangedEvent(client, event)).toBe(false);
      rememberTicketChangedEvent(client, event);

      expect(isStaleTicketChangedEvent(client, event)).toBe(true);
      expect(
        isStaleTicketChangedEvent(client, {
          ...event,
          listItem: item("2026-08-01T00:00:00.000Z"),
        }),
      ).toBe(true);
    },
  );

  it.each(["relationships", "status_updates"] as const)(
    "rejects %s after an authoritative deletion",
    (change) => {
      const client = new QueryClient();
      rememberAuthoritativeTicketDeletion(client, "alpha", 1);

      expect(
        isStaleTicketChangedEvent(client, {
          type: "ticket-changed",
          change,
          projectName: "alpha",
          ticketNumber: 1,
          listItem: item("2099-01-01T00:00:00.000Z"),
          attachmentIndexChanged: false,
        }),
      ).toBe(true);
    },
  );
});
