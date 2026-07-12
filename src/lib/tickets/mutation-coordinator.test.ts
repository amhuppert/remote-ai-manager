import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { normalizeTicketListFilters } from "./list-filters";
import {
  beginTicketMutation,
  scheduleTicketCacheInvalidation,
} from "./mutation-coordinator";
import { ticketKeys } from "./query-keys";
import { ticketQueries } from "./queries";

describe("ticket mutation cache coordinator", () => {
  it("defers broad and same-ticket invalidation until an optimistic mutation releases", async () => {
    const client = new QueryClient();
    const listKey = ticketKeys.list(normalizeTicketListFilters({}));
    const detailKey = ticketKeys.detail("alpha", 1);
    const unrelatedKey = ticketKeys.detail("alpha", 2);
    client.setQueryData(listKey, []);
    client.setQueryData(detailKey, { id: "ticket-1" });
    client.setQueryData(unrelatedKey, { id: "ticket-2" });

    const release = await beginTicketMutation(client, "alpha", 1);
    scheduleTicketCacheInvalidation(client, {
      includeLists: true,
      details: [
        { projectName: "alpha", number: 1 },
        { projectName: "alpha", number: 2 },
      ],
    });

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(unrelatedKey)?.isInvalidated).toBe(true);

    release();

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(detailKey)?.isInvalidated).toBe(true);
  });

  it("holds a newly mounted list query until pending ticket mutations settle", async () => {
    const client = new QueryClient();
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchSpy);
    const release = await beginTicketMutation(client, "alpha", 1);

    try {
      const query = client.fetchQuery(ticketQueries.list({}));
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchSpy).not.toHaveBeenCalled();

      release();
      await expect(query).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not hold a project-scoped list behind another project's mutation", async () => {
    const client = new QueryClient();
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    vi.stubGlobal("fetch", fetchSpy);
    const release = await beginTicketMutation(client, "alpha", 1);

    try {
      const query = client.fetchQuery(
        ticketQueries.list({ projectName: "beta" }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledOnce();
      await expect(query).resolves.toEqual([]);
    } finally {
      release();
      vi.unstubAllGlobals();
    }
  });
});
