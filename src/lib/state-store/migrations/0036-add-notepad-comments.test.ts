import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addNotepadComments } from "./0036-add-notepad-comments";
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
  await addNotepadComments.up({
    name: addNotepadComments.name,
    context: { db, configDir: null },
  });
}

/**
 * The database this migration actually meets in the wild: one that already
 * recorded `0035-add-notepads`, so the notepad tables its foreign keys target
 * exist but the comment tables do not.
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

const INSERT_COMMENT = `INSERT INTO notepad_comments (
   id, notepad_id, section_id, heading_label, line, char_start, char_end,
   quote, prefix, suffix, notepad_revision, body, status, author_kind,
   author_conversation_id, created_at, updated_at, resolved_at
 ) VALUES (?, ?, 'release-notes', 'Release notes', 3, 4, 13, 'migration',
   'The ', ' lands', 1, ?, 'open', 'user', NULL, ?, ?, NULL)`;

function seedNotepad(db: Db): void {
  db.prepare(INSERT_NOTEPAD).run(
    "notepad-1",
    "Release checklist",
    "The migration lands additively.",
    "2026-08-28T09:00:00.000Z",
    "2026-08-28T09:00:00.000Z",
  );
}

describe("0036-add-notepad-comments", () => {
  it("creates the two comment tables on a database that lacks them", async () => {
    rawDb = await createNotepadsOnlyDb();
    expect(tableNames(rawDb)).not.toContain("notepad_comments");

    await runMigration(rawDb);

    const tables = tableNames(rawDb);
    expect(tables).toContain("notepad_comments");
    expect(tables).toContain("notepad_comment_replies");
  });

  it("is idempotent and preserves existing comments on replay", async () => {
    rawDb = await createNotepadsOnlyDb();
    await runMigration(rawDb);
    seedNotepad(rawDb);
    rawDb
      .prepare(INSERT_COMMENT)
      .run(
        "comment-1",
        "notepad-1",
        "Name the rollback owner.",
        "2026-08-28T10:00:00.000Z",
        "2026-08-28T10:00:00.000Z",
      );

    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id, body FROM notepad_comments").all(),
    ).toEqual([{ id: "comment-1", body: "Name the rollback owner." }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(tableNames(fixture.db)).toContain("notepad_comments");

    await runMigration(fixture.db);

    expect(tableNames(fixture.db)).toContain("notepad_comment_replies");
  });

  it("stamps no compatibility version — two new tables are additive", async () => {
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
