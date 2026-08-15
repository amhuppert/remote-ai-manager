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
  publishSchemaCompatibilityBarrier,
  schemaCompatibilityBarrierPath,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { specExecutionAbandonCoordinator } from "./0017-spec-execution-abandon-coordinator";

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

/**
 * The production-shaped pre-0015 database: the table with the narrower state
 * CHECK and no cleanup columns, BOTH floor indexes, and the schema_migrations
 * gate table every floor-initialized database carries — plus the parents it
 * references and one representative CHILD table. The child is what makes this
 * fixture worth having: `spec_executions` is the parent of six foreign keys, so
 * a rebuild that lets SQLite rewrite reference clauses would silently point
 * every child at the dropped temporary table.
 */
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE specs (
    id           TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    slug         TEXT NOT NULL
  );
  CREATE TABLE spec_revisions (
    id      TEXT PRIMARY KEY,
    spec_id TEXT NOT NULL,
    number  INTEGER NOT NULL
  );
  CREATE TABLE spec_executions (
    id                     TEXT PRIMARY KEY,
    spec_id                TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    scope_json             TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN (
      'definition_review', 'running', 'delivered', 'abandoned'
    )),
    execution_start_dial   TEXT CHECK (execution_start_dial IN (
      'gate', 'notify', 'off'
    )),
    workflow_definition_id TEXT NOT NULL,
    workflow_definition_revision INTEGER CHECK (
      workflow_definition_revision > 0
    ),
    workflow_execution_id  TEXT,
    session_name           TEXT,
    delivered_at           TEXT,
    abandoned_reason       TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_spec_executions_spec_state
    ON spec_executions (spec_id, state, created_at DESC);
  CREATE UNIQUE INDEX uq_spec_executions_workflow_execution
    ON spec_executions (workflow_execution_id)
    WHERE workflow_execution_id IS NOT NULL;
  CREATE TABLE spec_evidence (
    id           TEXT PRIMARY KEY,
    execution_id TEXT,
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );
  INSERT INTO specs (id, project_path, slug)
    VALUES ('spec-1', '/repos/0015', 'legacy'),
           ('spec-probe', '/repos/0015', 'probe');
  INSERT INTO spec_revisions (id, spec_id, number)
    VALUES ('revision-1', 'spec-1', 1),
           ('revision-probe', 'spec-probe', 1);
`;

function legacyFileBackedDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cc-0015-barrier-"));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, "command-center.db"));
  db.exec(LEGACY_DDL);
  rawDb = db;
  return { db, dir };
}

async function runMigration(db: Db, configDir: string | null = null) {
  await specExecutionAbandonCoordinator.up({
    name: specExecutionAbandonCoordinator.name,
    context: { db, configDir },
  });
}

function insertExecution(
  db: Db,
  id: string,
  state: string,
  workflowExecutionId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, execution_start_dial,
       workflow_definition_id, workflow_definition_revision,
       workflow_execution_id, session_name, delivered_at, abandoned_reason,
       created_at, updated_at
     ) VALUES (
       ?, 'spec-1', 'revision-1', '{"criterionElementIds":[]}', ?, 'gate',
       'workflow-definition-1', 3, ?, 'session-legacy', NULL, NULL,
       '2026-08-06T10:00:00.000Z', '2026-08-06T10:01:00.000Z'
     )`,
  ).run(id, state, workflowExecutionId);
}

let probeCounter = 0;

/**
 * Behavioural probe for the widened CHECK: insert a row in `abandoning` and
 * see whether SQLite accepts it. Reading `sqlite_master.sql` would only assert
 * the DDL text this migration itself wrote.
 */
function canInsertAbandoning(db: Db): boolean {
  try {
    db.prepare(
      `INSERT INTO spec_executions (
         id, spec_id, revision_id, scope_json, state,
         workflow_definition_id, created_at, updated_at
       ) VALUES (
         ?, ?, ?, '{}', 'abandoning',
         'workflow-definition-probe',
         '2026-08-06T10:00:00.000Z', '2026-08-06T10:00:00.000Z'
       )`,
    ).run(
      `execution-probe-${probeCounter++}`,
      PROBE_SPEC_ID,
      PROBE_REVISION_ID,
    );
    return true;
  } catch {
    return false;
  }
}

const PROBE_SPEC_ID = "spec-probe";
const PROBE_REVISION_ID = "revision-probe";

/**
 * A floor-created database enforces foreign keys, so the probe needs real
 * parents there — otherwise an FK violation would masquerade as a refused
 * CHECK and the assertion would pass for the wrong reason.
 */
