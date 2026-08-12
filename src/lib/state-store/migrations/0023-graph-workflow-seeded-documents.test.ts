import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  SchemaVersionConflictError,
  enforceSqliteSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { migrations } from "./index";
import type { StateMigration } from "./types";

type Db = InstanceType<typeof Database>;

const MIGRATION_NAME = "0023-graph-workflow-seeded-documents";
/** The last version that predates the `seeded` shared-document kind. */
const PRE_SEEDED_VERSION = 6;

let rawDb: Db | null = null;
let fixture: PersistenceFixture | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  rawDb?.close();
  rawDb = null;
  fixture?.close();
  fixture = null;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function registered(): StateMigration {
  const migration = migrations.find((entry) => entry.name === MIGRATION_NAME);
  if (migration === undefined) {
    throw new Error(`the migration registry carries no ${MIGRATION_NAME}`);
  }
  return migration;
}

async function runMigration(db: Db, configDir: string | null = null) {
  const migration = registered();
  await migration.up({ name: migration.name, context: { db, configDir } });
}

function fileBackedDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-0023-barrier-"));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, "command-center.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  rawDb = db;
  return { db, dir };
}

function stampedVersion(db: Db): number | null {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version;
}

/**
 * A `sharedDocuments` entry with `kind:"seeded"` lives in
 * `graph_workflow_executions.runtime_json`, and the repository THROWS on a
 * value its enum does not admit — for the whole `listActive()` result, not the
 * one row. An older build sharing `command-center.db` therefore has to be
 * refused at open time; nothing downstream can degrade gracefully.
 */
describe("0023-graph-workflow-seeded-documents", () => {
  it("fences out builds that predate the seeded shared-document kind", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;

    await runMigration(opened.db);

    expect(stampedVersion(opened.db)).toBe(KNOWN_SCHEMA_VERSION);
    expect(KNOWN_SCHEMA_VERSION).toBeGreaterThan(PRE_SEEDED_VERSION);
    expect(() =>
      enforceSqliteSchemaCompatibility(
        opened.db,
        "test.db",
        PRE_SEEDED_VERSION,
      ),
    ).toThrow(SchemaVersionConflictError);
    // This build reads its own database.
    expect(() =>
      enforceSqliteSchemaCompatibility(
        opened.db,
        "test.db",
        KNOWN_SCHEMA_VERSION,
      ),
    ).not.toThrow();
  });

  it("publishes the fail-closed external barrier on a file-backed database", async () => {
    const { db, dir } = fileBackedDb();

    await runMigration(db, dir);

    expect(
      existsSync(schemaCompatibilityBarrierPath(dir, KNOWN_SCHEMA_VERSION)),
    ).toBe(true);
    expect(stampedVersion(db)).toBe(KNOWN_SCHEMA_VERSION);
  });

  it("replays as a no-op once stamped", async () => {
    const { db, dir } = fileBackedDb();

    await runMigration(db, dir);
    await runMigration(db, dir);

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 1 });
    expect(stampedVersion(db)).toBe(KNOWN_SCHEMA_VERSION);
  });

  it("refuses when the config directory already carries a newer external barrier", async () => {
    const { db, dir } = fileBackedDb();
    await publishSchemaCompatibilityBarrier(dir, KNOWN_SCHEMA_VERSION + 1);

    await expect(runMigration(db, dir)).rejects.toThrow(
      SchemaVersionConflictError,
    );

    expect(stampedVersion(db)).toBeNull();
  });

  it("refuses under the write lock when the ledger records a newer version", async () => {
    const { db, dir } = fileBackedDb();
    db.prepare(
      "INSERT INTO schema_migrations (version, description) VALUES (?, 'future build')",
    ).run(KNOWN_SCHEMA_VERSION + 1);

    await expect(runMigration(db, dir)).rejects.toThrow(
      SchemaVersionConflictError,
    );

    // Barrier-before-mutation: refusing after the barrier is published is the
    // safe direction, so an older reader stays excluded while this build retries.
    expect(
      existsSync(schemaCompatibilityBarrierPath(dir, KNOWN_SCHEMA_VERSION)),
    ).toBe(true);
    expect(stampedVersion(db)).toBe(KNOWN_SCHEMA_VERSION + 1);
  });
});
