import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import { retireReleaseSlotCleanupPhase } from "./0026-retire-release-slot-cleanup-phase";

type Db = InstanceType<typeof Database>;

let rawDb: Db | null = null;

afterEach(() => {
  rawDb?.close();
  rawDb = null;
});

async function runMigration(db: Db): Promise<void> {
  await retireReleaseSlotCleanupPhase.up({
    name: retireReleaseSlotCleanupPhase.name,
    context: { db, configDir: null },
  });
}

/**
 * The table as migration 0017 left it: the three-phase CHECK, before D7 retired
 * `release_slot` along with the release act that phase existed to call. Only the
 * columns this migration copies — a foreign-key parent's children are not what
 * the narrowing is about.
 */
const WIDE_CHECK_DDL = `
  CREATE TABLE spec_executions (
    id                     TEXT PRIMARY KEY,
    spec_id                TEXT NOT NULL,
    revision_id            TEXT NOT NULL,
    scope_json             TEXT NOT NULL,
    state                  TEXT NOT NULL CHECK (state IN (
      'definition_review', 'running', 'delivered', 'abandoned', 'abandoning'
    )),
    cleanup_phase          TEXT CHECK (cleanup_phase IN (
      'abort_workflow', 'release_slot', 'finalize'
    )),
    linked_workflow_execution_id TEXT,
    cleanup_last_error     TEXT,
    cleanup_last_error_at  TEXT,
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
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
`;

function insertExecution(
  db: Db,
  id: string,
  cleanupPhase: string | null,
): void {
  db.prepare(
    `INSERT INTO spec_executions (
       id, spec_id, revision_id, scope_json, state, cleanup_phase,
       linked_workflow_execution_id, workflow_definition_id,
       workflow_definition_revision, workflow_execution_id, session_name,
       created_at, updated_at
     ) VALUES (?, 'spec-1', 'revision-1', '{}', 'abandoning', ?, 'wf-1',
               'definition-1', 1, ?, 'session-1',
               '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
  ).run(id, cleanupPhase, `wf-${id}`);
}

function cleanupPhaseOf(db: Db, id: string): string | null {
  return (
    db
      .prepare("SELECT cleanup_phase FROM spec_executions WHERE id = ?")
      .get(id) as { cleanup_phase: string | null }
  ).cleanup_phase;
}

function tableSql(db: Db): string {
  return (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spec_executions'",
      )
      .get() as { sql: string }
  ).sql;
}

describe("0026-retire-release-slot-cleanup-phase", () => {
  it("advances a row parked at release_slot to finalize", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(WIDE_CHECK_DDL);
    insertExecution(rawDb, "execution-parked", "release_slot");
    insertExecution(rawDb, "execution-aborting", "abort_workflow");
    insertExecution(rawDb, "execution-none", null);

    await runMigration(rawDb);

    // Where a retry would have taken it: the abort already ran, and `finalize`
    // re-observes the linked run before it finalizes anything.
    expect(cleanupPhaseOf(rawDb, "execution-parked")).toBe("finalize");
    expect(cleanupPhaseOf(rawDb, "execution-aborting")).toBe("abort_workflow");
    expect(cleanupPhaseOf(rawDb, "execution-none")).toBeNull();
  });

  it("narrows the CHECK so the retired phase can never be written again", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(WIDE_CHECK_DDL);
    insertExecution(rawDb, "execution-parked", "release_slot");

    await runMigration(rawDb);

    expect(tableSql(rawDb)).not.toContain("release_slot");
    expect(() =>
      rawDb!
        .prepare(
          "UPDATE spec_executions SET cleanup_phase = 'release_slot' WHERE id = 'execution-parked'",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("preserves every row across the rebuild", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(WIDE_CHECK_DDL);
    for (let index = 0; index < 5; index += 1) {
      insertExecution(rawDb, `execution-${index}`, "release_slot");
    }

    await runMigration(rawDb);

    expect(
      (
        rawDb
          .prepare("SELECT COUNT(*) AS count FROM spec_executions")
          .get() as { count: number }
      ).count,
    ).toBe(5);
  });

  it("is idempotent on an already-narrowed table", async () => {
    rawDb = new Database(":memory:");
    rawDb.exec(WIDE_CHECK_DDL);
    insertExecution(rawDb, "execution-parked", "release_slot");

    await runMigration(rawDb);
    await runMigration(rawDb);

    expect(cleanupPhaseOf(rawDb, "execution-parked")).toBe("finalize");
    expect(tableSql(rawDb)).not.toContain("release_slot");
  });

  it("creates the table from the floor DDL when it does not exist yet", async () => {
    rawDb = new Database(":memory:");

    await runMigration(rawDb);

    expect(tableSql(rawDb)).toContain("cleanup_phase");
    expect(tableSql(rawDb)).not.toContain("release_slot");
  });
});
