import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addMemoryNotes } from "./0040-add-memory-notes";

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
  await addMemoryNotes.up({
    name: addMemoryNotes.name,
    context: { db, configDir: null },
  });
}

/**
 * The database this migration actually meets in the wild: one that predates the
 * floor entry, so the project table its foreign key targets exists but no
 * memory table does.
 */
function createPreMemoryDb(): Db {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (root_path TEXT PRIMARY KEY)`);
  db.prepare(`INSERT INTO projects VALUES (?)`).run("/repo");
  return db;
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const INSERT_NOTE = `INSERT INTO memory_notes (
   id, slug, scope, project_path, session_name, session_created_at, kind, hook,
   body, index_mode, lifecycle, created_by, revision, created_at, updated_at
 ) VALUES (?, ?, 'project', '/repo', NULL, NULL, 'lesson', ?, ?, 'auto',
   'active', 'user', 1, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')`;

const MEMORY_TABLES = [
  "memory_notes",
  "memory_note_aliases",
  "memory_note_revisions",
  "memory_links",
];

describe("0040-add-memory-notes", () => {
  it("creates the memory tables on a database that lacks them", async () => {
    rawDb = createPreMemoryDb();
    expect(tableNames(rawDb)).not.toContain("memory_notes");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toEqual(expect.arrayContaining(MEMORY_TABLES));
  });

  it("is idempotent and preserves existing notes on replay", async () => {
    rawDb = createPreMemoryDb();
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_NOTE)
      .run("mem-1", "fts-is-derived", "The index is derived", "body");

    await runMigration(rawDb);

    expect(rawDb.prepare("SELECT id, slug FROM memory_notes").all()).toEqual([
      { id: "mem-1", slug: "fts-is-derived" },
    ]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toEqual(
      expect.arrayContaining(MEMORY_TABLES),
    );

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toEqual(
      expect.arrayContaining(MEMORY_TABLES),
    );
  });

  it("stamps no compatibility version — the memory tables are additive", async () => {
    // The database file is shared live state across branches: an older build
    // simply ignores tables it does not read, so fencing it out would cost
    // sibling branches everything and buy nothing.
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
