import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createConversationsRepo } from "./conversations-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";

type Db = InstanceType<typeof Database>;

/**
 * Hot conversation rows are read through an explicit column projection, so no
 * enumeration drags a heavy column it does not decode. These tests capture the
 * SQL every read statement prepares and prove none of them is a wildcard or
 * names the retired `machine_snapshot` column.
 */

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
 * the given table (excludes other tables and non-SELECTs).
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
  // A `\b` after the table name excludes tables that merely share its prefix.
  const fromTable = new RegExp(`FROM ${table}\\b`);
  return captured.filter(
    (sql) => /^\s*SELECT/i.test(sql) && fromTable.test(sql),
  );
}

beforeEach(() => {
  db = freshDb();
});

afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

describe("hot conversation rows are read through an explicit projection", () => {
  it("no conversations-repo SELECT statement mentions machine_snapshot", () => {
    const selects = captureReadSql(createConversationsRepo, "conversations");
    // The repo really compiled its read statements (findById / findByKey /
    // findBySession / findAll) — the guard is not vacuous.
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const sql of selects) {
      // `SELECT *` would silently drag every heavy column on the row, so an
      // explicit projection is required.
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
});
