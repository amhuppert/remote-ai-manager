import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addNotepads } from "./0035-add-notepads";

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
  await addNotepads.up({
    name: addNotepads.name,
    context: { db, configDir: null },
  });
}

/**
 * A pre-floor database always has `projects` — it predates every migration in
 * this directory — and the notepads FK targets it, so the bare connection that
 * models one must carry it too.
 */
function createPreFloorDb(): Db {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (root_path TEXT PRIMARY KEY)`);
  return db;
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const INSERT_NOTEPAD = `INSERT INTO notepads (
   id, scope, project_path, name, content, revision, write_mode, pinned,
   archived, created_at, updated_at
 ) VALUES (?, 'global', NULL, ?, ?, 1, 'full-edit', 0, 0, ?, ?)`;

describe("0035-add-notepads", () => {
  it("creates the three notepad tables on a database that lacks them", async () => {
    // A bare connection models a pre-floor database: no schema DDL has run.
    rawDb = createPreFloorDb();
    expect(tableNames(rawDb)).not.toContain("notepads");

    await runMigration(rawDb);

    const tables = tableNames(rawDb);
    expect(tables).toContain("notepads");
    expect(tables).toContain("notepad_revisions");
    expect(tables).toContain("notepad_images");
  });

  it("is idempotent and preserves existing notepads on replay", async () => {
    rawDb = createPreFloorDb();
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_NOTEPAD)
      .run(
        "notepad-1",
        "Release checklist",
        "- [ ] cut the branch",
        "2026-08-27T09:00:00.000Z",
        "2026-08-27T09:00:00.000Z",
      );

    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id, content FROM notepads").all() as Array<{
        id: string;
        content: string;
      }>,
    ).toEqual([{ id: "notepad-1", content: "- [ ] cut the branch" }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("notepads");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("notepads");
  });

  it("stamps no compatibility version — three new tables are additive", async () => {
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
