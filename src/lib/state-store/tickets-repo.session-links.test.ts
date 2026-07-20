import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createTicketsRepo, type TicketsRepo } from "./tickets-repo";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import { ticketSessionLinkSchema, type Ticket } from "@/lib/tickets/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";

let db: Db;
let queue: WriteQueue;
let repo: TicketsRepo;
let seq = 0;

function insertSession(
  sessionName: string,
  createdAt: string,
  opts: { finished?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at, finished)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    sessionName,
    `/wt/${sessionName}`,
    `csm/${sessionName}`,
    createdAt,
    createdAt,
    opts.finished ? 1 : 0,
  );
}

function deleteSession(sessionName: string): void {
  db.prepare(
    `DELETE FROM sessions WHERE project_path = ? AND session_name = ?`,
  ).run(PROJECT_PATH, sessionName);
}

async function createTicket(
  overrides: Partial<Omit<Ticket, "number">> = {},
): Promise<Ticket> {
  seq += 1;
  return repo.create({
    id: `t-${seq}`,
    projectPath: PROJECT_PATH,
    title: `Ticket ${seq}`,
    description: "",
    workType: "feature",
    status: "not_started",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeLinkInput(
  ticket: Ticket,
  sessionName: string,
  overrides: Partial<{
    id: string;
    startMode: "agent" | "prepared";
    linkedAt: string;
    sessionCreatedAt: string;
  }> = {},
) {
  seq += 1;
  return {
    id: `l-${seq}`,
    projectPath: ticket.projectPath,
    number: ticket.number,
    sessionName,
    startMode: "agent" as const,
    linkedAt: "2026-07-05T00:00:00.000Z",
    sessionCreatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  queue = createWriteQueue();
  repo = createTicketsRepo(db, queue);
});

afterEach(() => {
  db.close();
});

describe("linkStartedSession", () => {
  it("inserts the active link and sets the ticket to in_progress in one write", async () => {
    const ticket = await createTicket();
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");

    const detail = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work"),
    );

    expect(detail.status).toBe("in_progress");
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]?.sessionName).toBe("csm/work");
    expect(detail.sessions[0]?.sessionCreatedAt).toBe(
      "2026-07-04T00:00:00.000Z",
    );
    expect(detail.sessions[0]?.endedAt).toBeNull();
    expect(detail.updatedAt).toBe("2026-07-05T00:00:00.000Z");
  });

  it("rejects a second active link for the same ticket", async () => {
    const ticket = await createTicket();
    insertSession("csm/one", "2026-07-04T00:00:00.000Z");
    insertSession("csm/two", "2026-07-04T00:00:00.000Z");
    await repo.linkStartedSession(makeLinkInput(ticket, "csm/one"));

    await expect(
      repo.linkStartedSession(makeLinkInput(ticket, "csm/two")),
    ).rejects.toThrow(/UNIQUE/);

    // The failed link attempt must not have altered the ticket row.
    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.sessions).toHaveLength(1);
  });

  it("rejects a link for an unknown ticket", async () => {
    const ticket = await createTicket();
    await expect(
      repo.linkStartedSession(
        makeLinkInput({ ...ticket, number: 99 }, "csm/work"),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["missing", undefined],
    ["finished", { finished: true }],
  ] as const)(
    "rejects a %s target session inside the link transaction",
    async (_case, options) => {
      const ticket = await createTicket();
      if (options !== undefined) {
        insertSession("csm/work", "2026-07-04T00:00:00.000Z", options);
      }

      await expect(
        repo.linkStartedSession(makeLinkInput(ticket, "csm/work")),
      ).rejects.toThrow(/session/i);

      const detail = await repo.find(PROJECT_PATH, ticket.number);
      expect(detail?.status).toBe("not_started");
      expect(detail?.sessions).toEqual([]);
    },
  );

  it("rejects a replacement session with the same name but another incarnation", async () => {
    const ticket = await createTicket();
    insertSession("csm/work", "2026-07-04T00:00:01.000Z");

    await expect(
      repo.linkStartedSession(
        makeLinkInput(ticket, "csm/work", {
          sessionCreatedAt: "2026-07-04T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/session/i);

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.sessions).toEqual([]);
  });

  it("atomically demotes stale links, commits refreshed conversation payloads, and starts the ticket", async () => {
    const ticket = await createTicket();
    const originalPayload = {
      kind: "conversation" as const,
      projectPath: PROJECT_PATH,
      sessionName: "csm/old",
      conversationId: "conversation-1",
      snapshotKey: "t-1/attachment-1/original.md",
      snapshotCapturedAt: "2026-07-01T00:00:00.000Z",
    };
    await repo.addAttachment({
      id: "attachment-1",
      ticketId: ticket.id,
      description: "Earlier investigation",
      payload: originalPayload,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    insertSession("csm/old", "2026-07-02T00:00:00.000Z");
    const first = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/old", {
        linkedAt: "2026-07-03T00:00:00.000Z",
        sessionCreatedAt: "2026-07-02T00:00:00.000Z",
      }),
    );
    db.prepare(
      `UPDATE sessions SET finished = 1 WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, "csm/old");
    insertSession("csm/new", "2026-07-04T00:00:00.000Z");
    const refreshedPayload = {
      ...originalPayload,
      snapshotKey: "t-1/attachment-1/refreshed.md",
      snapshotCapturedAt: "2026-07-05T00:00:00.000Z",
    };

    const detail = await repo.linkStartedSession({
      ...makeLinkInput(ticket, "csm/new", {
        linkedAt: "2026-07-06T00:00:00.000Z",
      }),
      staleLinkDemotions: [
        {
          linkId: first.sessions[0]?.id ?? "",
          endedAt: "2026-07-06T00:00:00.000Z",
          endReason: "finished" as const,
        },
      ],
      conversationSnapshotUpdates: [
        {
          attachmentId: "attachment-1",
          previousPayload: originalPayload,
          payload: refreshedPayload,
          updatedAt: "2026-07-06T00:00:00.000Z",
        },
      ],
    });

    expect(detail.status).toBe("in_progress");
    expect(detail.sessions).toHaveLength(2);
    expect(detail.sessions[0]).toMatchObject({
      sessionName: "csm/old",
      endedAt: "2026-07-06T00:00:00.000Z",
      endReason: "finished",
    });
    expect(detail.sessions[1]).toMatchObject({
      sessionName: "csm/new",
      endedAt: null,
    });
    expect(detail.attachments[0]?.payload).toEqual(refreshedPayload);
    expect(detail.attachments[0]?.updatedAt).toBe(detail.updatedAt);
  });

  it("rolls back the link when conversation snapshot adoption loses its compare-and-swap", async () => {
    const ticket = await createTicket();
    const pendingPayload = {
      kind: "conversation" as const,
      projectPath: PROJECT_PATH,
      sessionName: "csm/origin",
      conversationId: "conversation-1",
      snapshotKey: null,
      snapshotCapturedAt: null,
      snapshotStatus: "pending" as const,
    };
    const winnerPayload = {
      ...pendingPayload,
      snapshotKey: "t-1/attachment-1/winner.md",
      snapshotCapturedAt: "2026-07-02T00:00:00.000Z",
      snapshotStatus: "captured" as const,
    };
    await repo.addAttachment({
      id: "attachment-1",
      ticketId: ticket.id,
      description: "Earlier investigation",
      payload: winnerPayload,
      createdAt: "2026-07-02T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const before = await repo.find(PROJECT_PATH, ticket.number);
    insertSession("csm/new", "2026-07-04T00:00:00.000Z");
    const loserPayload = {
      ...winnerPayload,
      snapshotKey: "t-1/attachment-1/loser.md",
      snapshotCapturedAt: "2026-07-05T00:00:00.000Z",
    };

    await expect(
      repo.linkStartedSession({
        ...makeLinkInput(ticket, "csm/new"),
        conversationSnapshotUpdates: [
          {
            attachmentId: "attachment-1",
            previousPayload: pendingPayload,
            payload: loserPayload,
            updatedAt: "2026-07-05T00:00:00.000Z",
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "ConversationSnapshotSwapError",
      result: { status: "lost", currentPayload: winnerPayload },
    });

    const after = await repo.find(PROJECT_PATH, ticket.number);
    expect(after?.status).toBe("not_started");
    expect(after?.sessions).toEqual([]);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.attachments[0]?.payload).toEqual(winnerPayload);
    expect(after?.attachments[0]?.updatedAt).toBe(
      before?.attachments[0]?.updatedAt,
    );
  });
});

describe("active vs historical derivation (instance guard)", () => {
  it("findLinkedTicket returns the ticket for a live guarded link", async () => {
    const ticket = await createTicket({ title: "Linked" });
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    await repo.linkStartedSession(makeLinkInput(ticket, "csm/work"));

    const linked = await repo.findLinkedTicket(PROJECT_PATH, "csm/work");
    expect(linked?.title).toBe("Linked");
    expect(linked).not.toHaveProperty("sessions");
  });

  it("returns null for sessions without a link and for ended links", async () => {
    const ticket = await createTicket();
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    expect(await repo.findLinkedTicket(PROJECT_PATH, "csm/work")).toBeNull();

    const detail = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work"),
    );
    const linkId = detail.sessions[0]?.id ?? "";
    await repo.endSessionLink({
      linkId,
      endedAt: "2026-07-06T00:00:00.000Z",
      endReason: "finished",
    });

    expect(await repo.findLinkedTicket(PROJECT_PATH, "csm/work")).toBeNull();
  });

  it("a logical link revision never makes a replacement incarnation look active", async () => {
    const ticket = await createTicket({
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work", {
        linkedAt: "2026-07-05T00:00:00.000Z",
      }),
    );

    // The parent ticket's future logical revision makes linkedAt later than
    // both incarnations. Only the persisted incarnation token distinguishes B.
    deleteSession("csm/work");
    insertSession("csm/work", "2026-07-08T00:00:00.000Z");

    expect(await repo.findLinkedTicket(PROJECT_PATH, "csm/work")).toBeNull();
    const links = await repo.listSessionLinks(PROJECT_PATH);
    expect(links["csm/work"]).toBeUndefined();
    const items = await repo.list({
      projectPath: PROJECT_PATH,
      sort: "updated",
    });
    expect(items[0]?.activeSessionName).toBeNull();
  });

  it("keeps an unknowable legacy incarnation historical", async () => {
    const ticket = await createTicket();
    insertSession("csm/legacy", "2026-07-04T00:00:00.000Z");
    db.prepare(
      `INSERT INTO ticket_sessions
         (id, ticket_id, project_path, session_name, session_created_at,
          start_mode, linked_at, ended_at, end_reason)
       VALUES (?, ?, ?, ?, NULL, 'agent', ?, NULL, NULL)`,
    ).run(
      "legacy-link",
      ticket.id,
      PROJECT_PATH,
      "csm/legacy",
      "2026-07-05T00:00:00.000Z",
    );

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.sessions[0]?.sessionCreatedAt).toBeNull();
    expect(await repo.findLinkedTicket(PROJECT_PATH, "csm/legacy")).toBeNull();
    expect(
      (await repo.listSessionLinks(PROJECT_PATH))["csm/legacy"],
    ).toBeUndefined();
  });

  it("a finished session is historical before reconciliation runs", async () => {
    const ticket = await createTicket({ title: "Finished early" });
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    await repo.linkStartedSession(makeLinkInput(ticket, "csm/work"));
    db.prepare(
      `UPDATE sessions SET finished = 1 WHERE project_path = ? AND session_name = ?`,
    ).run(PROJECT_PATH, "csm/work");

    expect(await repo.findLinkedTicket(PROJECT_PATH, "csm/work")).toBeNull();

    const links = await repo.listSessionLinks(PROJECT_PATH);
    expect(links["csm/work"]).toMatchObject({
      ticketId: ticket.id,
      active: false,
    });

    const items = await repo.list({
      projectPath: PROJECT_PATH,
      sort: "updated",
    });
    expect(items.find((i) => i.id === ticket.id)?.activeSessionName).toBeNull();
  });

  it("link history survives session deletion", async () => {
    const ticket = await createTicket();
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    const detail = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work"),
    );
    const linkId = detail.sessions[0]?.id ?? "";
    await repo.endSessionLink({
      linkId,
      endedAt: "2026-07-06T00:00:00.000Z",
      endReason: "deleted",
    });
    deleteSession("csm/work");

    const after = await repo.find(PROJECT_PATH, ticket.number);
    expect(after?.sessions).toHaveLength(1);
    expect(after?.sessions[0]?.endReason).toBe("deleted");
  });
});

describe("listSessionLinks", () => {
  it("maps live sessions to their linked ticket, active and historical", async () => {
    const active = await createTicket({ title: "Active work" });
    const done = await createTicket({ title: "Finished work" });
    insertSession("csm/active", "2026-07-04T00:00:00.000Z");
    insertSession("csm/ended", "2026-07-04T00:00:00.000Z");
    insertSession("csm/unlinked", "2026-07-04T00:00:00.000Z");

    await repo.linkStartedSession(makeLinkInput(active, "csm/active"));
    const endedDetail = await repo.linkStartedSession(
      makeLinkInput(done, "csm/ended"),
    );
    await repo.endSessionLink({
      linkId: endedDetail.sessions[0]?.id ?? "",
      endedAt: "2026-07-06T00:00:00.000Z",
      endReason: "finished",
    });

    const map = await repo.listSessionLinks(PROJECT_PATH);

    expect(map["csm/active"]).toMatchObject({
      ticketId: active.id,
      projectName: "command-center",
      number: active.number,
      title: "Active work",
      active: true,
    });
    expect(map["csm/ended"]).toMatchObject({
      ticketId: done.id,
      number: done.number,
      active: false,
    });
    expect(map["csm/unlinked"]).toBeUndefined();
  });
});

describe("endSessionLink", () => {
  it("bumps the parent ticket's updated time with the history change", async () => {
    const ticket = await createTicket();
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");
    const linked = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work"),
    );

    await repo.endSessionLink({
      linkId: linked.sessions[0]?.id ?? "",
      endedAt: "2026-07-06T00:00:00.000Z",
      endReason: "finished",
    });

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.updatedAt).toBe("2026-07-06T00:00:00.000Z");
  });

  it("advances link and demotion revisions when their requested times do not advance", async () => {
    const ticket = await createTicket({
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    insertSession("csm/work", "2026-07-04T00:00:00.000Z");

    const linked = await repo.linkStartedSession(
      makeLinkInput(ticket, "csm/work", {
        linkedAt: "2026-07-05T00:00:00.000Z",
      }),
    );
    const ended = await repo.endSessionLink({
      linkId: linked.sessions[0]?.id ?? "",
      endedAt: "2026-07-01T00:00:00.000Z",
      endReason: "finished",
    });
    const detail = await repo.find(PROJECT_PATH, ticket.number);

    expect(linked.updatedAt).toBe("2026-07-05T00:00:00.001Z");
    expect(linked.sessions[0]?.linkedAt).toBe(linked.updatedAt);
    expect(ended?.endedAt).toBe("2026-07-05T00:00:00.002Z");
    expect(detail?.updatedAt).toBe(ended?.endedAt);
  });

  it("returns null for an unknown link id", async () => {
    expect(
      await repo.endSessionLink({
        linkId: "missing",
        endedAt: "2026-07-06T00:00:00.000Z",
        endReason: "replaced",
      }),
    ).toBeNull();
  });
});

describe("session-link durability contract", () => {
  it("round-trips every persisted link key path through the real repo", async () => {
    const ticket = await createTicket();
    insertSession("csm/durable", "2026-07-04T00:00:00.000Z");

    await assertRoundTripDurability({
      label: "ticket-session-links",
      schema: ticketSessionLinkSchema,
      buildMaximalFixture: () =>
        ticketSessionLinkSchema.parse({
          id: "l-maximal",
          ticketId: ticket.id,
          projectPath: PROJECT_PATH,
          sessionName: "csm/durable",
          sessionCreatedAt: "2026-07-04T00:00:00.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-05T06:07:08.000Z",
          endedAt: "2026-07-06T07:08:09.000Z",
          endReason: "replaced",
        }),
      persist: async (fixture) => {
        await repo.linkStartedSession({
          id: fixture.id,
          projectPath: fixture.projectPath,
          number: ticket.number,
          sessionName: fixture.sessionName,
          sessionCreatedAt: "2026-07-04T00:00:00.000Z",
          startMode: fixture.startMode,
          linkedAt: fixture.linkedAt,
        });
        if (fixture.endedAt !== null && fixture.endReason !== null) {
          await repo.endSessionLink({
            linkId: fixture.id,
            endedAt: fixture.endedAt,
            endReason: fixture.endReason,
          });
        }
        return fixture;
      },
      reload: async (expected) => {
        const detail = await repo.find(PROJECT_PATH, ticket.number);
        return detail?.sessions.find((l) => l.id === expected.id) ?? null;
      },
      // Every field maps to a dedicated column; link/end revisions are
      // normalized by their respective write paths.
      fieldPolicies: {},
    });
  });
});
