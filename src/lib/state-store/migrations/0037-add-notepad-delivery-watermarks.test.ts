import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addNotepads } from "./0035-add-notepads";
import { addNotepadDeliveryWatermarks } from "./0037-add-notepad-delivery-watermarks";

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
  await addNotepadDeliveryWatermarks.up({
    name: addNotepadDeliveryWatermarks.name,
    context: { db, configDir: null },
  });
}

/**
 * The database this migration actually meets in the wild: one that already
 * recorded `0035-add-notepads`, so the notepad table its foreign key targets
 * exists but the watermark table does not.
 */
async function createNotepadsOnlyDb(): Promise<Db> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (root_path TEXT PRIMARY KEY)`);
  await addNotepads.up({
    name: addNotepads.name,
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

const INSERT_NOTEPAD = `INSERT INTO notepads (
   id, scope, project_path, name, content, revision, write_mode, pinned,
   archived, created_at, updated_at
 ) VALUES (?, 'global', NULL, ?, ?, 1, 'full-edit', 0, 0, ?, ?)`;

const INSERT_WATERMARK = `INSERT INTO notepad_delivery_watermarks (
   conversation_id, notepad_id, revision, open_comment_count,
   latest_open_comment_at, updated_at
 ) VALUES (?, ?, ?, 0, NULL, ?)`;

function seedNotepad(db: Db): void {
  db.prepare(INSERT_NOTEPAD).run(
    "notepad-1",
    "Release checklist",
    "The migration lands additively.",
    "2026-08-28T09:00:00.000Z",
    "2026-08-28T09:00:00.000Z",
  );
}

describe("0037-add-notepad-delivery-watermarks", () => {
  it("creates the watermark table on a database that lacks it", async () => {
    rawDb = await createNotepadsOnlyDb();
    expect(tableNames(rawDb)).not.toContain("notepad_delivery_watermarks");

    await runMigration(rawDb);

    expect(tableNames(rawDb)).toContain("notepad_delivery_watermarks");
  });

  it("is idempotent and preserves existing watermarks on replay", async () => {
    rawDb = await createNotepadsOnlyDb();
    await runMigration(rawDb);
    seedNotepad(rawDb);
    rawDb
      .prepare(INSERT_WATERMARK)
      .run("conversation-1", "notepad-1", 3, "2026-08-28T10:00:00.000Z");

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare(
          "SELECT conversation_id, notepad_id, revision FROM notepad_delivery_watermarks",
        )
        .all(),
    ).toEqual([
      {
        conversation_id: "conversation-1",
        notepad_id: "notepad-1",
        revision: 3,
      },
    ]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("notepad_delivery_watermarks");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("notepad_delivery_watermarks");
  });

  it("stamps no compatibility version — one new table is additive", async () => {
    // The database file is shared live state across branches: an older build
    // simply ignores a table it does not read, so fencing it out would cost
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
