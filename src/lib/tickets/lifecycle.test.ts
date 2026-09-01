import { describe, expect, it, vi } from "vitest";

import type { SSEEvent } from "@/lib/api/sse-events";
import type {
  TicketSessionEndReason,
  TicketDetail,
  TicketListItem,
  TicketSessionLink,
} from "./schemas";
import { ticketChangedEventSchema } from "./schemas";
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
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

function makeDeps() {
  const events: SSEEvent[] = [];
  const repo = {
    findOpenSessionLink: vi.fn<
      (
        projectPath: string,
        sessionName: string,
      ) => Promise<TicketSessionLink | null>
    >(async () => openLink),
    findById: vi.fn<(ticketId: string) => Promise<TicketDetail | null>>(
      async () => detail,
    ),
    endSessionLink: vi.fn<
      (input: {
        linkId: string;
        endedAt: string;
        endReason: TicketSessionEndReason;
      }) => Promise<TicketSessionLink | null>
    >(async ({ endedAt, endReason }) => ({
      ...openLink,
      endedAt,
      endReason,
    })),
    findListItem: vi.fn<
      (projectPath: string, number: number) => Promise<TicketListItem | null>
    >(async () => listItem),
    list: vi.fn<
      (input: {
        projectPath: string;
        sort: "updated";
      }) => Promise<TicketListItem[]>
    >(async () => [listItem]),
    listExternalRelationshipNeighborIds: vi.fn<
      (projectPath: string) => Promise<string[]>
    >(async () => []),
  };
  return {
    events,
    repo,
    observer: createTicketLifecycleObserver({
      repo,
      publish(event) {
        events.push(event);
        return { delivered: true };
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
  it("captures ticket and external-neighbor identities before the cascade, then publishes deletions before survivor refreshes", async () => {
    const { observer, repo, events } = makeDeps();
    repo.list.mockResolvedValue([
      listItem,
      { ...listItem, id: "ticket-8", number: 8 },
    ]);
    const externalListItem: TicketListItem = {
      ...listItem,
      id: "ticket-external",
      projectPath: "/projects/beta",
      projectName: "beta",
      number: 3,
      title: "External survivor",
      updatedAt: "2026-07-04T00:00:00.000Z",
    };
    repo.listExternalRelationshipNeighborIds.mockResolvedValue([
      externalListItem.id,
    ]);
    repo.findById.mockImplementation(async (ticketId) =>
      ticketId === externalListItem.id
        ? {
            ...detail,
            ...externalListItem,
            description: "",
            attachments: [],
            sessions: [],
            relationships: [],
            statusUpdates: { total: 0, recent: [] },
          }
        : detail,
    );
    repo.findListItem.mockImplementation(async (projectPath, number) =>
      projectPath === externalListItem.projectPath &&
      number === externalListItem.number
        ? externalListItem
        : listItem,
    );

    const snapshot = await observer.captureProjectDeletion("/projects/alpha");
    await observer.publishProjectDeletion(snapshot);

    expect(repo.list).toHaveBeenCalledWith({
      projectPath: "/projects/alpha",
      sort: "updated",
    });
    expect(repo.listExternalRelationshipNeighborIds).toHaveBeenCalledWith(
      "/projects/alpha",
    );
    expect(snapshot.externalNeighborTicketIds).toEqual([externalListItem.id]);
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
      {
        type: "ticket-changed",
        change: "relationships",
        projectName: "beta",
        ticketNumber: 3,
        listItem: externalListItem,
        attachmentIndexChanged: false,
      },
    ]);
  });

  it("skips an external neighbor that was deleted before publication", async () => {
    const { observer, repo, events } = makeDeps();
    repo.listExternalRelationshipNeighborIds.mockResolvedValue(["vanished"]);
    const snapshot = await observer.captureProjectDeletion("/projects/alpha");
    repo.findById.mockResolvedValue(null);

    await observer.publishProjectDeletion(snapshot);

    expect(
      events.map((event) => ticketChangedEventSchema.parse(event).change),
    ).toEqual(["deleted"]);
  });
});
