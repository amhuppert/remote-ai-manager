import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ticketAttachmentPayloadSchema } from "@/lib/tickets/schemas";
import { schemaCompatibilityBarrierPath } from "../schema-compatibility";
import { _createTestDb, _createTestDbAtPath } from "../state-db";
import { ticketRelationshipsAndStatusUpdates } from "./0038-ticket-relationships-and-status-updates";

type Db = InstanceType<typeof Database>;

let db: Db | null = null;
let secondaryDb: Db | null = null;
let tempDir: string | null = null;

afterEach(() => {
  db?.close();
  db = null;
  secondaryDb?.close();
  secondaryDb = null;
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function runMigration(
  target: Db,
  configDir: string | null = null,
): Promise<void> {
  await ticketRelationshipsAndStatusUpdates.up({
    name: ticketRelationshipsAndStatusUpdates.name,
    context: { db: target, configDir },
  });
}

function tableNames(target: Db): string[] {
  return target
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

function indexNames(target: Db, table: string): string[] {
  return (target.pragma(`index_list(${table})`) as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

function createLegacySchemaDb(): Db {
  const target = new Database(":memory:");
  target.pragma("foreign_keys = ON");
  target.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (root_path TEXT PRIMARY KEY);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      ticket_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      work_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_path, ticket_number),
      UNIQUE (id, project_path),
      FOREIGN KEY (project_path) REFERENCES projects(root_path) ON DELETE CASCADE
    );
    CREATE TABLE ticket_attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      description TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    );
  `);
  return target;
}

function insertProject(target: Db, projectPath: string): void {
  target
    .prepare("INSERT INTO projects (root_path) VALUES (?)")
    .run(projectPath);
}

function insertTicket(
  target: Db,
  input: {
    id: string;
    projectPath: string;
    number: number;
    updatedAt?: string;
  },
): void {
  const timestamp = input.updatedAt ?? "2026-08-01T09:00:00.000Z";
  target
    .prepare(
      `INSERT INTO tickets (
         id, project_path, ticket_number, title, description, work_type,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', 'feature', 'not_started', ?, ?)`,
    )
    .run(
      input.id,
      input.projectPath,
      input.number,
      `Ticket ${input.number}`,
      timestamp,
      timestamp,
    );
}

function insertLegacyAttachment(
  target: Db,
  input: {
    id: string;
    hostTicketId: string;
    targetTicketId: string;
    identifierSnapshot: string;
    description: string;
    createdAt: string;
    updatedAt?: string;
  },
): void {
  target
    .prepare(
      `INSERT INTO ticket_attachments (
         id, ticket_id, description, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.hostTicketId,
      input.description,
      JSON.stringify({
        kind: "related_ticket",
        ticketId: input.targetTicketId,
        identifierSnapshot: input.identifierSnapshot,
      }),
      input.createdAt,
      input.updatedAt ?? input.createdAt,
    );
}

describe("0038-ticket-relationships-and-status-updates", () => {
  it("creates the final tables on a fresh database and stamps schema version 13", async () => {
    db = _createTestDb({ inMemory: true });

    await runMigration(db);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        "ticket_relationships",
        "ticket_relationship_legacy_aliases",
        "ticket_status_updates",
      ]),
    );
    expect(
      db
        .prepare("SELECT description FROM schema_migrations WHERE version = 13")
        .get(),
    ).toEqual({
      description: "ticket relationships and append-only status updates",
    });
  });

  it("moves a cross-project legacy link into canonical storage without bumping ticket revisions", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertProject(db, "/repos/beta");
    insertTicket(db, {
      id: "ticket-z",
      projectPath: "/repos/beta",
      number: 2,
      updatedAt: "2026-08-01T10:00:00.000Z",
    });
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
      updatedAt: "2026-08-01T11:00:00.000Z",
    });
    insertLegacyAttachment(db, {
      id: "attachment-1",
      hostTicketId: "ticket-z",
      targetTicketId: "ticket-a",
      identifierSnapshot: "alpha#1",
      description: "Blocks the release train.",
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-03T09:00:00.000Z",
    });

    await runMigration(db);

    expect(db.prepare("SELECT * FROM ticket_relationships").get()).toEqual({
      id: "attachment-1",
      relation_type: "related",
      source_ticket_id: "ticket-a",
      target_ticket_id: "ticket-z",
      description: "Blocks the release train.",
      created_at: "2026-08-02T09:00:00.000Z",
      updated_at: "2026-08-03T09:00:00.000Z",
    });
    expect(
      db.prepare("SELECT * FROM ticket_relationship_legacy_aliases").get(),
    ).toEqual({
      legacy_attachment_id: "attachment-1",
      relationship_id: "attachment-1",
      anchor_ticket_id: "ticket-z",
    });
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_attachments").pluck().get(),
    ).toBe(0);
    expect(
      db.prepare("SELECT id, updated_at FROM tickets ORDER BY id").all(),
    ).toEqual([
      { id: "ticket-a", updated_at: "2026-08-01T11:00:00.000Z" },
      { id: "ticket-z", updated_at: "2026-08-01T10:00:00.000Z" },
    ]);
  });

  it("deduplicates mirrored and same-direction rows while preserving every legacy handle and distinct rationale", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertTicket(db, {
      id: "ticket-b",
      projectPath: "/repos/alpha",
      number: 2,
    });
    const rows = [
      {
        id: "attachment-a",
        hostTicketId: "ticket-b",
        targetTicketId: "ticket-a",
        identifierSnapshot: "alpha#1",
        description: "**Shared rationale**\n\n- exact",
        createdAt: "2026-08-02T08:00:00.000Z",
        updatedAt: "2026-08-02T12:00:00.000Z",
      },
      {
        id: "attachment-b",
        hostTicketId: "ticket-b",
        targetTicketId: "ticket-a",
        identifierSnapshot: "alpha#1",
        description: "Second rationale",
        createdAt: "2026-08-02T09:00:00.000Z",
        updatedAt: "2026-08-02T15:00:00.000Z",
      },
      {
        id: "attachment-c",
        hostTicketId: "ticket-a",
        targetTicketId: "ticket-b",
        identifierSnapshot: "alpha#2",
        description: "**Shared rationale**\n\n- exact",
        createdAt: "2026-08-02T10:00:00.000Z",
        updatedAt: "2026-08-02T14:00:00.000Z",
      },
      {
        id: "attachment-d",
        hostTicketId: "ticket-a",
        targetTicketId: "ticket-b",
        identifierSnapshot: "alpha#2",
        description: "Third rationale",
        createdAt: "2026-08-02T11:00:00.000Z",
        updatedAt: "2026-08-02T13:00:00.000Z",
      },
    ] as const;
    for (const row of rows) insertLegacyAttachment(db, row);

    await runMigration(db);

    expect(
      db
        .prepare(
          `SELECT id, source_ticket_id, target_ticket_id, description,
                  created_at, updated_at
           FROM ticket_relationships`,
        )
        .all(),
    ).toEqual([
      {
        id: "attachment-a",
        source_ticket_id: "ticket-a",
        target_ticket_id: "ticket-b",
        description: [
          "### From alpha#2\n\n**Shared rationale**\n\n- exact",
          "### From alpha#2\n\nSecond rationale",
          "### From alpha#1\n\nThird rationale",
        ].join("\n\n---\n\n"),
        created_at: "2026-08-02T08:00:00.000Z",
        updated_at: "2026-08-02T15:00:00.000Z",
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT legacy_attachment_id, relationship_id, anchor_ticket_id
           FROM ticket_relationship_legacy_aliases
           ORDER BY legacy_attachment_id`,
        )
        .all(),
    ).toEqual([
      {
        legacy_attachment_id: "attachment-a",
        relationship_id: "attachment-a",
        anchor_ticket_id: "ticket-b",
      },
      {
        legacy_attachment_id: "attachment-b",
        relationship_id: "attachment-a",
        anchor_ticket_id: "ticket-b",
      },
      {
        legacy_attachment_id: "attachment-c",
        relationship_id: "attachment-a",
        anchor_ticket_id: "ticket-a",
      },
      {
        legacy_attachment_id: "attachment-d",
        relationship_id: "attachment-a",
        anchor_ticket_id: "ticket-a",
      },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_attachments").pluck().get(),
    ).toBe(0);
  });

  it("converts missing-target and self-link attachments into canonical notes in place", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertLegacyAttachment(db, {
      id: "attachment-missing",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-missing",
      identifierSnapshot: "alpha#99",
      description: "The target was deleted.",
      createdAt: "2026-08-02T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
    });
    insertLegacyAttachment(db, {
      id: "attachment-self",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-a",
      identifierSnapshot: "alpha#1",
      description: "Accidental self-reference.",
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-03T09:00:00.000Z",
    });

    await runMigration(db);

    const rows = db
      .prepare(
        `SELECT id, ticket_id, description, payload_json, created_at, updated_at
         FROM ticket_attachments ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      ticket_id: string;
      description: string;
      payload_json: string;
      created_at: string;
      updated_at: string;
    }>;
    expect(
      rows.map(({ payload_json, ...row }) => ({
        ...row,
        payload: ticketAttachmentPayloadSchema.parse(JSON.parse(payload_json)),
      })),
    ).toEqual([
      {
        id: "attachment-missing",
        ticket_id: "ticket-a",
        description: "The target was deleted.",
        payload: {
          kind: "note",
          markdown:
            "Formerly related ticket: alpha#99\n\nThe structural target is unavailable.",
        },
        created_at: "2026-08-02T08:00:00.000Z",
        updated_at: "2026-08-03T08:00:00.000Z",
      },
      {
        id: "attachment-self",
        ticket_id: "ticket-a",
        description: "Accidental self-reference.",
        payload: {
          kind: "note",
          markdown:
            "Formerly related ticket: alpha#1\n\nThe structural target is invalid because a ticket cannot relate to itself.",
        },
        created_at: "2026-08-02T09:00:00.000Z",
        updated_at: "2026-08-03T09:00:00.000Z",
      },
    ]);
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_relationships").pluck().get(),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM ticket_relationship_legacy_aliases")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rolls back malformed preflight data and converges when the corrected migration retries", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertTicket(db, {
      id: "ticket-b",
      projectPath: "/repos/alpha",
      number: 2,
    });
    insertLegacyAttachment(db, {
      id: "attachment-valid",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-b",
      identifierSnapshot: "alpha#2",
      description: "First rationale",
      createdAt: "2026-08-02T08:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO ticket_attachments (
         id, ticket_id, description, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "attachment-malformed",
      "ticket-b",
      "Second rationale",
      '{"kind":"related_ticket"',
      "2026-08-02T09:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
    );
    const before = db
      .prepare(`SELECT id, payload_json FROM ticket_attachments ORDER BY id`)
      .all();

    await expect(runMigration(db)).rejects.toThrow(
      /migration preflight failed/i,
    );

    expect(
      db
        .prepare("SELECT id, payload_json FROM ticket_attachments ORDER BY id")
        .all(),
    ).toEqual(before);
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_relationships").pluck().get(),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 13")
        .pluck()
        .get(),
    ).toBe(0);

    db.prepare(
      "UPDATE ticket_attachments SET payload_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({
        kind: "related_ticket",
        ticketId: "ticket-a",
        identifierSnapshot: "alpha#1",
      }),
      "attachment-malformed",
    );
    await runMigration(db);

    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_relationships").pluck().get(),
    ).toBe(1);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM ticket_relationship_legacy_aliases")
        .pluck()
        .get(),
    ).toBe(2);
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_attachments").pluck().get(),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 13")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("rejects a related-ticket payload with unknown fields without changing data", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    db.prepare(
      `INSERT INTO ticket_attachments (
         id, ticket_id, description, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "attachment-invalid",
      "ticket-a",
      "Invalid payload",
      JSON.stringify({
        kind: "related_ticket",
        ticketId: "ticket-missing",
        identifierSnapshot: "alpha#99",
        unexpected: true,
      }),
      "2026-08-02T09:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
    );

    await expect(runMigration(db)).rejects.toThrow(
      /migration preflight failed/i,
    );

    expect(
      db.prepare("SELECT payload_json FROM ticket_attachments").pluck().get(),
    ).toContain('"unexpected":true');
    expect(
      db
        .prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 13")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rolls back migration DDL as well as data when legacy-schema preflight fails", async () => {
    db = createLegacySchemaDb();
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    db.prepare(
      `INSERT INTO ticket_attachments (
         id, ticket_id, description, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "attachment-malformed",
      "ticket-a",
      "Malformed payload",
      '{"kind":"related_ticket"',
      "2026-08-02T09:00:00.000Z",
      "2026-08-02T09:00:00.000Z",
    );
    const tablesBefore = tableNames(db);

    await expect(runMigration(db)).rejects.toThrow(
      /migration preflight failed/i,
    );

    expect(tableNames(db)).toEqual(tablesBefore);
    expect(
      db.prepare("SELECT payload_json FROM ticket_attachments").pluck().get(),
    ).toBe('{"kind":"related_ticket"');
    expect(
      db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get(),
    ).toBe(0);
  });

  it("is idempotent when replayed after the data and version transaction committed", async () => {
    db = _createTestDb({ inMemory: true });
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertTicket(db, {
      id: "ticket-b",
      projectPath: "/repos/alpha",
      number: 2,
    });
    insertLegacyAttachment(db, {
      id: "attachment-1",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-b",
      identifierSnapshot: "alpha#2",
      description: "Stable rationale",
      createdAt: "2026-08-02T08:00:00.000Z",
    });

    await runMigration(db);
    const relationshipBefore = db
      .prepare("SELECT * FROM ticket_relationships")
      .get();
    const aliasBefore = db
      .prepare("SELECT * FROM ticket_relationship_legacy_aliases")
      .get();
    await runMigration(db);

    expect(db.prepare("SELECT * FROM ticket_relationships").all()).toEqual([
      relationshipBefore,
    ]);
    expect(
      db.prepare("SELECT * FROM ticket_relationship_legacy_aliases").all(),
    ).toEqual([aliasBefore]);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 13")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("converges when two startup connections race the migration", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-ticket-migration-"));
    const dbPath = path.join(tempDir, "command-center.db");
    db = _createTestDbAtPath(dbPath);
    secondaryDb = _createTestDbAtPath(dbPath);
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertTicket(db, {
      id: "ticket-b",
      projectPath: "/repos/alpha",
      number: 2,
    });
    insertLegacyAttachment(db, {
      id: "attachment-1",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-b",
      identifierSnapshot: "alpha#2",
      description: "One relationship",
      createdAt: "2026-08-02T08:00:00.000Z",
    });

    await Promise.all([
      runMigration(db, tempDir),
      runMigration(secondaryDb, tempDir),
    ]);

    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_relationships").pluck().get(),
    ).toBe(1);
    expect(
      secondaryDb
        .prepare("SELECT COUNT(*) FROM ticket_relationship_legacy_aliases")
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) FROM ticket_attachments").pluck().get(),
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 13")
        .pluck()
        .get(),
    ).toBe(1);
    expect(existsSync(schemaCompatibilityBarrierPath(tempDir, 13))).toBe(true);
  });

  it("creates the final indexes on a legacy schema and cascades every new child row", async () => {
    db = createLegacySchemaDb();
    insertProject(db, "/repos/alpha");
    insertTicket(db, {
      id: "ticket-a",
      projectPath: "/repos/alpha",
      number: 1,
    });
    insertTicket(db, {
      id: "ticket-b",
      projectPath: "/repos/alpha",
      number: 2,
    });
    insertLegacyAttachment(db, {
      id: "attachment-1",
      hostTicketId: "ticket-a",
      targetTicketId: "ticket-b",
      identifierSnapshot: "alpha#2",
      description: "Cascading relationship",
      createdAt: "2026-08-02T08:00:00.000Z",
    });

    await runMigration(db);

    expect(indexNames(db, "ticket_relationships")).toEqual(
      expect.arrayContaining([
        "idx_ticket_relationships_source_updated",
        "idx_ticket_relationships_target_updated",
        "uq_ticket_relationships_parent_child_target",
      ]),
    );
    expect(indexNames(db, "ticket_status_updates")).toContain(
      "idx_ticket_status_updates_ticket_created",
    );
    expect(indexNames(db, "ticket_relationship_legacy_aliases")).toContain(
      "idx_ticket_relationship_legacy_aliases_anchor_relationship",
    );
    db.prepare(
      `INSERT INTO ticket_status_updates (
         id, ticket_id, body_markdown, author_json, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "update-1",
      "ticket-a",
      "Still in progress",
      JSON.stringify({ kind: "user" }),
      "2026-08-03T08:00:00.000Z",
    );

    db.prepare("DELETE FROM tickets WHERE id = ?").run("ticket-a");

    for (const table of [
      "ticket_relationships",
      "ticket_relationship_legacy_aliases",
      "ticket_status_updates",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
