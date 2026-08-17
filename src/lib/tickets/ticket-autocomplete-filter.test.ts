import { describe, expect, it } from "vitest";
import type { TicketListItem } from "./schemas";
import {
  filterAndScoreTickets,
  MAX_DISPLAY_TICKETS,
} from "./ticket-autocomplete-filter";

function ticket(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath:
      overrides.projectPath ?? `/repos/${overrides.projectName ?? "alpha"}`,
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "Ticket title",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

describe("filterAndScoreTickets", () => {
  it("puts current-project tickets first for an empty query", () => {
    const result = filterAndScoreTickets(
      "",
      [
        ticket({ id: "other", projectName: "beta", number: 2 }),
        ticket({ id: "current", projectName: "alpha", number: 3 }),
      ],
      { currentProjectName: "alpha" },
    );

    expect(result.items.map(({ item }) => item.id)).toEqual([
      "current",
      "other",
    ]);
  });

  it("matches title, identifier, and project name", () => {
    const items = [
      ticket({ id: "title", title: "Harden authentication", number: 4 }),
      ticket({ id: "identifier", title: "Unrelated", number: 42 }),
      ticket({
        id: "project",
        projectName: "billing-api",
        title: "Unrelated",
        number: 7,
      }),
    ];

    expect(
      filterAndScoreTickets("auth", items, {
        currentProjectName: null,
      }).items.map(({ item }) => item.id),
    ).toEqual(["title"]);
    expect(
      filterAndScoreTickets("alpha42", items, {
        currentProjectName: null,
      }).items.map(({ item }) => item.id),
    ).toEqual(["identifier"]);
    expect(
      filterAndScoreTickets("billing", items, {
        currentProjectName: null,
      }).items.map(({ item }) => item.id),
    ).toEqual(["project"]);
  });

  it("returns title match indices for highlighted rendering", () => {
    const result = filterAndScoreTickets(
      "auth",
      [ticket({ id: "t", title: "Harden authentication" })],
      { currentProjectName: "alpha" },
    );

    expect(result.items[0]?.titleMatchIndices).toEqual([7, 8, 9, 10]);
  });

  it("withholds done and closed tickets by default and counts them", () => {
    const items = [
      ticket({ id: "active", title: "Match live", status: "in_progress" }),
      ticket({ id: "blocked", title: "Match stuck", status: "blocked" }),
      ticket({ id: "done", title: "Match shipped", status: "done" }),
      ticket({ id: "closed", title: "Match dropped", status: "closed" }),
    ];

    const result = filterAndScoreTickets("match", items, {
      currentProjectName: "alpha",
    });

    expect(result.items.map(({ item }) => item.id)).toEqual([
      "active",
      "blocked",
    ]);
    expect(result.totalCount).toBe(2);
    expect(result.hiddenDoneCount).toBe(2);
  });

  it("includes done and closed tickets when asked, ranked last", () => {
    const items = [
      ticket({ id: "done", title: "Match shipped", status: "done" }),
      ticket({ id: "active", title: "Match live", status: "in_progress" }),
    ];

    const result = filterAndScoreTickets("match", items, {
      currentProjectName: "alpha",
      includeDone: true,
    });

    expect(result.items.map(({ item }) => item.id)).toEqual(["active", "done"]);
    expect(result.hiddenDoneCount).toBe(0);
  });

  it("counts only tickets the query matched as hidden", () => {
    const result = filterAndScoreTickets(
      "shipped",
      [
        ticket({ id: "done-match", title: "Match shipped", status: "done" }),
        ticket({ id: "done-other", title: "Unrelated", status: "done" }),
      ],
      { currentProjectName: "alpha" },
    );

    expect(result.hiddenDoneCount).toBe(1);
  });

  it("caps displayed results while preserving the total match count", () => {
    const items = Array.from({ length: MAX_DISPLAY_TICKETS + 5 }, (_, index) =>
      ticket({ id: `t-${index}`, title: `Match ${index}`, number: index + 1 }),
    );
    const result = filterAndScoreTickets("match", items, {
      currentProjectName: null,
    });

    expect(result.items).toHaveLength(MAX_DISPLAY_TICKETS);
    expect(result.totalCount).toBe(MAX_DISPLAY_TICKETS + 5);
  });
});
