import { describe, expect, it } from "vitest";

import {
  DEFAULT_TICKET_LIST_SORT,
  parseTicketsPageState,
  ticketSortNaturalDirection,
  ticketsPageHref,
} from "./ticket-url-state";

describe("parseTicketsPageState", () => {
  it("defaults to the board view, open statuses, updated-desc sort, no selection", () => {
    const state = parseTicketsPageState(new URLSearchParams());
    expect(state).toEqual({
      view: "board",
      filters: {
        projectName: null,
        statuses: ["not_started", "in_progress", "blocked"],
        workType: null,
        sort: "updated",
      },
      listSort: { column: "updated", direction: "desc" },
      selected: null,
    });
  });

  it("reads view, filters, column sort, and the selected ticket", () => {
    const state = parseTicketsPageState(
      new URLSearchParams(
        "view=list&project=command-center&status=done,closed&type=bug&sort=title&dir=desc&t=command-center%2314",
      ),
    );
    expect(state).toEqual({
      view: "list",
      filters: {
        projectName: "command-center",
        statuses: ["done", "closed"],
        workType: "bug",
        sort: "updated",
      },
      listSort: { column: "title", direction: "desc" },
      selected: { projectName: "command-center", number: 14 },
    });
  });

  it("maps status=all to no status filter", () => {
    expect(
      parseTicketsPageState(new URLSearchParams("status=all")).filters.statuses,
    ).toBeNull();
  });

  it("drops invalid status tokens and falls back to the open set when none survive", () => {
    expect(
      parseTicketsPageState(new URLSearchParams("status=done,bogus")).filters
        .statuses,
    ).toEqual(["done"]);
    expect(
      parseTicketsPageState(new URLSearchParams("status=bogus")).filters
        .statuses,
    ).toEqual(["not_started", "in_progress", "blocked"]);
  });

  it("ignores invalid views, sorts, directions, and selections", () => {
    const state = parseTicketsPageState(
      new URLSearchParams("view=nope&sort=oldest&dir=sideways&t=garbage"),
    );
    expect(state.view).toBe("board");
    expect(state.listSort).toEqual(DEFAULT_TICKET_LIST_SORT);
    expect(state.selected).toBeNull();
    expect(
      parseTicketsPageState(new URLSearchParams("t=alpha%23zero")).selected,
    ).toBeNull();
  });

  it("defaults the direction to the column's natural direction", () => {
    expect(
      parseTicketsPageState(new URLSearchParams("sort=title")).listSort,
    ).toEqual({ column: "title", direction: "asc" });
    expect(
      parseTicketsPageState(new URLSearchParams("sort=ctx")).listSort,
    ).toEqual({ column: "ctx", direction: "desc" });
  });
});

describe("ticketSortNaturalDirection", () => {
  it("sorts text columns ascending and recency/count columns descending", () => {
    expect(ticketSortNaturalDirection("ticket")).toBe("asc");
    expect(ticketSortNaturalDirection("title")).toBe("asc");
    expect(ticketSortNaturalDirection("type")).toBe("asc");
    expect(ticketSortNaturalDirection("status")).toBe("asc");
    expect(ticketSortNaturalDirection("ctx")).toBe("desc");
    expect(ticketSortNaturalDirection("updated")).toBe("desc");
  });
});

describe("ticketsPageHref", () => {
  const defaults = parseTicketsPageState(new URLSearchParams());

  it("omits every default from the href", () => {
    expect(ticketsPageHref(defaults)).toBe("/tickets");
  });

  it("serializes non-default state and encodes the project name", () => {
    expect(
      ticketsPageHref({
        view: "list",
        filters: {
          projectName: "my project",
          statuses: ["in_progress"],
          workType: "tech_debt",
          sort: "updated",
        },
        listSort: { column: "title", direction: "desc" },
        selected: { projectName: "my project", number: 7 },
      }),
    ).toBe(
      "/tickets?view=list&project=my+project&status=in_progress&type=tech_debt&sort=title&dir=desc&t=my+project%237",
    );
  });

  it("writes status=all for the no-status-filter state", () => {
    expect(
      ticketsPageHref({
        ...defaults,
        filters: { ...defaults.filters, statuses: null },
      }),
    ).toBe("/tickets?status=all");
  });

  it("drops the selection outside the list view", () => {
    expect(
      ticketsPageHref({
        ...defaults,
        view: "board",
        selected: { projectName: "alpha", number: 3 },
      }),
    ).toBe("/tickets");
  });

  it("round-trips through parseTicketsPageState", () => {
    const state = {
      view: "list" as const,
      filters: {
        projectName: "command-center",
        statuses: ["blocked" as const, "closed" as const],
        workType: "research" as const,
        sort: "updated" as const,
      },
      listSort: { column: "status" as const, direction: "desc" as const },
      selected: { projectName: "command-center", number: 12 },
    };
    const href = ticketsPageHref(state);
    const search = href.split("?")[1] ?? "";
    expect(parseTicketsPageState(new URLSearchParams(search))).toEqual(state);
  });
});
