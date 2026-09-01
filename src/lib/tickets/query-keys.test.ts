import { describe, expect, it } from "vitest";

import { normalizeTicketListFilters } from "./list-filters";
import { ticketKeys, ticketListFiltersFromQueryKey } from "./query-keys";

describe("ticketKeys", () => {
  it("embeds every filter and sort input in the list key", () => {
    const filters = normalizeTicketListFilters({
      projectName: "alpha",
      statuses: ["done", "closed"],
      workType: "bug",
      sort: "created",
    });
    expect(ticketKeys.list(filters)).toEqual([
      "tickets",
      "list",
      {
        projectName: "alpha",
        statuses: ["done", "closed"],
        workType: "bug",
        sort: "created",
      },
    ]);
  });

  it("nests detail and session-link keys under the tickets root", () => {
    expect(ticketKeys.detail("alpha", 7)).toEqual([
      "tickets",
      "detail",
      "alpha",
      7,
    ]);
    expect(ticketKeys.sessionLinks("alpha")).toEqual([
      "tickets",
      "session-links",
      "alpha",
    ]);
    expect(ticketKeys.sessionLinksAll()).toEqual(["tickets", "session-links"]);
    expect(ticketKeys.lists()).toEqual(["tickets", "list"]);
    expect(ticketKeys.statusUpdates("alpha", 7)).toEqual([
      "tickets",
      "detail",
      "alpha",
      7,
      "status-updates",
    ]);
    expect(ticketKeys.relationships("alpha", 7, "depends_on")).toEqual([
      "tickets",
      "detail",
      "alpha",
      7,
      "relationships",
      { role: "depends_on" },
    ]);
  });
});

describe("ticketListFiltersFromQueryKey", () => {
  it("round-trips the typed filters out of a list key", () => {
    const filters = normalizeTicketListFilters({
      projectName: "alpha",
      sort: "updated",
    });
    expect(ticketListFiltersFromQueryKey(ticketKeys.list(filters))).toEqual(
      filters,
    );
  });

  it("returns null for non-list keys and malformed filters", () => {
    expect(ticketListFiltersFromQueryKey(ticketKeys.detail("alpha", 7))).toBe(
      null,
    );
    expect(ticketListFiltersFromQueryKey(["tickets", "list"])).toBe(null);
    expect(
      ticketListFiltersFromQueryKey(["tickets", "list", { sort: "nope" }]),
    ).toBe(null);
  });
});
