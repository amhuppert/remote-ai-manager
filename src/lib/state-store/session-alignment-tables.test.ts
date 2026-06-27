import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

function tableNames(db: Db): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: Db, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

function indexNames(db: Db, table: string): string[] {
  const idx = db.pragma(`index_list(${table})`) as { name: string }[];
  return idx.map((i) => i.name);
}

function seedSession(db: Db): void {
  db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo')`).run();
  db.prepare(
    `INSERT INTO sessions
       (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at)
     VALUES ('/repo', 's1', '/wt/s1', 'csm/s1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
}

describe("session_alignment schema floor", () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates all three alignment tables on a fresh in-memory DB", () => {
    db = _createTestDb({ inMemory: true });
    const names = tableNames(db);
    expect(names.has("session_alignment_versions")).toBe(true);
    expect(names.has("session_alignment_decisions")).toBe(true);
    expect(names.has("session_alignment_decision_proposals")).toBe(true);
  });

  it("creates session_alignment_versions with the documented columns", () => {
    db = _createTestDb({ inMemory: true });
    const cols = columnNames(db, "session_alignment_versions");
    for (const expected of [
      "id",
      "project_path",
      "session_name",
      "version",
      "content",
      "content_hash",
      "status",
      "source",
      "author_conversation_id",
      "auto_activate",
      "linked_decision_ids",
      "approver",
      "created_at",
      "activated_at",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("creates session_alignment_decisions with the documented columns", () => {
    db = _createTestDb({ inMemory: true });
    const cols = columnNames(db, "session_alignment_decisions");
    for (const expected of [
      "id",
      "project_path",
      "session_name",
      "statement",
      "rationale",
      "origin_conversation_id",
      "origin_message_id",
      "produced_version",
      "approved_at",
      "approver",
      "created_at",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("creates session_alignment_decision_proposals with the documented columns", () => {
    db = _createTestDb({ inMemory: true });
    const cols = columnNames(db, "session_alignment_decision_proposals");
    for (const expected of [
      "id",
      "project_path",
      "session_name",
      "conversation_id",
      "batch_id",
      "statement",
      "rationale",
      "context",
      "origin_message_id",
      "created_at",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  it("creates the supporting indexes on each alignment table", () => {
    db = _createTestDb({ inMemory: true });
    expect(indexNames(db, "session_alignment_versions")).toContain(
      "idx_session_alignment_versions_status",
    );
    expect(indexNames(db, "session_alignment_decisions")).toContain(
      "idx_session_alignment_decisions_approved_at",
    );
    expect(indexNames(db, "session_alignment_decision_proposals")).toContain(
      "idx_session_alignment_decision_proposals_batch",
    );
  });

  it("adds last_seen_alignment_version to conversations via the additive path", () => {
    db = _createTestDb({ inMemory: true });
    expect(columnNames(db, "conversations")).toContain(
      "last_seen_alignment_version",
    );
  });

  it("enforces the unique (project, session, version) constraint on versions", () => {
    db = _createTestDb({ inMemory: true });
    seedSession(db);
    const insert = db.prepare(
      `INSERT INTO session_alignment_versions
         (id, project_path, session_name, version, status, source, created_at)
       VALUES (?, '/repo', 's1', 1, 'active', 'align_initial', '2026-01-01T00:00:00Z')`,
    );
    insert.run("v1");
    expect(() => insert.run("v2")).toThrow();
  });

  it("cascades a session delete to all three alignment tables", () => {
    db = _createTestDb({ inMemory: true });
    seedSession(db);
    db.prepare(
      `INSERT INTO session_alignment_versions
         (id, project_path, session_name, status, source, created_at)
       VALUES ('v1', '/repo', 's1', 'draft', 'align_initial', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO session_alignment_decisions
         (id, project_path, session_name, statement, origin_conversation_id, approved_at, created_at)
       VALUES ('d1', '/repo', 's1', 'do the thing', 'c1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO session_alignment_decision_proposals
         (id, project_path, session_name, conversation_id, batch_id, statement, created_at)
       VALUES ('p1', '/repo', 's1', 'c1', 'b1', 'propose the thing', '2026-01-01T00:00:00Z')`,
    ).run();

    db.prepare(
      `DELETE FROM sessions WHERE project_path = '/repo' AND session_name = 's1'`,
    ).run();

    for (const table of [
      "session_alignment_versions",
      "session_alignment_decisions",
      "session_alignment_decision_proposals",
    ]) {
      const remaining = db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    }
  });

  it("is idempotent — reopening an already-initialized DB preserves the tables and column", () => {
    const fileDb = _createTestDb();
    const dbPath = fileDb.name;
    fileDb.close();

    db = _createTestDbAtPath(dbPath);
    const names = tableNames(db);
    expect(names.has("session_alignment_versions")).toBe(true);
    expect(names.has("session_alignment_decisions")).toBe(true);
    expect(names.has("session_alignment_decision_proposals")).toBe(true);
    expect(columnNames(db, "conversations")).toContain(
      "last_seen_alignment_version",
    );
  });
});
