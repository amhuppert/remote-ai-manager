import { describe, expect, it } from "vitest";

import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  buildBoardAnnouncements,
  groupTicketsByStatus,
} from "./ticket-board-helpers";

function ticket(overrides: Partial<TicketListItem>): TicketListItem {
  return {
    id: "id-cc-12",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Virtualize the attachment index",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 5,
    activeSessionName: null,
    createdAt: "2026-06-25T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

const ITEMS: TicketListItem[] = [
  ticket({
    id: "a",
    number: 1,
    status: "not_started",
    updatedAt: "2026-07-09T10:00:00.000Z",
  }),
  ticket({
    id: "b",
    number: 2,
    status: "not_started",
    updatedAt: "2026-07-08T10:00:00.000Z",
  }),
  ticket({
    id: "c",
    number: 3,
    status: "in_progress",
    updatedAt: "2026-07-10T10:00:00.000Z",
  }),
  ticket({
    id: "d",
    number: 4,
    status: "done",
    updatedAt: "2026-07-07T10:00:00.000Z",
  }),
];

describe("groupTicketsByStatus", () => {
  it("groups items under every status, including empty columns", () => {
    const groups = groupTicketsByStatus(ITEMS);
    expect(groups.not_started.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups.in_progress.map((t) => t.id)).toEqual(["c"]);
    expect(groups.done.map((t) => t.id)).toEqual(["d"]);
    expect(groups.blocked).toEqual([]);
    expect(groups.closed).toEqual([]);
  });
});

describe("buildBoardAnnouncements", () => {
  const announcements = buildBoardAnnouncements();
  const active = {
    id: "a",
    data: {
      current: { ticket: ITEMS[0] },
    },
  };

  it("announces pickup with the ticket identifier", () => {
    const message = announcements.onDragStart({ active } as never);
    expect(message).toContain("command-center#1");
    expect(message).toContain("Picked up");
  });

  it("announces the hovered status without implying within-column order", () => {
    const message = announcements.onDragOver({
      active,
      over: { id: "in_progress" },
    } as never);
    expect(message).toContain("In Progress");
    expect(message).not.toContain("position");
  });

  it("announces the drop target on commit", () => {
    const message = announcements.onDragEnd({
      active,
      over: { id: "done" },
    } as never);
    expect(message).toContain("command-center#1");
    expect(message).toContain("Done");
  });

  it("announces cancellation with the home column", () => {
    const message = announcements.onDragCancel({ active } as never);
    expect(message).toContain("cancelled");
    expect(message).toContain("Not Started");
  });

  it("does not announce movement within a status column", () => {
    expect(
      announcements.onDragMove?.({
        active,
        over: { id: "not_started" },
      } as never),
    ).toBeUndefined();
  });
});
