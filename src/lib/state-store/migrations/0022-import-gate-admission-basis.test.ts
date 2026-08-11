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
import { importGateAdmissionBasis } from "./0022-import-gate-admission-basis";

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
  await importGateAdmissionBasis.up({
    name: importGateAdmissionBasis.name,
    context: { db, configDir: null },
  });
}

/**
 * A production-shaped pre-0022 database: the admissions table with the narrower
 * basis CHECK and the floor index, plus stubs for the four parents its foreign
 * keys resolve against. The parents matter — without them an FK violation would
 * masquerade as a refused CHECK and the probe would report the wrong reason.
 */
const LEGACY_DDL = `
  CREATE TABLE specs (id TEXT PRIMARY KEY);
  CREATE TABLE spec_approvals (id TEXT PRIMARY KEY);
  CREATE TABLE spec_revisions (id TEXT PRIMARY KEY);
  CREATE TABLE spec_executions (id TEXT PRIMARY KEY);
  CREATE TABLE spec_gate_admissions (
    id            TEXT PRIMARY KEY,
    spec_id       TEXT NOT NULL,
    gate          TEXT NOT NULL CHECK (gate IN (
      'requirements', 'design', 'plan', 'execution_start', 'delivery'
    )),
    basis         TEXT NOT NULL CHECK (basis IN (
      'human_approval', 'notify_policy', 'off_policy'
    )),
    approval_id   TEXT,
    revision_id   TEXT,
    execution_id  TEXT,
    actor_json    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (spec_id) REFERENCES specs(id) ON DELETE CASCADE,
    FOREIGN KEY (approval_id) REFERENCES spec_approvals(id),
    FOREIGN KEY (revision_id) REFERENCES spec_revisions(id),
    FOREIGN KEY (execution_id) REFERENCES spec_executions(id)
  );
  CREATE INDEX idx_spec_gate_admissions_spec_gate
    ON spec_gate_admissions (spec_id, gate, created_at DESC);
  INSERT INTO specs (id) VALUES ('spec-1');
  INSERT INTO spec_approvals (id) VALUES ('approval-1');
  INSERT INTO spec_revisions (id) VALUES ('revision-1');
  INSERT INTO spec_executions (id) VALUES ('execution-1');
`;