function seedProbeParents(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/repos/0015");
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES (?, '/repos/0015', 'probe', 'Probe', '{"preset":"balanced"}',
       NULL, NULL, '2026-08-06T10:00:00.000Z', '2026-08-06T10:00:00.000Z')`,
  ).run(PROBE_SPEC_ID);
  db.prepare(
    `INSERT INTO spec_revisions (
       id, spec_id, number, state, authoring_stage, based_on_revision_id,
       content_hash, proposed_at, approved_at, created_at
     ) VALUES (?, ?, 1, 'approved', 'plan', NULL, NULL, NULL, NULL,
       '2026-08-06T10:00:00.000Z')`,
  ).run(PROBE_REVISION_ID, PROBE_SPEC_ID);
}

function tableIndexes(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spec_executions' AND name NOT LIKE 'sqlite_%'",
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

describe("0017-spec-execution-abandon-coordinator", () => {
  it("rebuilds a legacy-CHECK table, preserving rows and admitting `abandoning`", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertExecution(rawDb, "execution-existing", "running", "wf-exec-existing");
    expect(canInsertAbandoning(rawDb)).toBe(false);

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare(
          "SELECT id, state, workflow_execution_id, cleanup_phase, linked_workflow_execution_id, cleanup_last_error, cleanup_last_error_at, workflow_definition_revision, execution_start_dial FROM spec_executions WHERE id = 'execution-existing'",
        )
        .get(),
    ).toEqual({
      id: "execution-existing",
      state: "running",
      workflow_execution_id: "wf-exec-existing",
      // No cleanup was ever in flight for a legacy row, so null is the
      // meaningful value — never a fabricated phase.
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      workflow_definition_revision: 3,
      execution_start_dial: "gate",
    });
    expect(canInsertAbandoning(rawDb)).toBe(true);
    // Both floor indexes must survive the rebuild: an index left attached to
    // the renamed table blocks the shared DDL's CREATE and then dies with it.
    expect(tableIndexes(rawDb)).toEqual([
      "idx_spec_executions_spec_state",
      "uq_spec_executions_workflow_execution",
    ]);
    expect(stampedVersion(rawDb)).toBe(6);
  });

  it("leaves child tables referencing spec_executions, not the temporary rebuild table", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertExecution(rawDb, "execution-parent", "running", "wf-exec-parent");
    rawDb
      .prepare("INSERT INTO spec_evidence (id, execution_id) VALUES (?, ?)")
      .run("evidence-1", "execution-parent");

    await runMigration(rawDb);

    // The behavioural proof that the reference survived: the child still
    // resolves against the rebuilt parent, and a dangling id is still refused.
    // If the RENAME had rewritten the clause, both inserts would fail with
    // "no such table: spec_executions_old_check".
    expect(() =>
      rawDb!
        .prepare("INSERT INTO spec_evidence (id, execution_id) VALUES (?, ?)")
        .run("evidence-2", "execution-parent"),
    ).not.toThrow();
    expect(() =>
      rawDb!
        .prepare("INSERT INTO spec_evidence (id, execution_id) VALUES (?, ?)")
        .run("evidence-3", "execution-vanished"),
    ).toThrow();
    // Existing child rows survive the parent rebuild untouched.
    expect(
      rawDb
        .prepare(
          "SELECT execution_id FROM spec_evidence WHERE id = 'evidence-1'",
        )
        .get(),
    ).toEqual({ execution_id: "execution-parent" });
  });

  it("restores the connection's foreign-key enforcement after the rebuild", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertExecution(rawDb, "execution-parent", "running", "wf-exec-parent");
    expect(rawDb.pragma("foreign_keys", { simple: true })).toBe(1);

    await runMigration(rawDb);

    // Leaving the process with foreign keys silently off would disable
    // referential integrity for every later write in the same connection.
    expect(rawDb.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(rawDb.pragma("legacy_alter_table", { simple: true })).toBe(0);
  });

  it("preserves the partial unique index on workflow_execution_id", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertExecution(rawDb, "execution-unlinked-a", "running", null);
    insertExecution(rawDb, "execution-unlinked-b", "running", null);
    insertExecution(rawDb, "execution-linked", "running", "wf-exec-linked");

    await runMigration(rawDb);

    // Partial: many rows may sit unlinked, but a workflow execution belongs to
    // exactly one spec execution.
    expect(() =>
      insertExecution(rawDb!, "execution-dup", "running", "wf-exec-linked"),
    ).toThrow();
    expect(() =>
      insertExecution(rawDb!, "execution-unlinked-c", "running", null),
    ).not.toThrow();
  });

  it("copies cleanup columns the synchronous floor already appended, advancing the retired phase", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    rawDb.exec(`
      ALTER TABLE spec_executions ADD COLUMN cleanup_phase TEXT;
      ALTER TABLE spec_executions ADD COLUMN linked_workflow_execution_id TEXT;
      ALTER TABLE spec_executions ADD COLUMN cleanup_last_error TEXT;
      ALTER TABLE spec_executions ADD COLUMN cleanup_last_error_at TEXT;
    `);
    insertExecution(rawDb, "execution-floored", "running", "wf-exec-floored");
    rawDb
      .prepare(
        `UPDATE spec_executions
         SET cleanup_phase = 'release_slot',
             linked_workflow_execution_id = 'wf-exec-floored',
             cleanup_last_error = 'the linked run is still live (running)',
             cleanup_last_error_at = '2026-08-06T10:02:00.000Z'
         WHERE id = 'execution-floored'`,
      )
      .run();

    await runMigration(rawDb);

    expect(
      rawDb
        .prepare(
          "SELECT cleanup_phase, linked_workflow_execution_id, cleanup_last_error, cleanup_last_error_at FROM spec_executions WHERE id = 'execution-floored'",
        )
        .get(),
    ).toEqual({
      // `release_slot` was retired with the release act it called; the rebuild
      // targets the current floor, which no longer admits it, so a row parked
      // there advances to where a retry would have taken it.
      cleanup_phase: "finalize",
      linked_workflow_execution_id: "wf-exec-floored",
      cleanup_last_error: "the linked run is still live (running)",
      cleanup_last_error_at: "2026-08-06T10:02:00.000Z",
    });
  });

  it("is idempotent on an already-widened table", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertExecution(rawDb, "execution-keep", "running", "wf-exec-keep");

    await runMigration(rawDb);
    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id FROM spec_executions ORDER BY id").all(),
    ).toEqual([{ id: "execution-keep" }]);
    expect(canInsertAbandoning(rawDb)).toBe(true);
    expect(tableIndexes(rawDb)).toEqual([
      "idx_spec_executions_spec_state",
      "uq_spec_executions_workflow_execution",
    ]);
    expect(stampedVersion(rawDb)).toBe(6);
  });

  it("creates the table on a database that lacks it entirely", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE specs (
        id           TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        slug         TEXT NOT NULL
      );
      CREATE TABLE spec_revisions (
        id      TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        number  INTEGER NOT NULL
      );
      INSERT INTO specs (id, project_path, slug)
        VALUES ('spec-probe', '/repos/0015', 'probe');
      INSERT INTO spec_revisions (id, spec_id, number)
        VALUES ('revision-probe', 'spec-probe', 1);
    `);

    await runMigration(rawDb);

    expect(canInsertAbandoning(rawDb)).toBe(true);
    expect(stampedVersion(rawDb)).toBe(6);
  });

  it("stamps the gate but changes nothing else on a floor-created database", async () => {
    fixture = createPersistenceFixture();
    seedProbeParents(fixture.db);
    expect(canInsertAbandoning(fixture.db)).toBe(true);

    await runMigration(fixture.db);

    expect(canInsertAbandoning(fixture.db)).toBe(true);
    // A fresh DB already has the wide vocabulary; without the stamp an older
    // build could still open it and choke on an `abandoning` row.
    expect(stampedVersion(fixture.db)).toBe(6);
  });

  it("publishes the fail-closed external barrier for version 6 on a file-backed database", async () => {
    const { db, dir } = legacyFileBackedDb();
    insertExecution(db, "execution-existing", "running", "wf-exec-existing");

    await runMigration(db, dir);

    expect(existsSync(schemaCompatibilityBarrierPath(dir, 6))).toBe(true);
    expect(canInsertAbandoning(db)).toBe(true);
    expect(stampedVersion(db)).toBe(6);
  });

  it("refuses under the write lock when the ledger records a newer version, leaving the barrier published and the table untouched", async () => {
    const { db, dir } = legacyFileBackedDb();
    // Relative to this build, not a literal: every later cutover raises
    // KNOWN_SCHEMA_VERSION, and a pinned number would quietly stop describing
    // a newer build the first time one lands.
    db.prepare(
      "INSERT INTO schema_migrations (version, description) VALUES (?, 'future build')",
    ).run(KNOWN_SCHEMA_VERSION + 1);

    await expect(runMigration(db, dir)).rejects.toThrow(
      SchemaVersionConflictError,
    );

    // Barrier-before-mutation: refusal happens inside the transaction, after
    // the barrier published (fail-closed is the safe direction) and before
    // any rebuild touched the legacy table.
    expect(existsSync(schemaCompatibilityBarrierPath(dir, 6))).toBe(true);
    expect(canInsertAbandoning(db)).toBe(false);
  });

  it("refuses when the config directory already carries a newer external barrier", async () => {
    const { db, dir } = legacyFileBackedDb();
    await publishSchemaCompatibilityBarrier(dir, KNOWN_SCHEMA_VERSION + 1);

    await expect(runMigration(db, dir)).rejects.toThrow(
      SchemaVersionConflictError,
    );

    expect(canInsertAbandoning(db)).toBe(false);
    expect(stampedVersion(db)).toBeNull();
  });
});
