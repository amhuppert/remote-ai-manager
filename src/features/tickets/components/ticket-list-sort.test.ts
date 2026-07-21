import { describe, expect, it } from "vitest";

import type { TicketListItem } from "@/lib/tickets/schemas";
import { sortTicketsForDisplay } from "./ticket-list-sort";

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

describe("sortTicketsForDisplay", () => {
  it("sorts by ticket identity: project name, then number", () => {
    const rows = [
      item({ id: "b", projectName: "beta", number: 1 }),
      item({ id: "a2", projectName: "alpha", number: 12 }),
      item({ id: "a1", projectName: "alpha", number: 3 }),
    ];
    expect(
      sortTicketsForDisplay({ column: "ticket", direction: "asc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["a1", "a2", "b"]);
    expect(
      sortTicketsForDisplay({ column: "ticket", direction: "desc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["b", "a2", "a1"]);
  });

  it("sorts titles case-insensitively", () => {
    const rows = [
      item({ id: "z", title: "zebra crossing" }),
      item({ id: "b", title: "Banana peel" }),
      item({ id: "a", title: "apple pie" }),
    ];
    expect(
      sortTicketsForDisplay({ column: "title", direction: "asc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "b", "z"]);
  });

  it("sorts type and status in their canonical display order", () => {
    const rows = [
      item({ id: "perf", workType: "performance" }),
      item({ id: "bug", workType: "bug" }),
      item({ id: "feat", workType: "feature" }),
    ];
    expect(
      sortTicketsForDisplay({ column: "type", direction: "asc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["feat", "bug", "perf"]);

    const byStatus = [
      item({ id: "done", status: "done" }),
      item({ id: "blocked", status: "blocked" }),
      item({ id: "wip", status: "in_progress" }),
    ];
    expect(
      sortTicketsForDisplay(
        { column: "status", direction: "asc" },
        byStatus,
      ).map((row) => row.id),
    ).toEqual(["wip", "done", "blocked"]);
  });

  it("sorts ctx by attachment count and updated by recency", () => {
    const rows = [
      item({ id: "none", attachmentCount: 0 }),
      item({ id: "many", attachmentCount: 6 }),
      item({ id: "some", attachmentCount: 2 }),
    ];
    expect(
      sortTicketsForDisplay({ column: "ctx", direction: "desc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["many", "some", "none"]);

    const byTime = [
      item({ id: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
      item({ id: "new", updatedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    expect(
      sortTicketsForDisplay(
        { column: "updated", direction: "desc" },
        byTime,
      ).map((row) => row.id),
    ).toEqual(["new", "old"]);
  });

  it("breaks ties by id ascending regardless of direction, without mutating input", () => {
    const rows = [
      item({ id: "b", attachmentCount: 1 }),
      item({ id: "a", attachmentCount: 1 }),
    ];
    const snapshot = [...rows];
    expect(
      sortTicketsForDisplay({ column: "ctx", direction: "desc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      sortTicketsForDisplay({ column: "ctx", direction: "asc" }, rows).map(
        (row) => row.id,
      ),
    ).toEqual(["a", "b"]);
    expect(rows).toEqual(snapshot);
  });
});
