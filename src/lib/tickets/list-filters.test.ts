import { describe, expect, it } from "vitest";

import type { TicketDetail, TicketListItem } from "./schemas";
import {
  compareTicketListItems,
  matchesTicketListFilters,
  normalizeTicketListFilters,
  removeTicketListItem,
  sortTicketListItems,
  ticketListItemFromDetail,
  ticketListSearchParams,
  upsertTicketListItem,
} from "./list-filters";

function item(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/projects/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "A ticket",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("normalizeTicketListFilters", () => {
  it("fills absent filters with null and defaults sort to updated", () => {
    expect(normalizeTicketListFilters({})).toEqual({
      projectName: null,
      status: null,
      workType: null,
      sort: "updated",
    });
  });

  it("preserves every provided filter and sort input", () => {
    expect(
      normalizeTicketListFilters({
        projectName: "alpha",
        status: "in_progress",
        workType: "bug",
        sort: "created",
      }),
    ).toEqual({
      projectName: "alpha",
      status: "in_progress",
      workType: "bug",
      sort: "created",
    });
  });
});

describe("matchesTicketListFilters", () => {
  it("matches everything when no filters are set", () => {
    const filters = normalizeTicketListFilters({});
    expect(matchesTicketListFilters(filters, item({ id: "t1" }))).toBe(true);
  });

  it("applies project, status, and work-type filters exactly", () => {
    const filters = normalizeTicketListFilters({
      projectName: "alpha",
      status: "in_progress",
      workType: "bug",
    });
    const matching = item({
      id: "t1",
      projectName: "alpha",
      status: "in_progress",
      workType: "bug",
    });
    expect(matchesTicketListFilters(filters, matching)).toBe(true);
    expect(
      matchesTicketListFilters(filters, {
        ...matching,
        projectName: "beta",
      }),
    ).toBe(false);
    expect(
      matchesTicketListFilters(filters, { ...matching, status: "done" }),
    ).toBe(false);
    expect(
      matchesTicketListFilters(filters, { ...matching, workType: "feature" }),
    ).toBe(false);
  });
});

describe("compareTicketListItems / sortTicketListItems", () => {
  // Mirrors the repo SQL: `updated_at DESC, id ASC` / `created_at DESC, id ASC`.
  it("orders by updatedAt descending with id ascending tie-break", () => {
    const older = item({ id: "b", updatedAt: "2026-07-01T00:00:00.000Z" });
    const newer = item({ id: "z", updatedAt: "2026-07-02T00:00:00.000Z" });
    const tieA = item({ id: "a", updatedAt: "2026-07-02T00:00:00.000Z" });

    const sorted = sortTicketListItems("updated", [older, newer, tieA]);
    expect(sorted.map((t) => t.id)).toEqual(["a", "z", "b"]);
  });

  it("orders by createdAt descending with id ascending tie-break", () => {
    const older = item({ id: "a", createdAt: "2026-06-01T00:00:00.000Z" });
    const newer = item({ id: "c", createdAt: "2026-06-03T00:00:00.000Z" });
    const tieB = item({ id: "b", createdAt: "2026-06-03T00:00:00.000Z" });

    const sorted = sortTicketListItems("created", [older, newer, tieB]);
    expect(sorted.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      item({ id: "b", updatedAt: "2026-07-01T00:00:00.000Z" }),
      item({ id: "a", updatedAt: "2026-07-02T00:00:00.000Z" }),
    ];
    const snapshot = [...input];
    sortTicketListItems("updated", input);
    expect(input).toEqual(snapshot);
  });

  it("compare is consistent with sort for equal timestamps and ids", () => {
    const a = item({ id: "same" });
    expect(compareTicketListItems("updated", a, { ...a })).toBe(0);
  });
});

describe("upsertTicketListItem", () => {
  it("inserts a matching item in shared-module order", () => {
    const filters = normalizeTicketListFilters({});
    const list = [
      item({ id: "t1", updatedAt: "2026-07-03T00:00:00.000Z" }),
      item({ id: "t2", updatedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    const incoming = item({ id: "t3", updatedAt: "2026-07-02T00:00:00.000Z" });

    const next = upsertTicketListItem(list, incoming, filters);
    expect(next.map((t) => t.id)).toEqual(["t1", "t3", "t2"]);
  });

  it("replaces an existing identity instead of duplicating it", () => {
    const filters = normalizeTicketListFilters({});
    const list = [
      item({ id: "t1", title: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
      item({ id: "t2", updatedAt: "2026-07-02T00:00:00.000Z" }),
    ];
    const incoming = item({
      id: "t1",
      title: "new",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });

    const next = upsertTicketListItem(list, incoming, filters);
    expect(next.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(next[0]?.title).toBe("new");
  });

  it("removes the identity when the updated item no longer matches the filters", () => {
    const filters = normalizeTicketListFilters({ status: "not_started" });
    const list = [item({ id: "t1", status: "not_started" })];
    const moved = item({ id: "t1", status: "in_progress" });

    expect(upsertTicketListItem(list, moved, filters)).toEqual([]);
  });

  it("is idempotent", () => {
    const filters = normalizeTicketListFilters({});
    const list = [item({ id: "t1" }), item({ id: "t2" })];
    const incoming = item({ id: "t3" });

    const once = upsertTicketListItem(list, incoming, filters);
    const twice = upsertTicketListItem(once, incoming, filters);
    expect(twice).toEqual(once);
  });
});

describe("removeTicketListItem", () => {
  it("removes by id and leaves other rows untouched", () => {
    const list = [item({ id: "t1" }), item({ id: "t2" })];
    expect(removeTicketListItem(list, "t1").map((t) => t.id)).toEqual(["t2"]);
    expect(removeTicketListItem(list, "missing")).toEqual(list);
  });
});

describe("ticketListSearchParams", () => {
  it("includes exactly the set filters plus the sort", () => {
    const params = ticketListSearchParams(
      normalizeTicketListFilters({ status: "done", sort: "created" }),
    );
    expect(params.toString()).toBe("status=done&sort=created");
  });

  it("names the global project filter param `project`", () => {
    const params = ticketListSearchParams(
      normalizeTicketListFilters({ projectName: "alpha", workType: "bug" }),
    );
    expect(params.get("project")).toBe("alpha");
    expect(params.get("workType")).toBe("bug");
    expect(params.get("sort")).toBe("updated");
  });
});

describe("ticketListItemFromDetail", () => {
  it("derives the lean list item, counting attachments and the open session link", () => {
    const detail: TicketDetail = {
      id: "t1",
      projectPath: "/projects/alpha",
      projectName: "alpha",
      number: 7,
      title: "Ticket",
      description: "",
      workType: "research",
      status: "in_progress",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      attachments: [
        {
          id: "a1",
          ticketId: "t1",
          description: "a note",
          payload: { kind: "note", markdown: "hi" },
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      sessions: [
        {
          id: "l1",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "old-session",
          sessionCreatedAt: null,
          startMode: "agent",
          linkedAt: "2026-06-30T00:00:00.000Z",
          endedAt: "2026-07-01T00:00:00.000Z",
          endReason: "finished",
        },
        {
          id: "l2",
          ticketId: "t1",
          projectPath: "/projects/alpha",
          sessionName: "live-session",
          sessionCreatedAt: "2026-07-01T11:59:59.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-01T12:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };

    expect(ticketListItemFromDetail(detail)).toEqual({
      id: "t1",
      projectPath: "/projects/alpha",
      projectName: "alpha",
      number: 7,
      title: "Ticket",
      workType: "research",
      status: "in_progress",
      attachmentCount: 1,
      activeSessionName: "live-session",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
  });
});
