import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { addColumnToleratingRace } from "./state-db";

type Db = InstanceType<typeof Database>;

function columnNames(db: Db, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.map((c) => c.name);
}

describe("addColumnToleratingRace", () => {
  let dir: string | undefined;
  let db: Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  function openTempDb(): Db {
    dir = mkdtempSync(path.join(os.tmpdir(), "cc-additive-col-"));
    const conn = new Database(path.join(dir, "test.db"));
    conn.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY)");
    return conn;
  }

  it("adds a missing column", () => {
    db = openTempDb();
    addColumnToleratingRace(
      db,
      "conversations",
      "last_seen_alignment_version",
      "INTEGER",
    );
    expect(columnNames(db, "conversations")).toContain(
      "last_seen_alignment_version",
    );
  });

  it("tolerates a duplicate-column error once the column is present (lost race)", () => {
    db = openTempDb();
    // A concurrent winner (e.g. another `next build` page-data worker) already
    // added the column. The loser still attempts the ALTER because it decided to
    // add from a now-stale existence check.
    db.exec(
      "ALTER TABLE conversations ADD COLUMN last_seen_alignment_version INTEGER",
    );
    expect(() =>
      addColumnToleratingRace(
        db!,
        "conversations",
        "last_seen_alignment_version",
        "INTEGER",
      ),
    ).not.toThrow();
    expect(columnNames(db, "conversations")).toContain(
      "last_seen_alignment_version",
    );
  });

  it("propagates a non-duplicate ALTER error (e.g. unknown table)", () => {
    db = openTempDb();
    expect(() =>
      addColumnToleratingRace(db!, "nonexistent_table", "c", "INTEGER"),
    ).toThrow(/no such table/i);
  });
});
