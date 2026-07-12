import { describe, expect, it } from "vitest";

import { parseTicketsPageState, ticketsPageHref } from "./ticket-url-state";

describe("parseTicketsPageState", () => {
  it("defaults to the list view with no filters and updated sort", () => {
    const state = parseTicketsPageState(new URLSearchParams());
    expect(state).toEqual({
      view: "list",
      filters: {
        projectName: null,
        status: null,
        workType: null,
        sort: "updated",
      },
    });
  });

  it("reads view, filters, and sort from the search params", () => {
    const state = parseTicketsPageState(
      new URLSearchParams(
        "view=board&project=command-center&status=done&type=bug&sort=created",
      ),
    );
    expect(state).toEqual({
      view: "board",
      filters: {
        projectName: "command-center",
        status: "done",
        workType: "bug",
        sort: "created",
      },
    });
  });

  it("ignores invalid enum values and unknown views", () => {
    const state = parseTicketsPageState(
      new URLSearchParams("view=nope&status=bogus&type=wat&sort=oldest"),
    );
    expect(state).toEqual({
      view: "list",
      filters: {
        projectName: null,
        status: null,
        workType: null,
        sort: "updated",
      },
    });
  });
});

describe("ticketsPageHref", () => {
  it("omits every default from the href", () => {
    expect(
      ticketsPageHref({
        view: "list",
        filters: {
          projectName: null,
          status: null,
          workType: null,
          sort: "updated",
        },
      }),
    ).toBe("/tickets");
  });

  it("serializes non-default state and encodes the project name", () => {
    expect(
      ticketsPageHref({
        view: "board",
        filters: {
          projectName: "my project",
          status: "in_progress",
          workType: "tech_debt",
          sort: "created",
        },
      }),
    ).toBe(
      "/tickets?view=board&project=my+project&status=in_progress&type=tech_debt&sort=created",
    );
  });

  it("round-trips through parseTicketsPageState", () => {
    const state = {
      view: "board" as const,
      filters: {
        projectName: "command-center",
        status: "blocked" as const,
        workType: "research" as const,
        sort: "created" as const,
      },
    };
    const href = ticketsPageHref(state);
    const search = href.split("?")[1] ?? "";
    expect(parseTicketsPageState(new URLSearchParams(search))).toEqual(state);
  });
});
