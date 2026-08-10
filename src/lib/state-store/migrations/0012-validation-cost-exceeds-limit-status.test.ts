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
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import {
  SchemaVersionConflictError,
  publishSchemaCompatibilityBarrier,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { validationCostExceedsLimitStatus } from "./0012-validation-cost-exceeds-limit-status";

type Db = InstanceType<typeof Database>;

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

function legacyFileBackedDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-0012-barrier-"));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, "command-center.db"));
  db.exec(LEGACY_DDL);
  rawDb = db;
  return { db, dir };
}

async function runMigration(db: Db): Promise<void> {
  await validationCostExceedsLimitStatus.up({
    name: validationCostExceedsLimitStatus.name,
    context: { db, configDir: null },
  });
}

/**
 * The production-shaped pre-0012 database: the table with the narrower status
 * CHECK, BOTH floor indexes, and the schema_migrations gate table every
 * floor-initialized database carries.
 */
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE validation_runs (
    run_id                TEXT PRIMARY KEY,
    source                TEXT NOT NULL CHECK (source IN (
      'agent_cli', 'graph_script_validator', 'graph_lane_merge',
      'smart_merge', 'smart_commit'
    )),
    command_name          TEXT NOT NULL,
    cost                  INTEGER NOT NULL CHECK (cost > 0),
    queue_order           INTEGER NOT NULL CHECK (queue_order >= 0),
    status                TEXT NOT NULL CHECK (status IN (
      'queued', 'running', 'passed', 'failed', 'timed_out',
      'cancelled', 'interrupted'
    )),
    nonce                 TEXT NOT NULL,
    lease_token           TEXT,
    lease_expires_at      TEXT,
    process_group_pid     INTEGER,
    project_path          TEXT NOT NULL,
    worktree_path         TEXT NOT NULL,
    session_name          TEXT,
    conversation_id       TEXT,
    workflow_execution_id TEXT,
    workflow_context_id   TEXT,
    workflow_role         TEXT CHECK (workflow_role IN (
      'implementer', 'context_validator'
    )),
    submitted_at          TEXT NOT NULL,
    started_at            TEXT,
    finished_at           TEXT,
    queue_ms              INTEGER,
    exec_ms               INTEGER,
    scoped                INTEGER NOT NULL DEFAULT 0,
    scoped_path_count     INTEGER NOT NULL DEFAULT 0,
    exit_code             INTEGER,
    timed_out             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_validation_runs_status_queue
    ON validation_runs (status, queue_order);
  CREATE INDEX idx_validation_runs_project_command
    ON validation_runs (project_path, command_name);
`;

function tableIndexes(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'validation_runs' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}

function stampedVersion(db: Db): number | null {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version;
}

function insertRow(db: Db, runId: string, status: string): void {
  db.prepare(
    `INSERT INTO validation_runs (
       run_id, source, command_name, cost, queue_order, status, nonce,
       project_path, worktree_path, session_name, conversation_id,
       submitted_at, scoped,
       scoped_path_count, timed_out
     ) VALUES (
       ?, 'agent_cli', 'test', 8, 0, ?, 'nonce-1',
       '/p', '/p/.worktrees/s', 'session-legacy', 'conversation-legacy',
       '2026-08-05T10:00:00.000Z', 0, 0, 0
     )`,
  ).run(runId, status);
}

function canInsertCostExceedsLimit(db: Db): boolean {
  try {
    insertRow(
      db,
      `vr-probe-${Math.random().toString(36).slice(2)}`,
      "cost_exceeds_limit",
    );
    return true;
  } catch {
    return false;
  }
}

describe("0012-validation-cost-exceeds-limit-status", () => {
  it("rebuilds a legacy-CHECK table, preserving rows and admitting the new status", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertRow(rawDb, "vr-existing", "passed");
    expect(canInsertCostExceedsLimit(rawDb)).toBe(false);

    await runMigration(rawDb);

    const rows = rawDb
      .prepare(
        "SELECT run_id, status, session_name, conversation_id FROM validation_runs ORDER BY run_id",
      )
      .all() as Array<{
      run_id: string;
      status: string;
      session_name: string | null;
      conversation_id: string | null;
    }>;
    expect(rows).toContainEqual({
      run_id: "vr-existing",
      status: "passed",
      session_name: "session-legacy",
      conversation_id: "conversation-legacy",
    });
    expect(canInsertCostExceedsLimit(rawDb)).toBe(true);
    // Both floor indexes must survive the rebuild: an index left attached to
    // the renamed table blocks the shared DDL's CREATE and then dies with it.
    expect(tableIndexes(rawDb)).toEqual([
      "idx_validation_runs_project_command",
      "idx_validation_runs_status_queue",
    ]);
    // The widened status vocabulary is unreadable to older builds, so the
    // forward-only gate must record the breaking cutover.
    expect(stampedVersion(rawDb)).toBe(4);
  });

  it("backfills null session attribution when rebuilding a table that predates the column", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL.replace("    session_name          TEXT,\n", ""));
    const legacyColumns = rawDb.pragma("table_info(validation_runs)") as Array<{
      name: string;
    }>;
    expect(legacyColumns.some((column) => column.name === "session_name")).toBe(
      false,
    );
    rawDb
      .prepare(
        `INSERT INTO validation_runs (
             run_id, source, command_name, cost, queue_order, status, nonce,
             project_path, worktree_path, conversation_id, submitted_at,
             scoped, scoped_path_count, timed_out
           ) VALUES (
             'vr-pre-session', 'agent_cli', 'test', 8, 0, 'passed', 'nonce-old',
             '/p', '/p/.worktrees/s', 'conversation-preserved',
             '2026-08-05T10:00:00.000Z', 0, 0, 0
           )`,
      )
      .run();

    await runMigration(rawDb);

    const row = rawDb
      .prepare(
        "SELECT session_name, conversation_id FROM validation_runs WHERE run_id = 'vr-pre-session'",
      )
      .get() as {
      session_name: string | null;
      conversation_id: string | null;
    };
    expect(row).toEqual({
      session_name: null,
      conversation_id: "conversation-preserved",
    });
  });

  it("is idempotent on an already-widened table", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertRow(rawDb, "vr-keep", "queued");

    await runMigration(rawDb);
    await runMigration(rawDb);

    const rows = rawDb
      .prepare("SELECT run_id FROM validation_runs")
      .all() as Array<{ run_id: string }>;
    expect(rows).toEqual([{ run_id: "vr-keep" }]);
    expect(canInsertCostExceedsLimit(rawDb)).toBe(true);
    expect(tableIndexes(rawDb)).toEqual([
      "idx_validation_runs_project_command",
      "idx_validation_runs_status_queue",
    ]);
    expect(stampedVersion(rawDb)).toBe(4);
  });

  it("creates the table on a database that lacks it entirely", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    await runMigration(rawDb);
    expect(canInsertCostExceedsLimit(rawDb)).toBe(true);
    expect(stampedVersion(rawDb)).toBe(4);
  });

  it("stamps the gate but changes nothing else on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    expect(canInsertCostExceedsLimit(fixture.db)).toBe(true);
    await runMigration(fixture.db);
    expect(canInsertCostExceedsLimit(fixture.db)).toBe(true);
    // A fresh DB already has the wide vocabulary; without the stamp an older
    // build could still open it and choke on cost_exceeds_limit rows.
    const row = fixture.db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    expect(row.version).toBe(4);
  });

  it("publishes the fail-closed external barrier for version 4 on a file-backed database", async () => {
    const { db, dir } = legacyFileBackedDb();
    insertRow(db, "vr-existing", "passed");

    await validationCostExceedsLimitStatus.up({
      name: validationCostExceedsLimitStatus.name,
      context: { db, configDir: dir },
    });

    // The config-directory barrier is what refuses an older build that
    // reopens mid-cutover, before the SQLite stamp is visible to it.
    expect(existsSync(schemaCompatibilityBarrierPath(dir, 4))).toBe(true);
    expect(canInsertCostExceedsLimit(db)).toBe(true);
    expect(stampedVersion(db)).toBe(4);
  });

  it("refuses under the write lock when the ledger records a newer version, leaving the barrier published and the table untouched", async () => {
    const { db, dir } = legacyFileBackedDb();
    // Above THIS build's KNOWN_SCHEMA_VERSION, so the recheck sees a genuinely
    // newer build's advance rather than a version this build already ships.
    db.prepare(
      "INSERT INTO schema_migrations (version, description) VALUES (?, 'future build')",
    ).run(KNOWN_SCHEMA_VERSION + 1);

    await expect(
      validationCostExceedsLimitStatus.up({
        name: validationCostExceedsLimitStatus.name,
        context: { db, configDir: dir },
      }),
    ).rejects.toThrow(SchemaVersionConflictError);

    // Barrier-before-mutation: refusal happens inside the transaction, after
    // the barrier published (fail-closed is the safe direction) and before
    // any rebuild touched the legacy table.
    expect(existsSync(schemaCompatibilityBarrierPath(dir, 4))).toBe(true);
    expect(canInsertCostExceedsLimit(db)).toBe(false);
  });

  it("refuses when the config directory already carries a newer external barrier", async () => {
    const { db, dir } = legacyFileBackedDb();
    // Above THIS build's KNOWN_SCHEMA_VERSION, so the barrier belongs to a
    // genuinely newer build rather than one this build already ships.
    await publishSchemaCompatibilityBarrier(dir, KNOWN_SCHEMA_VERSION + 1);

    await expect(
      validationCostExceedsLimitStatus.up({
        name: validationCostExceedsLimitStatus.name,
        context: { db, configDir: dir },
      }),
    ).rejects.toThrow(SchemaVersionConflictError);

    expect(canInsertCostExceedsLimit(db)).toBe(false);
    expect(stampedVersion(db)).toBeNull();
  });
});