const INSERT_ADMISSION = `INSERT INTO spec_gate_admissions (
   id, spec_id, gate, basis, approval_id, revision_id, execution_id,
   actor_json, created_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertHumanAdmission(db: Db, id: string): void {
  db.prepare(INSERT_ADMISSION).run(
    id,
    "spec-1",
    "design",
    "human_approval",
    "approval-1",
    "revision-1",
    "execution-1",
    JSON.stringify({ kind: "human" }),
    "2026-08-09T09:00:00.000Z",
  );
}

let probeCounter = 0;

/**
 * Behavioural probe for the widened CHECK: try to write the row an import would
 * write — `import` basis with no approval behind it — and see whether SQLite
 * accepts it. Reading `sqlite_master.sql` would only assert back the DDL text
 * the migration itself wrote.
 */
function canAdmitImportBasis(db: Db, specId = "spec-1"): boolean {
  try {
    db.prepare(INSERT_ADMISSION).run(
      `admission-probe-${probeCounter++}`,
      specId,
      "design",
      "import",
      null,
      null,
      null,
      JSON.stringify({ kind: "agent", conversationId: "conversation-import" }),
      "2026-08-09T10:00:00.000Z",
    );
    return true;
  } catch {
    return false;
  }
}

function tableIndexes(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'spec_gate_admissions' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>
  )
    .map((row) => row.name)
    .sort();
}

function seedProbeSpec(db: Db): void {
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run("/repos/0022");
  db.prepare(
    `INSERT INTO specs (
       id, project_path, slug, name, gate_policy_json,
       abandoned_at, abandoned_reason, created_at, updated_at
     ) VALUES ('spec-floor', '/repos/0022', 'probe', 'Probe',
       '{"preset":"balanced"}', NULL, NULL,
       '2026-08-09T08:00:00.000Z', '2026-08-09T08:00:00.000Z')`,
  ).run();
}

describe("0022-import-gate-admission-basis", () => {
  it("rebuilds a legacy-CHECK table, preserving admissions and admitting `import`", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertHumanAdmission(rawDb, "admission-existing");
    expect(canAdmitImportBasis(rawDb)).toBe(false);

    await runMigration(rawDb);

    // Every field of the pre-existing audit row survives the rebuild: these
    // rows are the record of who let which gate through.
    expect(
      rawDb
        .prepare(
          "SELECT * FROM spec_gate_admissions WHERE id = 'admission-existing'",
        )
        .get(),
    ).toEqual({
      id: "admission-existing",
      spec_id: "spec-1",
      gate: "design",
      basis: "human_approval",
      approval_id: "approval-1",
      revision_id: "revision-1",
      execution_id: "execution-1",
      actor_json: JSON.stringify({ kind: "human" }),
      created_at: "2026-08-09T09:00:00.000Z",
    });
    expect(canAdmitImportBasis(rawDb)).toBe(true);
  });

  it("still refuses a basis outside the widened vocabulary", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);

    await runMigration(rawDb);

    // Widening the CHECK must add exactly one value, not dissolve the
    // constraint into a free-text column.
    expect(() =>
      rawDb!
        .prepare(INSERT_ADMISSION)
        .run(
          "admission-bogus",
          "spec-1",
          "design",
          "self_approval",
          null,
          null,
          null,
          JSON.stringify({ kind: "human" }),
          "2026-08-09T10:00:00.000Z",
        ),
    ).toThrow();
  });

  it("preserves the floor index across the rebuild", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertHumanAdmission(rawDb, "admission-existing");

    await runMigration(rawDb);

    // An index left attached to the renamed table blocks the shared DDL's
    // CREATE and then dies with the dropped original.
    expect(tableIndexes(rawDb)).toEqual(["idx_spec_gate_admissions_spec_gate"]);
  });

  it("leaves the rebuilt table's foreign keys resolving against the real parents", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);

    await runMigration(rawDb);

    expect(() =>
      rawDb!
        .prepare(INSERT_ADMISSION)
        .run(
          "admission-dangling",
          "spec-vanished",
          "design",
          "import",
          null,
          null,
          null,
          JSON.stringify({ kind: "human" }),
          "2026-08-09T10:00:00.000Z",
        ),
    ).toThrow();
    expect(canAdmitImportBasis(rawDb)).toBe(true);
  });

  it("restores the connection's foreign-key enforcement after the rebuild", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertHumanAdmission(rawDb, "admission-existing");
    expect(rawDb.pragma("foreign_keys", { simple: true })).toBe(1);

    await runMigration(rawDb);

    // Leaving the process with foreign keys silently off would disable
    // referential integrity for every later write on the same connection.
    expect(rawDb.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is idempotent on an already-widened table", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(LEGACY_DDL);
    insertHumanAdmission(rawDb, "admission-keep");

    await runMigration(rawDb);
    await runMigration(rawDb);

    expect(
      rawDb.prepare("SELECT id FROM spec_gate_admissions ORDER BY id").all(),
    ).toEqual([{ id: "admission-keep" }]);
    expect(canAdmitImportBasis(rawDb)).toBe(true);
    expect(tableIndexes(rawDb)).toEqual(["idx_spec_gate_admissions_spec_gate"]);
  });

  it("creates the table on a database that lacks it entirely", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(`
      CREATE TABLE specs (id TEXT PRIMARY KEY);
      CREATE TABLE spec_approvals (id TEXT PRIMARY KEY);
      CREATE TABLE spec_revisions (id TEXT PRIMARY KEY);
      CREATE TABLE spec_executions (id TEXT PRIMARY KEY);
      INSERT INTO specs (id) VALUES ('spec-1');
    `);

    await runMigration(rawDb);

    expect(canAdmitImportBasis(rawDb)).toBe(true);
  });

  it("is a no-op on a floor-created database that already admits `import`", async () => {
    fixture = createPersistenceFixture();
    seedProbeSpec(fixture.db);
    expect(canAdmitImportBasis(fixture.db, "spec-floor")).toBe(true);

    await runMigration(fixture.db);

    expect(canAdmitImportBasis(fixture.db, "spec-floor")).toBe(true);
  });
});
