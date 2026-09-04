import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addMemoryNotes } from "./0040-add-memory-notes";
import { addMemorySearchIndex } from "./0041-add-memory-search-index";

type Db = InstanceType<typeof Database>;

let rawDb: Db | null = null;
let fixture: PersistenceFixture | null = null;

afterEach(() => {
  rawDb?.close();
  rawDb = null;
  fixture?.close();
  fixture = null;
});

async function runMigration(db: Db): Promise<void> {
  await addMemorySearchIndex.up({
    name: addMemorySearchIndex.name,
    context: { db, configDir: null },
  });
}

/**
 * The database this migration actually meets in the wild: one that already
 * recorded `0040-add-memory-notes`, so the canonical tables it indexes exist
 * but the derived index does not.
 */
async function createNotesOnlyDb(): Promise<Db> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (root_path TEXT PRIMARY KEY)`);
  await addMemoryNotes.up({
    name: addMemoryNotes.name,
    context: { db, configDir: null },
  });
  return db;
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe("0041-add-memory-search-index", () => {
  it("creates the FTS5 index on a database that lacks it", async () => {
    rawDb = await createNotesOnlyDb();
    expect(tableNames(rawDb)).not.toContain("memory_notes_fts");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("memory_notes_fts");
  });

  it("is idempotent and preserves indexed rows on replay", async () => {
    rawDb = await createNotesOnlyDb();
    await runMigration(rawDb);
    rawDb
      .prepare(
        `INSERT INTO memory_notes_fts (rowid, slug, hook, aliases, body)
         VALUES (1, 'a-slug', 'A hook', '', 'A body')`,
      )
      .run();

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare(
          `SELECT rowid FROM memory_notes_fts WHERE memory_notes_fts MATCH 'hook'`,
        )
        .all(),
    ).toEqual([{ rowid: 1 }]);
  });

  it("creates a contentless index, so no canonical content can live in it", async () => {
    rawDb = await createNotesOnlyDb();

    await runMigration(rawDb);

    const sql = (
      rawDb
        .prepare(
          `SELECT sql FROM sqlite_master WHERE name = 'memory_notes_fts'`,
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("content=''");
    expect(sql).toContain("contentless_delete=1");
    expect(sql).toContain("porter unicode61");
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("memory_notes_fts");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("memory_notes_fts");
  });

  it("stamps no compatibility version — a derived index is additive", async () => {
    // The index is rebuildable from the canonical tables at any time, so an
    // older build that never writes it costs a newer build nothing.
    fixture = createPersistenceFixture();
    const before = fixture.db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all();

    await runMigration(fixture.db);

    expect(
      fixture.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);
  });
});
