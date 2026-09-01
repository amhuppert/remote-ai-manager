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
import {
  ticketAttachmentSchema,
  ticketSchema,
  type ConversationAttachmentPayload,
  type Ticket,
  type TicketAttachment,
} from "@/lib/tickets/schemas";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/repos/command-center";
const OTHER_PROJECT = "/repos/other";

let db: Db;
let queue: WriteQueue;
let repo: TicketsRepo;

beforeEach(() => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(OTHER_PROJECT);
  queue = createWriteQueue();
  repo = createTicketsRepo(db, queue);
});

afterEach(() => {
  db.close();
});

let inputSeq = 0;

function makeCreateInput(overrides: Partial<Omit<Ticket, "number">> = {}) {
  inputSeq += 1;
  return {
    id: `t-${inputSeq}`,
    projectPath: PROJECT_PATH,
    title: `Ticket ${inputSeq}`,
    description: "",
    workType: "feature" as const,
    status: "not_started" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeAttachment(
  ticketId: string,
  overrides: Partial<TicketAttachment> = {},
): TicketAttachment {
  inputSeq += 1;
  return ticketAttachmentSchema.parse({
    id: `a-${inputSeq}`,
    ticketId,
    description: "A described attachment",
    payload: { kind: "note", markdown: "## context" },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  });
}

function makeConversationAttachment(
  ticketId: string,
  overrides: Partial<TicketAttachment> = {},
): TicketAttachment {
  inputSeq += 1;
  return ticketAttachmentSchema.parse({
    id: `a-${inputSeq}`,
    ticketId,
    description: "Originating conversation, pre-compacted",
    payload: {
      kind: "conversation",
      projectPath: PROJECT_PATH,
      sessionName: "csm/origin",
      conversationId: "conv-1",
      snapshotKey: "ticket-content/t/a/compaction.md",
      snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
    },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  });
}

describe("atomic number allocation", () => {
  it("allocates 1, 2, 3 within a project and never reuses a number after deletion", async () => {
    const first = await repo.create(makeCreateInput());
    const second = await repo.create(makeCreateInput());
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);

    const deleted = await repo.delete(
      PROJECT_PATH,
      second.number,
      "2026-07-10T00:00:00.001Z",
    );
    expect(deleted).not.toBeNull();

    const third = await repo.create(makeCreateInput());
    expect(third.number).toBe(3);
  });

  it("keeps sequences independent per project", async () => {
    await repo.create(makeCreateInput());
    await repo.create(makeCreateInput());
    const other = await repo.create(
      makeCreateInput({ projectPath: OTHER_PROJECT }),
    );
    expect(other.number).toBe(1);
  });

  it("survives project delete/re-add without reusing numbers (counter has no FK)", async () => {
    await repo.create(makeCreateInput());
    await repo.create(makeCreateInput());

    db.prepare("DELETE FROM projects WHERE root_path = ?").run(PROJECT_PATH);
    db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);

    const relisted = await repo.list({
      projectPath: PROJECT_PATH,
      sort: "updated",
    });
    expect(relisted).toHaveLength(0);

    const next = await repo.create(makeCreateInput());
    expect(next.number).toBe(3);
  });

  it("assigns unique sequential numbers under concurrent queued creates", async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, () => repo.create(makeCreateInput())),
    );
    const numbers = created.map((t) => t.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("ticket CRUD", () => {
  it("find returns the complete aggregate with empty collaboration surfaces", async () => {
    const ticket = await repo.create(makeCreateInput({ title: "Find me" }));
    const detail = await repo.find(PROJECT_PATH, ticket.number);

    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(detail.title).toBe("Find me");
    expect(detail.projectName).toBe("command-center");
    expect(detail.attachments).toEqual([]);
    expect(detail.sessions).toEqual([]);
    expect(detail.relationships).toEqual([]);
    expect(detail.statusUpdates).toEqual({ total: 0, recent: [] });
  });

  it("find and update return null for an unknown ticket", async () => {
    expect(await repo.find(PROJECT_PATH, 99)).toBeNull();
    expect(
      await repo.update({
        projectPath: PROJECT_PATH,
        number: 99,
        title: "nope",
        updatedAt: "2026-07-10T01:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      await repo.delete(PROJECT_PATH, 99, "2026-07-10T01:00:00.000Z"),
    ).toBeNull();
  });

  it("update changes only the provided fields and stamps updated_at", async () => {
    const ticket = await repo.create(
      makeCreateInput({ title: "Before", description: "body" }),
    );

    const updated = await repo.update({
      projectPath: PROJECT_PATH,
      number: ticket.number,
      status: "blocked",
      updatedAt: "2026-07-10T02:00:00.000Z",
    });

    expect(updated).not.toBeNull();
    if (!updated) return;
    expect(updated.status).toBe("blocked");
    expect(updated.title).toBe("Before");
    expect(updated.description).toBe("body");
    expect(updated.updatedAt).toBe("2026-07-10T02:00:00.000Z");
  });

  it("advances updated_at when field writes reuse or regress the wall clock", async () => {
    const ticket = await repo.create(makeCreateInput());

    const equal = await repo.update({
      projectPath: PROJECT_PATH,
      number: ticket.number,
      title: "Equal clock",
      updatedAt: ticket.updatedAt,
    });
    const regressed = await repo.update({
      projectPath: PROJECT_PATH,
      number: ticket.number,
      title: "Regressed clock",
      updatedAt: "2026-07-09T23:59:59.000Z",
    });

    expect(equal?.updatedAt).toBe("2026-07-10T00:00:00.001Z");
    expect(regressed?.updatedAt).toBe("2026-07-10T00:00:00.002Z");
  });

  it("delete returns the removed identity and cascades attachment rows", async () => {
    const ticket = await repo.create(makeCreateInput());
    await repo.addAttachment(makeAttachment(ticket.id));

    const deleted = await repo.delete(
      PROJECT_PATH,
      ticket.number,
      "2026-07-10T01:00:00.000Z",
    );
    expect(deleted).toEqual({
      deleted: {
        id: ticket.id,
        projectPath: PROJECT_PATH,
        projectName: "command-center",
        number: ticket.number,
      },
      survivingNeighbors: [],
    });

    const orphans = db
      .prepare("SELECT COUNT(*) AS n FROM ticket_attachments")
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("deleting the project row cascades tickets and their attachment rows", async () => {
    const ticket = await repo.create(makeCreateInput());
    await repo.addAttachment(makeAttachment(ticket.id));

    db.prepare("DELETE FROM projects WHERE root_path = ?").run(PROJECT_PATH);

    const tickets = db
      .prepare("SELECT COUNT(*) AS n FROM tickets WHERE project_path = ?")
      .get(PROJECT_PATH) as { n: number };
    expect(tickets.n).toBe(0);
    const attachments = db
      .prepare("SELECT COUNT(*) AS n FROM ticket_attachments")
      .get() as { n: number };
    expect(attachments.n).toBe(0);
  });

  it("rejects an invalid create input before touching the database", async () => {
    await expect(
      repo.create(makeCreateInput({ workType: "epic" as never })),
    ).rejects.toThrow();
    const counter = db
      .prepare("SELECT last_number FROM ticket_counters WHERE project_path = ?")
      .get(PROJECT_PATH) as { last_number: number } | undefined;
    expect(counter).toBeUndefined();
  });

  it("creates the project aggregate row for a discovered project that has never been persisted", async () => {
    const discovered = "/repos/discovered-only";
    const ticket = await repo.create(
      makeCreateInput({ projectPath: discovered }),
    );
    expect(ticket.number).toBe(1);
    const row = db
      .prepare("SELECT root_path FROM projects WHERE root_path = ?")
      .get(discovered);
    expect(row).toEqual({ root_path: discovered });
  });
});

describe("ticket relationship aggregate", () => {
  it("adds one canonical dependency and returns both authoritative endpoint details", async () => {
    const dependent = await repo.create(
      makeCreateInput({ title: "Dependent ticket" }),
    );
    const prerequisite = await repo.create(
      makeCreateInput({
        projectPath: OTHER_PROJECT,
        title: "Prerequisite ticket",
      }),
    );

    const result = await repo.addRelationship({
      id: "rel-1",
      anchorTicketId: dependent.id,
      relationType: "depends_on",
      sourceTicketId: dependent.id,
      targetTicketId: prerequisite.id,
      description: "The runtime must land first.",
      createdAt: "2026-07-10T01:00:00.000Z",
    });

    expect(result.relationship).toMatchObject({
      id: "rel-1",
      role: "depends_on",
      otherTicket: {
        id: prerequisite.id,
        projectName: "other",
        number: prerequisite.number,
      },
      description: "The runtime must land first.",
      updatedAt: "2026-07-10T01:00:00.000Z",
    });
    expect(result.replacedRelationshipId).toBeNull();
    expect(result.tickets.map(({ id }) => id).sort()).toEqual(
      [dependent.id, prerequisite.id].sort(),
    );
    expect(new Set(result.tickets.map(({ updatedAt }) => updatedAt))).toEqual(
      new Set(["2026-07-10T01:00:00.000Z"]),
    );

    const dependentDetail = await repo.find(PROJECT_PATH, dependent.number);
    const prerequisiteDetail = await repo.find(
      OTHER_PROJECT,
      prerequisite.number,
    );
    expect(dependentDetail?.relationships[0]?.role).toBe("depends_on");
    expect(prerequisiteDetail?.relationships[0]?.role).toBe("blocks");
  });

  it("reparents atomically and returns the old parent as an affected endpoint", async () => {
    const oldParent = await repo.create(
      makeCreateInput({ title: "Old parent" }),
    );
    const newParent = await repo.create(
      makeCreateInput({ title: "New parent" }),
    );
    const child = await repo.create(makeCreateInput({ title: "Child" }));
    await repo.addRelationship({
      id: "rel-old-parent",
      anchorTicketId: child.id,
      relationType: "parent_child",
      sourceTicketId: oldParent.id,
      targetTicketId: child.id,
      description: "",
      createdAt: "2026-07-10T01:00:00.000Z",
    });

    const result = await repo.addRelationship({
      id: "rel-new-parent",
      anchorTicketId: child.id,
      relationType: "parent_child",
      sourceTicketId: newParent.id,
      targetTicketId: child.id,
      description: "Ownership moved.",
      createdAt: "2026-07-10T02:00:00.000Z",
    });

    expect(result.replacedRelationshipId).toBe("rel-old-parent");
    expect(result.tickets.map(({ id }) => id).sort()).toEqual(
      [oldParent.id, newParent.id, child.id].sort(),
    );
    expect(
      (await repo.find(PROJECT_PATH, oldParent.number))?.relationships,
    ).toEqual([]);
    expect(
      (await repo.find(PROJECT_PATH, child.number))?.relationships[0],
    ).toMatchObject({ id: "rel-new-parent", role: "parent" });
  });

  it("deletes relationships and bumps each surviving neighbor once in the same transaction", async () => {
    const target = await repo.create(makeCreateInput({ title: "Delete me" }));
    const firstNeighbor = await repo.create(
      makeCreateInput({ title: "First survivor" }),
    );
    const secondNeighbor = await repo.create(
      makeCreateInput({ title: "Second survivor" }),
    );
    await repo.addRelationship({
      id: "rel-delete-dependency",
      anchorTicketId: target.id,
      relationType: "depends_on",
      sourceTicketId: target.id,
      targetTicketId: firstNeighbor.id,
      description: "Dependency",
      createdAt: "2026-07-10T01:00:00.000Z",
    });
    const [relatedSourceId, relatedTargetId] = [
      target.id,
      firstNeighbor.id,
    ].sort();
    await repo.addRelationship({
      id: "rel-delete-related",
      anchorTicketId: target.id,
      relationType: "related",
      sourceTicketId: relatedSourceId!,
      targetTicketId: relatedTargetId!,
      description: "Same neighbor through a second edge",
      createdAt: "2026-07-10T02:00:00.000Z",
    });
    await repo.addRelationship({
      id: "rel-delete-parent",
      anchorTicketId: target.id,
      relationType: "parent_child",
      sourceTicketId: target.id,
      targetTicketId: secondNeighbor.id,
      description: "Child becomes top-level",
      createdAt: "2026-07-10T03:00:00.000Z",
    });

    const result = await repo.delete(
      PROJECT_PATH,
      target.number,
      "2026-07-10T04:00:00.000Z",
    );

    expect(result?.deleted).toMatchObject({
      id: target.id,
      number: target.number,
    });
    expect(result?.survivingNeighbors.map(({ id }) => id).sort()).toEqual(
      [firstNeighbor.id, secondNeighbor.id].sort(),
    );
    expect(
      result?.survivingNeighbors.map(({ updatedAt }) => updatedAt),
    ).toEqual(["2026-07-10T04:00:00.000Z", "2026-07-10T04:00:00.000Z"]);
    expect(await repo.find(PROJECT_PATH, target.number)).toBeNull();
    expect(
      (await repo.find(PROJECT_PATH, firstNeighbor.number))?.relationships,
    ).toEqual([]);
    expect(
      (await repo.find(PROJECT_PATH, secondNeighbor.number))?.relationships,
    ).toEqual([]);
  });
});

describe("ticket status-update aggregate", () => {
  it("appends an update, bumps the ticket, and assembles the bounded summary", async () => {
    const ticket = await repo.create(makeCreateInput());
    const result = await repo.addStatusUpdate({
      id: "update-1",
      ticketId: ticket.id,
      bodyMarkdown: "The persistence slice is complete.",
      author: { kind: "user" },
      createdAt: "2026-07-10T01:00:00.000Z",
    });

    expect(result.update).toEqual({
      id: "update-1",
      ticketId: ticket.id,
      bodyMarkdown: "The persistence slice is complete.",
      author: { kind: "user" },
      createdAt: "2026-07-10T01:00:00.000Z",
    });
    expect(result.ticket.updatedAt).toBe("2026-07-10T01:00:00.000Z");
    expect(result.ticket.statusUpdates).toEqual({
      total: 1,
      recent: [result.update],
    });
    expect(
      await repo.listStatusUpdates({ ticketId: ticket.id, limit: 20 }),
    ).toEqual({ items: [result.update], total: 1, nextCursor: null });
  });
});

describe("createWithAttachments", () => {
  it("creates the ticket with every attachment and reloads them in deterministic order", async () => {
    const input = makeCreateInput({ title: "Quick ticket bundle" });
    const conversation = makeConversationAttachment(input.id, {
      id: "a-conversation",
      createdAt: "2026-07-10T00:00:00.003Z",
    });
    const report = makeAttachment(input.id, {
      id: "a-report",
      description: "Diagnostic report",
      createdAt: "2026-07-10T00:00:00.001Z",
    });
    const screenshot = makeAttachment(input.id, {
      id: "a-screenshot",
      description: "Screenshot",
      payload: {
        kind: "file",
        fileName: "page-state.png",
        snapshotKey: `${input.id}/a-screenshot/page-state.png`,
        mediaType: "image/png",
        sizeBytes: 128,
        sha256: "deadbeef",
      },
      createdAt: "2026-07-10T00:00:00.002Z",
    });

    const detail = await repo.createWithAttachments(input, [
      conversation,
      screenshot,
      report,
    ]);

    expect(detail.number).toBe(1);
    expect(detail.attachments.map((attachment) => attachment.id)).toEqual([
      "a-report",
      "a-screenshot",
      "a-conversation",
    ]);
    expect(
      detail.attachments.map((attachment) => attachment.payload.kind),
    ).toEqual(["note", "file", "conversation"]);
  });

  it("supports a combined create with no attachments", async () => {
    const input = makeCreateInput();

    const detail = await repo.createWithAttachments(input, []);

    expect(detail.number).toBe(1);
    expect(detail.attachments).toEqual([]);
  });

  it("validates every attachment before touching the database", async () => {
    const input = makeCreateInput();
    const valid = makeAttachment(input.id);
    const wrongTicket = makeAttachment("another-ticket");

    await expect(
      repo.createWithAttachments(input, [valid, wrongTicket]),
    ).rejects.toThrow();

    const tickets = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as {
      n: number;
    };
    const attachments = db
      .prepare("SELECT COUNT(*) AS n FROM ticket_attachments")
      .get() as { n: number };
    const counter = db
      .prepare("SELECT last_number FROM ticket_counters WHERE project_path = ?")
      .get(PROJECT_PATH);
    expect(tickets.n).toBe(0);
    expect(attachments.n).toBe(0);
    expect(counter).toBeUndefined();
  });

  it("rolls back the ticket, earlier attachments, and counter when a later insert fails", async () => {
    const existing = await repo.create(makeCreateInput());
    const clash = await repo.addAttachment(
      makeConversationAttachment(existing.id),
    );

    const input = makeCreateInput();
    await expect(
      repo.createWithAttachments(input, [
        makeAttachment(input.id, { id: "inserted-before-clash" }),
        makeConversationAttachment(input.id, { id: clash.id }),
      ]),
    ).rejects.toThrow();

    // Nothing from the attempted create persisted: no second ticket or first
    // attachment, and the counter did not advance.
    const tickets = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as {
      n: number;
    };
    expect(tickets.n).toBe(1);
    const insertedBeforeClash = db
      .prepare("SELECT id FROM ticket_attachments WHERE id = ?")
      .get("inserted-before-clash");
    expect(insertedBeforeClash).toBeUndefined();

    const next = await repo.create(makeCreateInput());
    expect(next.number).toBe(2);
  });

  it("rolls back all writes when the transaction-internal detail read fails", async () => {
    db.exec(`
      CREATE TRIGGER corrupt_combined_create_attachment
      AFTER INSERT ON ticket_attachments
      WHEN NEW.id = 'a-corrupt-on-read'
      BEGIN
        UPDATE ticket_attachments SET description = '' WHERE id = NEW.id;
      END
    `);
    const input = makeCreateInput();

    await expect(
      repo.createWithAttachments(input, [
        makeAttachment(input.id, { id: "a-corrupt-on-read" }),
      ]),
    ).rejects.toThrow();

    const tickets = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as {
      n: number;
    };
    const attachments = db
      .prepare("SELECT COUNT(*) AS n FROM ticket_attachments")
      .get() as { n: number };
    const counter = db
      .prepare("SELECT last_number FROM ticket_counters WHERE project_path = ?")
      .get(PROJECT_PATH);
    expect(tickets.n).toBe(0);
    expect(attachments.n).toBe(0);
    expect(counter).toBeUndefined();
  });
});

describe("attachment-row CRUD", () => {
  it("addAttachment persists a validated row readable from the detail", async () => {
    const ticket = await repo.create(makeCreateInput());
    const attachment = await repo.addAttachment(
      makeAttachment(ticket.id, { description: "kickoff notes" }),
    );

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toEqual([attachment]);
  });

  it("updateAttachment edits description and payload; unknown id returns null", async () => {
    const ticket = await repo.create(makeCreateInput());
    const attachment = await repo.addAttachment(makeAttachment(ticket.id));

    const updated = await repo.updateAttachment({
      ticketId: ticket.id,
      attachmentId: attachment.id,
      description: "sharper description",
      payload: { kind: "note", markdown: "## revised" },
      updatedAt: "2026-07-10T03:00:00.000Z",
    });

    expect(updated).not.toBeNull();
    if (!updated) return;
    expect(updated.description).toBe("sharper description");
    expect(updated.payload).toEqual({ kind: "note", markdown: "## revised" });
    expect(updated.updatedAt).toBe("2026-07-10T03:00:00.000Z");

    expect(
      await repo.updateAttachment({
        ticketId: ticket.id,
        attachmentId: "missing",
        description: "x",
        updatedAt: "2026-07-10T03:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("uses one strictly increasing parent revision for attachment writes", async () => {
    const ticket = await repo.create(makeCreateInput());
    const added = await repo.addAttachment(makeAttachment(ticket.id));
    const afterAdd = await repo.find(PROJECT_PATH, ticket.number);

    const updated = await repo.updateAttachment({
      ticketId: ticket.id,
      attachmentId: added.id,
      description: "clock moved backwards",
      updatedAt: "2026-07-09T23:59:59.000Z",
    });
    const afterUpdate = await repo.find(PROJECT_PATH, ticket.number);

    await repo.deleteAttachment({
      ticketId: ticket.id,
      attachmentId: added.id,
      updatedAt: "2026-07-09T23:59:58.000Z",
    });
    const afterDelete = await repo.find(PROJECT_PATH, ticket.number);

    expect(added.updatedAt).toBe("2026-07-10T00:00:00.001Z");
    expect(afterAdd?.updatedAt).toBe(added.updatedAt);
    expect(updated?.updatedAt).toBe("2026-07-10T00:00:00.002Z");
    expect(afterUpdate?.updatedAt).toBe(updated?.updatedAt);
    expect(afterDelete?.updatedAt).toBe("2026-07-10T00:00:00.003Z");
  });

  it("deleteAttachment returns the removed row; unknown id returns null", async () => {
    const ticket = await repo.create(makeCreateInput());
    const attachment = await repo.addAttachment(makeAttachment(ticket.id));

    const removed = await repo.deleteAttachment({
      ticketId: ticket.id,
      attachmentId: attachment.id,
      updatedAt: "2026-07-10T04:00:00.000Z",
    });
    expect(removed).toEqual({
      attachment,
      ticketUpdatedAt: "2026-07-10T04:00:00.000Z",
    });

    expect(
      await repo.deleteAttachment({
        ticketId: ticket.id,
        attachmentId: attachment.id,
        updatedAt: "2026-07-10T05:00:00.000Z",
      }),
    ).toBeNull();

    const detail = await repo.find(PROJECT_PATH, ticket.number);
    expect(detail?.attachments).toEqual([]);
  });

  it("deleteAttachment returns the committed parent revision when the requested clock moves backwards", async () => {
    const ticket = await repo.create(makeCreateInput());
    const attachment = await repo.addAttachment(makeAttachment(ticket.id));

    const removed = await repo.deleteAttachment({
      ticketId: ticket.id,
      attachmentId: attachment.id,
      updatedAt: "2026-07-09T23:59:59.000Z",
    });

    expect(removed).toEqual({
      attachment,
      ticketUpdatedAt: "2026-07-10T00:00:00.002Z",
    });
    expect((await repo.find(PROJECT_PATH, ticket.number))?.updatedAt).toBe(
      "2026-07-10T00:00:00.002Z",
    );
  });

  it("rejects an attachment for a ticket that does not exist", async () => {
    await expect(
      repo.addAttachment(makeAttachment("t-missing")),
    ).rejects.toThrow();
  });
});

describe("list queries", () => {
  async function seedListFixtures() {
    await repo.create(
      makeCreateInput({
        title: "cc feature",
        workType: "feature",
        status: "not_started",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z",
      }),
    );
    await repo.create(
      makeCreateInput({
        title: "cc bug",
        workType: "bug",
        status: "in_progress",
        createdAt: "2026-07-02T00:00:00.000Z",
        updatedAt: "2026-07-06T00:00:00.000Z",
      }),
    );
    await repo.create(
      makeCreateInput({
        projectPath: OTHER_PROJECT,
        title: "other research",
        workType: "research",
        status: "in_progress",
        createdAt: "2026-07-03T00:00:00.000Z",
        updatedAt: "2026-07-05T00:00:00.000Z",
      }),
    );
  }

  it("filters by project, status, and work type (field equality)", async () => {
    await seedListFixtures();

    const byProject = await repo.list({
      projectPath: PROJECT_PATH,
      sort: "updated",
    });
    expect(byProject.map((t) => t.title)).toEqual(["cc bug", "cc feature"]);

    const byStatus = await repo.list({
      statuses: ["in_progress"],
      sort: "updated",
    });
    expect(byStatus.map((t) => t.title)).toEqual(["cc bug", "other research"]);

    const byType = await repo.list({ workType: "research", sort: "updated" });
    expect(byType.map((t) => t.title)).toEqual(["other research"]);
  });

  it("filters by a multi-status set (membership, not equality)", async () => {
    await seedListFixtures();

    const openOnly = await repo.list({
      statuses: ["not_started", "in_progress"],
      sort: "updated",
    });
    expect(openOnly.map((t) => t.title)).toEqual([
      "cc bug",
      "other research",
      "cc feature",
    ]);

    const doneOnly = await repo.list({ statuses: ["done"], sort: "updated" });
    expect(doneOnly).toEqual([]);
  });

  it("sorts by last-updated or creation time, newest first", async () => {
    await seedListFixtures();

    const byUpdated = await repo.list({ sort: "updated" });
    expect(byUpdated.map((t) => t.title)).toEqual([
      "cc bug",
      "other research",
      "cc feature",
    ]);

    const byCreated = await repo.list({ sort: "created" });
    expect(byCreated.map((t) => t.title)).toEqual([
      "other research",
      "cc bug",
      "cc feature",
    ]);
  });

  it("carries attachmentCount and a null activeSessionName when unlinked", async () => {
    const ticket = await repo.create(makeCreateInput());
    await repo.addAttachment(makeAttachment(ticket.id));
    await repo.addAttachment(makeAttachment(ticket.id));

    const items = await repo.list({
      projectPath: PROJECT_PATH,
      sort: "updated",
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.attachmentCount).toBe(2);
    expect(items[0]?.activeSessionName).toBeNull();
    expect(items[0]?.projectName).toBe("command-center");
  });
});

describe("durability contracts", () => {
  it("round-trips every persisted ticket key path through the real repo", async () => {
    await assertRoundTripDurability({
      label: "tickets",
      schema: ticketSchema,
      buildMaximalFixture: () =>
        ticketSchema.parse({
          id: "t-maximal",
          projectPath: PROJECT_PATH,
          number: 1,
          title: "A maximal durability fixture",
          description: "Body with **markdown** and unicode ✓",
          workType: "tech_debt",
          status: "blocked",
          createdAt: "2026-02-15T08:09:10.000Z",
          updatedAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: async (fixture) => {
        const { number: _number, ...input } = fixture;
        return await repo.create(input);
      },
      reload: async (expected) => {
        const detail = await repo.find(expected.projectPath, expected.number);
        if (!detail) return null;
        const {
          projectName: _projectName,
          attachments: _attachments,
          sessions: _sessions,
          ...ticket
        } = detail;
        return ticket;
      },
      // `number` is allocated by the repo (persist returns the allocated row,
      // which the harness compares against reload) — all other fields map to
      // dedicated NOT NULL columns written from caller-supplied values.
      fieldPolicies: { number: "derived-on-write" },
    });
  });

  it("round-trips every persisted attachment key path through the real repo", async () => {
    const ticket = await repo.create(makeCreateInput());
    await assertRoundTripDurability({
      label: "ticket-attachments",
      schema: ticketAttachmentSchema,
      buildMaximalFixture: () =>
        ticketAttachmentSchema.parse({
          id: "a-maximal",
          ticketId: ticket.id,
          description: "A maximal attachment durability fixture",
          payload: {
            kind: "file",
            fileName: "design notes.md",
            snapshotKey: "ticket-content/t/a/design notes.md",
            mediaType: "text/markdown",
            sizeBytes: 4096,
            sha256: "deadbeefcafef00d",
          },
          createdAt: "2026-02-15T08:09:10.000Z",
          updatedAt: "2026-03-16T09:10:11.000Z",
        }),
      persist: (fixture) => repo.addAttachment(fixture),
      reload: async (expected) => {
        const detail = await repo.find(PROJECT_PATH, ticket.number);
        return detail?.attachments.find((a) => a.id === expected.id) ?? null;
      },
      // Every field maps to a dedicated NOT NULL column (payload as validated
      // JSON); persist returns the repo-normalized mutation revision.
      fieldPolicies: {},
    });
  });

  it.each<[string, ConversationAttachmentPayload]>([
    [
      "legacy captured",
      {
        kind: "conversation",
        projectPath: PROJECT_PATH,
        sessionName: "csm/legacy",
        conversationId: "legacy-conversation",
        snapshotKey: "ticket-content/legacy.md",
        snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
      },
    ],
    [
      "explicit captured",
      {
        kind: "conversation",
        projectPath: PROJECT_PATH,
        sessionName: "csm/captured",
        conversationId: "captured-conversation",
        snapshotKey: "ticket-content/captured.md",
        snapshotCapturedAt: "2026-07-10T00:00:01.000Z",
        snapshotStatus: "captured",
      },
    ],
    [
      "pending",
      {
        kind: "conversation",
        projectPath: PROJECT_PATH,
        sessionName: null,
        conversationId: "pending-conversation",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "pending",
      },
    ],
    [
      "failed",
      {
        kind: "conversation",
        projectPath: PROJECT_PATH,
        sessionName: null,
        conversationId: "failed-conversation",
        snapshotKey: null,
        snapshotCapturedAt: null,
        snapshotStatus: "failed",
        snapshotError: "The source conversation is unavailable.",
      },
    ],
  ])("round-trips the %s conversation payload arm", async (_label, payload) => {
    const ticket = await repo.create(makeCreateInput());
    const attachment = makeConversationAttachment(ticket.id, { payload });

    const persisted = await repo.addAttachment(attachment);

    const reloaded = await repo.find(PROJECT_PATH, ticket.number);
    expect(reloaded?.attachments).toEqual([persisted]);
  });
});
