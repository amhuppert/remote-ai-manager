import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

function tableNames(db: Db): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnNames(db: Db, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

function indexNames(db: Db, table: string): string[] {
  const idx = db.pragma(`index_list(${table})`) as { name: string }[];
  return idx.map((i) => i.name);
}

function indexColumns(
  db: Db,
  index: string,
): Array<{ name: string; desc: number }> {
  const rows = db.pragma(`index_xinfo(${index})`) as Array<{
    name: string | null;
    desc: number;
    key: number;
  }>;
  return rows
    .filter(
      (row): row is { name: string; desc: number; key: 1 } =>
        row.key === 1 && row.name !== null,
    )
    .map(({ name, desc }) => ({ name, desc }));
}

function insertProject(db: Db, rootPath: string): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES (?)`).run(rootPath);
}

function insertTicket(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "t-1",
    project_path: "/repo",
    ticket_number: 1,
    title: "Ticket",
    description: "",
    work_type: "feature",
    status: "not_started",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tickets
       (id, project_path, ticket_number, title, description, work_type, status, created_at, updated_at)
     VALUES
       (@id, @project_path, @ticket_number, @title, @description, @work_type, @status, @created_at, @updated_at)`,
  ).run(row);
}

function insertLink(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "l-1",
    ticket_id: "t-1",
    project_path: "/repo",
    session_name: "csm/work",
    start_mode: "agent",
    linked_at: "2026-07-10T00:00:00.000Z",
    ended_at: null,
    end_reason: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO ticket_sessions
       (id, ticket_id, project_path, session_name, start_mode, linked_at, ended_at, end_reason)
     VALUES
       (@id, @ticket_id, @project_path, @session_name, @start_mode, @linked_at, @ended_at, @end_reason)`,
  ).run(row);
}

function insertRelationship(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "r-1",
    relation_type: "related",
    source_ticket_id: "t-1",
    target_ticket_id: "t-2",
    description: "",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO ticket_relationships
       (id, relation_type, source_ticket_id, target_ticket_id, description, created_at, updated_at)
     VALUES
       (@id, @relation_type, @source_ticket_id, @target_ticket_id, @description, @created_at, @updated_at)`,
  ).run(row);
}

