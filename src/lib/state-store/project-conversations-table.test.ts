import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb, _createTestDbAtPath } from "./state-db";

type Db = InstanceType<typeof Database>;

function columnNames(db: Db, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

function indexNames(db: Db, table: string): string[] {
  const idx = db.pragma(`index_list(${table})`) as { name: string }[];
  return idx.map((i) => i.name);
}

describe("project_conversations table DDL", () => {
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates project_conversations with the documented columns on a fresh DB", () => {
    db = _createTestDb({ inMemory: true });
    const cols = columnNames(db, "project_conversations");

    // Mirrors conversations minus session_name, plus open.
    expect(cols).toContain("id");
    expect(cols).toContain("project_path");
    expect(cols).toContain("open");
    expect(cols).toContain("archived");
    expect(cols).toContain("status");
    expect(cols).toContain("machine_snapshot");
    expect(cols).toContain("unread");
    expect(cols).not.toContain("session_name");
  });

  it("creates the project and last_activity indexes", () => {
    db = _createTestDb({ inMemory: true });
    const idx = indexNames(db, "project_conversations");
    expect(idx).toContain("idx_project_conversations_project");
    expect(idx).toContain("idx_project_conversations_last_activity");
  });

  it("cascades a delete from projects to its project conversations", () => {
    db = _createTestDb({ inMemory: true });
    db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo')`).run();
    db.prepare(
      `INSERT INTO project_conversations
         (id, project_path, status, created_at, last_activity_at)
       VALUES ('c1', '/repo', 'new', '2025-01-01', '2025-01-01')`,
    ).run();

    db.prepare(`DELETE FROM projects WHERE root_path = '/repo'`).run();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM project_conversations`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("is idempotent — reopening an already-migrated DB preserves the table", () => {
    const fileDb = _createTestDb();
    const dbPath = fileDb.name;
    fileDb.close();

    // Reopen the same on-disk file: CREATE TABLE IF NOT EXISTS + additive
    // columns must run again without error and preserve the schema.
    db = _createTestDbAtPath(dbPath);
    expect(columnNames(db, "project_conversations")).toContain("open");
  });
});
