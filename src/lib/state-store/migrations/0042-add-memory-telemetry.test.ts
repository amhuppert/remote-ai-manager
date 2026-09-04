import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

import { addMemoryNotes } from "./0040-add-memory-notes";
import { addMemoryTelemetry } from "./0042-add-memory-telemetry";

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
  await addMemoryTelemetry.up({
    name: addMemoryTelemetry.name,
    context: { db, configDir: null },
  });
}

/**
 * The database this migration actually meets in the wild: one that already
 * recorded `0040-add-memory-notes`, so the note table its foreign keys target
 * exists but neither telemetry table does.
 */
async function createMemoryOnlyDb(): Promise<Db> {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE projects (root_path TEXT PRIMARY KEY)`);
  db.prepare(`INSERT INTO projects VALUES (?)`).run("/repo");
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

const TELEMETRY_TABLES = [
  "memory_delivery_watermarks",
  "memory_index_delivery_state",
  "memory_observation_counters",
];

const INSERT_NOTE = `INSERT INTO memory_notes (
   id, slug, scope, project_path, session_name, session_created_at, kind, hook,
   body, index_mode, lifecycle, created_by, revision, created_at, updated_at
 ) VALUES ('note-1', 'a-lesson', 'project', '/repo', NULL, NULL, 'lesson',
   'A hook', 'A body', 'auto', 'active', 'user', 1,
   '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')`;

const INSERT_WATERMARK = `INSERT INTO memory_delivery_watermarks (
   conversation_id, memory_id, channel, revision, status_delivered, updated_at
 ) VALUES ('conversation-1', 'note-1', 'index', 1, 1, '2026-09-01T11:00:00.000Z')`;

const INSERT_COUNTER = `INSERT INTO memory_observation_counters (
   id, kind, memory_id, count, first_observed_at, last_observed_at
 ) VALUES ('counter-1', 'retrieval_index', 'note-1', 4,
   '2026-09-01T11:00:00.000Z', '2026-09-01T12:00:00.000Z')`;

describe("0042-add-memory-telemetry", () => {
  it("creates both telemetry tables on a database that lacks them", async () => {
    rawDb = await createMemoryOnlyDb();
    for (const table of TELEMETRY_TABLES) {
      expect(tableNames(rawDb)).not.toContain(table);
    }

    await runMigration(rawDb);

    for (const table of TELEMETRY_TABLES) {
      expect(tableNames(rawDb)).toContain(table);
    }
  });

  it("creates the watermark table with its status-delivered flag", async () => {
    rawDb = await createMemoryOnlyDb();

    await runMigration(rawDb);

    const columns = (
      rawDb
        .prepare("PRAGMA table_info(memory_delivery_watermarks)")
        .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    ).filter((column) => column.name === "status_delivered");
    expect(columns).toEqual([
      expect.objectContaining({ notnull: 1, dflt_value: "0" }),
    ]);
  });

  it("is idempotent and preserves existing observations on replay", async () => {
    rawDb = await createMemoryOnlyDb();
    await runMigration(rawDb);
    rawDb.exec(INSERT_NOTE);
    rawDb.exec(INSERT_WATERMARK);
    rawDb.exec(INSERT_COUNTER);

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare(
          "SELECT conversation_id, memory_id, channel, revision, status_delivered FROM memory_delivery_watermarks",
        )
        .all(),
    ).toEqual([
      {
        conversation_id: "conversation-1",
        memory_id: "note-1",
        channel: "index",
        revision: 1,
        status_delivered: 1,
      },
    ]);
    expect(
      rawDb
        .prepare(
          "SELECT kind, memory_id, count FROM memory_observation_counters",
        )
        .all(),
    ).toEqual([{ kind: "retrieval_index", memory_id: "note-1", count: 4 }]);
  });

  it("is a no-op on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    for (const table of TELEMETRY_TABLES) {
      expect(tableNames(fixture.db)).toContain(table);
    }

    await runMigration(fixture.db);

    for (const table of TELEMETRY_TABLES) {
      expect(tableNames(fixture.db)).toContain(table);
    }
  });

  it("stamps no compatibility version — two new tables are additive", async () => {
    // The database file is shared live state across branches: an older build
    // simply ignores tables it does not read, and these two carry observations
    // only, so fencing sibling branches out would buy nothing at all.
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