function insertStatusUpdate(
  db: Db,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    id: "u-1",
    ticket_id: "t-1",
    body_markdown: "Work continues.",
    author_json: JSON.stringify({ kind: "user" }),
    created_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO ticket_status_updates
       (id, ticket_id, body_markdown, author_json, created_at)
     VALUES
       (@id, @ticket_id, @body_markdown, @author_json, @created_at)`,
  ).run(row);
}

describe("ticket tables DDL", () => {
  let db: Db | undefined;
  let tempDir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("creates every ticket table on a fresh in-memory DB", () => {
    db = _createTestDb({ inMemory: true });
    const tables = tableNames(db);
    expect(tables).toContain("ticket_counters");
    expect(tables).toContain("tickets");
    expect(tables).toContain("ticket_attachments");
    expect(tables).toContain("ticket_sessions");
    expect(tables).toContain("ticket_relationships");
    expect(tables).toContain("ticket_relationship_legacy_aliases");
    expect(tables).toContain("ticket_status_updates");
  });

  it("creates the documented columns", () => {
    db = _createTestDb({ inMemory: true });
    expect(columnNames(db, "ticket_counters")).toEqual([
      "project_path",
      "last_number",
    ]);
    expect(columnNames(db, "tickets")).toEqual([
      "id",
      "project_path",
      "ticket_number",
      "title",
      "description",
      "work_type",
      "status",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(db, "ticket_attachments")).toEqual([
      "id",
      "ticket_id",
      "description",
      "payload_json",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(db, "ticket_sessions")).toEqual([
      "id",
      "ticket_id",
      "project_path",
      "session_name",
      "session_created_at",
      "start_mode",
      "linked_at",
      "ended_at",
      "end_reason",
    ]);
    expect(columnNames(db, "ticket_relationships")).toEqual([
      "id",
      "relation_type",
      "source_ticket_id",
      "target_ticket_id",
      "description",
      "created_at",
      "updated_at",
    ]);
    expect(columnNames(db, "ticket_status_updates")).toEqual([
      "id",
      "ticket_id",
      "body_markdown",
      "author_json",
      "created_at",
    ]);
    expect(columnNames(db, "ticket_relationship_legacy_aliases")).toEqual([
      "legacy_attachment_id",
      "relationship_id",
      "anchor_ticket_id",
    ]);
  });

  it("creates the list-query and partial active-unique indexes", () => {
    db = _createTestDb({ inMemory: true });
    const ticketIdx = indexNames(db, "tickets");
    expect(ticketIdx).toContain("idx_tickets_project_updated");
    expect(ticketIdx).toContain("idx_tickets_status_updated");
    expect(ticketIdx).toContain("idx_tickets_project_status_type_updated");

    expect(indexNames(db, "ticket_attachments")).toContain(
      "idx_ticket_attachments_ticket_created",
    );

    const linkIdx = indexNames(db, "ticket_sessions");
    expect(linkIdx).toContain("uq_ticket_sessions_active_ticket");
    expect(linkIdx).toContain("uq_ticket_sessions_active_session");
    expect(linkIdx).toContain("idx_ticket_sessions_ticket_linked");
    expect(linkIdx).toContain("idx_ticket_sessions_project_session");

    expect(indexColumns(db, "idx_ticket_relationships_source_updated")).toEqual(
      [
        { name: "source_ticket_id", desc: 0 },
        { name: "updated_at", desc: 1 },
        { name: "id", desc: 1 },
      ],
    );
    expect(indexColumns(db, "idx_ticket_relationships_target_updated")).toEqual(
      [
        { name: "target_ticket_id", desc: 0 },
        { name: "updated_at", desc: 1 },
        { name: "id", desc: 1 },
      ],
    );
    expect(indexNames(db, "ticket_relationships")).toContain(
      "uq_ticket_relationships_parent_child_target",
    );
    expect(
      indexColumns(db, "idx_ticket_status_updates_ticket_created"),
    ).toEqual([
      { name: "ticket_id", desc: 0 },
      { name: "created_at", desc: 1 },
      { name: "id", desc: 1 },
    ]);
    expect(
      indexColumns(
        db,
        "idx_ticket_relationship_legacy_aliases_anchor_relationship",
      ),
    ).toEqual([
      { name: "anchor_ticket_id", desc: 0 },
      { name: "relationship_id", desc: 0 },
    ]);
  });

  describe("CHECK constraints", () => {
    it("rejects an unknown work type", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      expect(() => insertTicket(db!, { work_type: "epic" })).toThrow(/CHECK/);
    });

    it("rejects an unknown status", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      expect(() => insertTicket(db!, { status: "archived" })).toThrow(/CHECK/);
    });

    it("rejects a non-positive ticket number", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      expect(() => insertTicket(db!, { ticket_number: 0 })).toThrow(/CHECK/);
    });

    it("rejects a negative counter value", () => {
      db = _createTestDb({ inMemory: true });
      expect(() =>
        db!
          .prepare(
            `INSERT INTO ticket_counters (project_path, last_number) VALUES ('/repo', -1)`,
          )
          .run(),
      ).toThrow(/CHECK/);
    });

    it("rejects an unknown start mode and end reason on links", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      expect(() => insertLink(db!, { start_mode: "manual" })).toThrow(/CHECK/);
      expect(() =>
        insertLink(db!, {
          ended_at: "2026-07-10T01:00:00.000Z",
          end_reason: "abandoned",
        }),
      ).toThrow(/CHECK/);
    });

    it("enforces relationship type, endpoint, and symmetric-order invariants", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertTicket(db, { id: "t-2", ticket_number: 2 });

      expect(() =>
        insertRelationship(db!, { relation_type: "mentions" }),
      ).toThrow(/CHECK/);
      expect(() =>
        insertRelationship(db!, {
          source_ticket_id: "t-1",
          target_ticket_id: "t-1",
        }),
      ).toThrow(/CHECK/);
      expect(() =>
        insertRelationship(db!, {
          source_ticket_id: "t-2",
          target_ticket_id: "t-1",
        }),
      ).toThrow(/CHECK/);

      insertRelationship(db!, { relation_type: "depends_on" });
    });

    it("rejects blank status updates and invalid author JSON", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);

      expect(() => insertStatusUpdate(db!, { body_markdown: "   " })).toThrow(
        /CHECK/,
      );
      expect(() =>
        insertStatusUpdate(db!, { author_json: "not-json" }),
      ).toThrow(/CHECK/);
    });
  });

  describe("unique constraints", () => {
    it("rejects a duplicate ticket number within a project", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      expect(() => insertTicket(db!, { id: "t-2", ticket_number: 1 })).toThrow(
        /UNIQUE/,
      );
    });

    it("allows the same ticket number across different projects", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertProject(db, "/other");
      insertTicket(db);
      insertTicket(db, { id: "t-2", project_path: "/other" });
      const count = db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get() as {
        n: number;
      };
      expect(count.n).toBe(2);
    });

    it("enforces logical relationship uniqueness per type and direction", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertTicket(db, { id: "t-2", ticket_number: 2 });
      insertRelationship(db);

      expect(() => insertRelationship(db!, { id: "r-2" })).toThrow(/UNIQUE/);
      insertRelationship(db, { id: "r-3", relation_type: "depends_on" });
    });

    it("allows only one direct parent per child", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertTicket(db, { id: "t-2", ticket_number: 2 });
      insertTicket(db, { id: "t-3", ticket_number: 3 });
      insertRelationship(db, { relation_type: "parent_child" });

      expect(() =>
        insertRelationship(db!, {
          id: "r-2",
          relation_type: "parent_child",
          source_ticket_id: "t-3",
        }),
      ).toThrow(/UNIQUE/);
    });
  });

  describe("partial active-unique link indexes", () => {
    it("rejects a second active link for the same ticket, allows it once the first ends", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertLink(db);
      expect(() =>
        insertLink(db!, { id: "l-2", session_name: "csm/other" }),
      ).toThrow(/UNIQUE/);

      db.prepare(
        `UPDATE ticket_sessions SET ended_at = '2026-07-10T01:00:00.000Z', end_reason = 'replaced' WHERE id = 'l-1'`,
      ).run();
      insertLink(db, { id: "l-2", session_name: "csm/other" });
    });

    it("rejects a second active link for the same project + session name across tickets", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertTicket(db, { id: "t-2", ticket_number: 2 });
      insertLink(db);
      expect(() => insertLink(db!, { id: "l-2", ticket_id: "t-2" })).toThrow(
        /UNIQUE/,
      );
    });

    it("allows many historical links for one ticket", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertLink(db, {
        id: "l-1",
        ended_at: "2026-07-10T01:00:00.000Z",
        end_reason: "finished",
      });
      insertLink(db, {
        id: "l-2",
        ended_at: "2026-07-10T02:00:00.000Z",
        end_reason: "deleted",
      });
      insertLink(db, { id: "l-3" });
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM ticket_sessions`)
        .get() as { n: number };
      expect(count.n).toBe(3);
    });
  });

  describe("foreign keys", () => {
    it("cascades a project delete to every ticket-owned row", () => {
      db = _createTestDb({ inMemory: true });
      insertProject(db, "/repo");
      insertTicket(db);
      insertTicket(db, { id: "t-2", ticket_number: 2 });
      db.prepare(
        `INSERT INTO ticket_attachments (id, ticket_id, description, payload_json, created_at, updated_at)
         VALUES ('a-1', 't-1', 'note', '{"kind":"note","markdown":"x"}', '2026-07-10', '2026-07-10')`,
      ).run();
      insertLink(db);
      insertRelationship(db);
      db.prepare(
        `INSERT INTO ticket_relationship_legacy_aliases
           (legacy_attachment_id, relationship_id, anchor_ticket_id)
         VALUES ('legacy-a-1', 'r-1', 't-1')`,
      ).run();
      insertStatusUpdate(db);

      db.prepare(`DELETE FROM projects WHERE root_path = '/repo'`).run();

      for (const table of [
        "tickets",
        "ticket_attachments",
        "ticket_sessions",
        "ticket_relationships",
        "ticket_relationship_legacy_aliases",
        "ticket_status_updates",
      ]) {
        const count = db
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .get() as { n: number };
        expect(count.n).toBe(0);
      }
    });

    it("keeps ticket_counters free of any project foreign key", () => {
      db = _createTestDb({ inMemory: true });
      // Insert for a path that is not in projects — must succeed (no FK).
      db.prepare(
        `INSERT INTO ticket_counters (project_path, last_number) VALUES ('/gone', 7)`,
      ).run();

      insertProject(db, "/repo");
      db.prepare(
        `INSERT INTO ticket_counters (project_path, last_number) VALUES ('/repo', 3)`,
      ).run();
      db.prepare(`DELETE FROM projects WHERE root_path = '/repo'`).run();

      const row = db
        .prepare(
          `SELECT last_number FROM ticket_counters WHERE project_path = '/repo'`,
        )
        .get() as { last_number: number };
      expect(row.last_number).toBe(3);
    });
  });

  it("is idempotent — reopening an already-initialized DB succeeds and preserves the tables", () => {
    const fileDb = _createTestDb();
    const dbPath = fileDb.name;
    fileDb.close();

    db = _createTestDbAtPath(dbPath);
    const tables = tableNames(db);
    expect(tables).toContain("ticket_counters");
    expect(tables).toContain("tickets");
    expect(tables).toContain("ticket_attachments");
    expect(tables).toContain("ticket_sessions");
    expect(tables).toContain("ticket_relationships");
    expect(tables).toContain("ticket_relationship_legacy_aliases");
    expect(tables).toContain("ticket_status_updates");
  });

  it("adds a nullable incarnation column without guessing for legacy links", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "cc-ticket-schema-"));
    const dbPath = path.join(tempDir, "command-center.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        root_path TEXT PRIMARY KEY,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        pin_order INTEGER,
        mcp_overrides TEXT,
        agent_capability_overrides TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
        UNIQUE (id, project_path)
      );
      CREATE TABLE ticket_sessions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        session_name TEXT NOT NULL,
        start_mode TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT
      );
      INSERT INTO projects (root_path) VALUES ('/repo');
      INSERT INTO tickets
        (id, project_path, ticket_number, title, description, work_type, status, created_at, updated_at)
      VALUES
        ('t-legacy', '/repo', 1, 'Legacy', '', 'feature', 'in_progress',
         '2026-07-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      INSERT INTO ticket_sessions
        (id, ticket_id, project_path, session_name, start_mode, linked_at)
      VALUES
        ('l-legacy', 't-legacy', '/repo', 'same-name', 'agent',
         '2099-01-01T00:00:00.001Z');
    `);
    legacy.close();

    db = _createTestDbAtPath(dbPath);

    expect(columnNames(db, "ticket_sessions")).toContain("session_created_at");
    const row = db
      .prepare(
        `SELECT session_created_at FROM ticket_sessions WHERE id = 'l-legacy'`,
      )
      .get() as { session_created_at: string | null };
    expect(row.session_created_at).toBeNull();
  });
});
