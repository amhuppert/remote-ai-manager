import { describe, expect, it, vi } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import type {
  TicketDetail,
  TicketListItem,
  TicketSessionLink,
} from "./schemas";
import { createTicketLifecycleObserver } from "./lifecycle";

const listItem: TicketListItem = {
  id: "ticket-7",
  projectPath: "/projects/alpha",
  projectName: "alpha",
  number: 7,
  title: "Keep the status",
  workType: "feature",
  status: "blocked",
  attachmentCount: 0,
  activeSessionName: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
};

const openLink: TicketSessionLink = {
  id: "link-7",
  ticketId: listItem.id,
  projectPath: listItem.projectPath,
  sessionName: "ticket-session",
  sessionCreatedAt: "2026-07-02T23:59:59.000Z",
  startMode: "agent",
  linkedAt: "2026-07-03T00:00:00.000Z",
  endedAt: null,
  endReason: null,
};

const detail: TicketDetail = {
  id: listItem.id,
  projectPath: listItem.projectPath,
  projectName: listItem.projectName,
  number: listItem.number,
  title: listItem.title,
  description: "",
  workType: listItem.workType,
  status: listItem.status,
  createdAt: listItem.createdAt,
  updatedAt: listItem.updatedAt,
  attachments: [],
  sessions: [openLink],
};

function makeDeps() {
  const events: SSEEvent[] = [];
  const repo = {
    findOpenSessionLink: vi.fn<() => Promise<TicketSessionLink | null>>(
      async () => openLink,
    ),
    findById: vi.fn<() => Promise<TicketDetail | null>>(async () => detail),
    endSessionLink: vi.fn(async ({ endedAt, endReason }) => ({
      ...openLink,
      endedAt,
      endReason,
    })),
    findListItem: vi.fn(async () => listItem),
    list: vi.fn(async () => [listItem]),
  };
  return {
    events,
    repo,
    observer: createTicketLifecycleObserver({
      repo,
      broadcast(event) {
        events.push(event);
      },
      now: () => "2026-07-04T00:00:00.000Z",
    }),
  };
}

describe("ticket session lifecycle observation", () => {
  it("demotes a finished session link, preserves ticket status, and publishes the lean session delta", async () => {
    const { observer, repo, events } = makeDeps();

    const reconciled = await observer.reconcileSession({
      projectPath: "/projects/alpha",
      sessionName: "ticket-session",
      endReason: "finished",
    });

    expect(reconciled).toBe(true);
    expect(repo.endSessionLink).toHaveBeenCalledWith({
      linkId: "link-7",
      endedAt: "2026-07-04T00:00:00.000Z",
      endReason: "finished",
    });
    expect(repo.findListItem).toHaveBeenCalledWith("/projects/alpha", 7);
    expect(events).toEqual([
      {
        type: "ticket-changed",
        change: "session",
        projectName: "alpha",
        ticketNumber: 7,
        listItem,
        attachmentIndexChanged: false,
        linkedSessionName: "ticket-session",
      },
    ]);
    expect(listItem.status).toBe("blocked");
  });

  it("does nothing when the session has no open ticket link", async () => {
    const { observer, repo, events } = makeDeps();
    repo.findOpenSessionLink.mockResolvedValue(null);

    await expect(
      observer.reconcileSession({
        projectPath: "/projects/alpha",
        sessionName: "unlinked",
        endReason: "deleted",
      }),
    ).resolves.toBe(false);

    expect(repo.endSessionLink).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("ticket project deletion observation", () => {
  it("captures ticket identities before the cascade and publishes a deletion delta for each afterward", async () => {
    const { observer, repo, events } = makeDeps();
    repo.list.mockResolvedValue([
      listItem,
      { ...listItem, id: "ticket-8", number: 8 },
    ]);

    const snapshot = await observer.captureProjectDeletion("/projects/alpha");
    observer.publishProjectDeletion(snapshot);

    expect(repo.list).toHaveBeenCalledWith({
      projectPath: "/projects/alpha",
      sort: "updated",
    });
    expect(events).toEqual([
      {
        type: "ticket-changed",
        change: "deleted",
        projectName: "alpha",
        ticketNumber: 7,
        listItem: null,
        attachmentIndexChanged: false,
      },
      {
        type: "ticket-changed",
        change: "deleted",
        projectName: "alpha",
        ticketNumber: 8,
        listItem: null,
        attachmentIndexChanged: false,
      },
    ]);
  });
});
