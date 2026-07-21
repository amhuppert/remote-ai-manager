import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createConversationsRepo } from "./conversations-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";

type Db = InstanceType<typeof Database>;

/**
 * Design 1 (RC-B) moved the machine snapshot off the hot conversation rows into
 * the `conversation_machine_snapshots` sidecar. The snapshot column still exists
 * on both parent tables (nulled by migration 0007, kept for forward-compat), so
 * the durable guard is at the *read* boundary: no enumeration may drag its bytes.
 * These tests capture the SQL every read statement prepares and prove none of
 * them mention `machine_snapshot`, and that the read path decodes a row whose
 * legacy `machine_snapshot` column is still populated without surfacing it.
 */

const PROJECT_PATH = "/repo";
const SESSION_NAME = "sess-1";

let db: Db;
const openDbs: Db[] = [];

function freshDb(): Db {
  const created = _createTestDb({ inMemory: true });
  openDbs.push(created);
  return created;
}

/**
 * Wrap `db.prepare` so every SQL string the repo compiles at construction is
 * captured, then build the repo. Returns the SELECT statements that read from
 * the given parent table body (excludes the sidecar table and non-SELECTs).
 */
function captureReadSql(
  build: (db: Db) => void,
  table: "conversations" | "project_conversations",
): string[] {
  const captured: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (
    sql: string,
  ) => {
    captured.push(sql);
    return original(sql);
  };
  try {
    build(db);
  } finally {
    (db as unknown as { prepare: typeof original }).prepare = original;
  }
  // A `\b` after the table name excludes `conversation_machine_snapshots`.
  const fromTable = new RegExp(`FROM ${table}\\b`);
  return captured.filter(
    (sql) => /^\s*SELECT/i.test(sql) && fromTable.test(sql),
  );
}

beforeEach(() => {
  db = freshDb();
  db.prepare(`INSERT OR IGNORE INTO projects (root_path) VALUES (?)`).run(
    PROJECT_PATH,
  );
  db.prepare(
    `INSERT INTO sessions (
       project_path, session_name, worktree_path, branch_name,
       created_at, last_activity_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_PATH,
    SESSION_NAME,
    `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    `csm/${SESSION_NAME}`,
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z",
  );
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe("hot conversation rows never read the snapshot column", () => {
  it("no conversations-repo SELECT statement mentions machine_snapshot", () => {
    const selects = captureReadSql(createConversationsRepo, "conversations");
    // The repo really compiled its read statements (findById / findByKey /
    // findBySession / findAll) — the guard is not vacuous.
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const sql of selects) {
      // `SELECT *` would silently drag the (still-present) snapshot column, so
      // an explicit projection is required — the check is not satisfied by a
      // wildcard that simply omits the column name from the SQL text.
      expect(sql, `read statement uses SELECT *:\n${sql}`).not.toMatch(
        /SELECT\s+\*/i,
      );
      expect(
        sql,
        `read statement leaks the snapshot column:\n${sql}`,
      ).not.toMatch(/machine_snapshot/);
    }
  });

  it("no project-conversations-repo SELECT statement mentions machine_snapshot", () => {
    const selects = captureReadSql(
      createProjectConversationsRepo,
      "project_conversations",
    );
    expect(selects.length).toBeGreaterThanOrEqual(3);
    for (const sql of selects) {
      expect(sql, `read statement uses SELECT *:\n${sql}`).not.toMatch(
        /SELECT\s+\*/i,
      );
      expect(
        sql,
        `read statement leaks the snapshot column:\n${sql}`,
      ).not.toMatch(/machine_snapshot/);
    }
  });

  it("decodes a session conversation whose legacy machine_snapshot column is still populated, without surfacing it", () => {
    const repo = createConversationsRepo(db);
    // A pre-migration row that still carries a snapshot blob on the parent row.
    db.prepare(
      `INSERT INTO conversations (
         id, project_path, session_name, status, prompt_count,
         created_at, last_activity_at, source, archived, agent_backend,
         unread, machine_snapshot
       ) VALUES (?, ?, ?, 'awaiting', 0, ?, ?, 'cc', 0, 'claude', 0, ?)`,
    ).run(
      "conv-legacy",
      PROJECT_PATH,
      SESSION_NAME,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      JSON.stringify({ value: "idle", context: { big: "x".repeat(1000) } }),
    );

    const loaded = repo.findByKey(PROJECT_PATH, SESSION_NAME, "conv-legacy");
    expect(loaded).not.toBeNull();
    // The snapshot is not a domain field anymore, so it never rides the row.
    expect(loaded).not.toHaveProperty("machineSnapshot");
    expect(
      repo.findBySession(PROJECT_PATH, SESSION_NAME).map((c) => c.id),
    ).toContain("conv-legacy");
    expect(repo.findAll().map((e) => e.conversation.id)).toContain(
      "conv-legacy",
    );
  });

  it("decodes a project conversation whose legacy machine_snapshot column is still populated, without surfacing it", () => {
    const repo = createProjectConversationsRepo(db);
    db.prepare(
      `INSERT INTO project_conversations (
         id, project_path, status, prompt_count, created_at, last_activity_at,
         source, archived, open, agent_backend, unread, machine_snapshot
       ) VALUES (?, ?, 'awaiting', 0, ?, ?, 'cc', 0, 1, 'claude', 0, ?)`,
    ).run(
      "pconv-legacy",
      PROJECT_PATH,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      JSON.stringify({ value: "idle", context: { big: "y".repeat(1000) } }),
    );

    const loaded = repo.findByKey(PROJECT_PATH, "pconv-legacy");
    expect(loaded).not.toBeNull();
    expect(loaded).not.toHaveProperty("machineSnapshot");
    expect(repo.findAll().map((e) => e.conversation.id)).toContain(
      "pconv-legacy",
    );
  });
});
