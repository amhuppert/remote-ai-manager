import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidateTicketSessionLifecycle } from "./cache-lifecycle";
import { normalizeTicketListFilters } from "./list-filters";
import { beginTicketMutation } from "./mutation-coordinator";
import { ticketKeys } from "./query-keys";

describe("invalidateTicketSessionLifecycle", () => {
  it("defers ticket list and detail refetches behind a pending mutation", async () => {
    const client = new QueryClient();
    const listKey = ticketKeys.list(normalizeTicketListFilters({}));
    const detailKey = ticketKeys.detail("alpha", 1);
    const linksKey = ticketKeys.sessionLinks("alpha");
    client.setQueryData(listKey, []);
    client.setQueryData(detailKey, { id: "ticket-1" });
    client.setQueryData(linksKey, {
      session: {
        ticketId: "ticket-1",
        projectName: "alpha",
        number: 1,
        title: "Ticket",
        active: true,
        linkedAt: "2026-07-01T00:00:00.000Z",
        endedAt: null,
      },
    });
    const release = await beginTicketMutation(client, "alpha", 1);

    invalidateTicketSessionLifecycle(client, "alpha", ["session"]);

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(linksKey)?.isInvalidated).toBe(true);

    release();

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });
});
