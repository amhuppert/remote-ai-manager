import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import { executionLeaseAndResultDeliveries } from "./0024-execution-lease-and-result-deliveries";

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
  await executionLeaseAndResultDeliveries.up({
    name: executionLeaseAndResultDeliveries.name,
    context: { db, configDir: null },
  });
}

function columnNames(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function indexNames(db: Db, table: string): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name IS NOT NULL ORDER BY name",
      )
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * The `graph_workflow_executions` shape as it stood before this migration: no
 * `lease_held`, so a pre-floor database exercises both the column add and the
 * backfill rather than skipping straight to the no-op path.
 */
const PRE_0024_EXECUTIONS_DDL = `
  CREATE TABLE graph_workflow_executions (
    project_path              TEXT NOT NULL,
    session_name              TEXT NOT NULL,
    execution_id              TEXT NOT NULL,
    seed_definition_id        TEXT NOT NULL,
    seed_definition_revision  INTEGER NOT NULL,
    started_at                TEXT NOT NULL,
    status                    TEXT NOT NULL,
    completed_at              TEXT,
    definition_json           TEXT NOT NULL,
    runtime_json              TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    PRIMARY KEY (project_path, session_name)
  );
`;

/**
 * A database at the shape this migration upgrades from. It still carries the
 * session rows a delivery's foreign key points at — only the lease projection
 * and the ledger itself are missing. The session stub carries just the
 * referenced columns, which is all a foreign key resolves.
 */
function preFloorDb(): Db {
  const db = new Database(":memory:");
  db.exec(PRE_0024_EXECUTIONS_DDL);
  db.exec(`
    CREATE TABLE sessions (
      project_path TEXT NOT NULL,
      session_name TEXT NOT NULL,
      PRIMARY KEY (project_path, session_name)
    );
    INSERT INTO sessions (project_path, session_name) VALUES ('/repo', 'session-1');
  `);
  return db;
}

const RESUMABLE_HALT = {
  type: "agent_turn_failed",
  contextId: "ctx-1",
  engine: "claude",
  cause: "sdk_error",
  message: "turn failed",
};
const NON_RESUMABLE_HALT = { type: "recovery_error", message: "unrecoverable" };
const ABANDONMENT = {
  abandonedAt: "2026-08-13T00:00:00.000Z",
  actor: { kind: "human" },
  reason: "superseded",
};

interface SeedRow {
  sessionName: string;
  status: string;
  runtime: Record<string, unknown>;
}

/** Every lease disposition the backfill has to decide, one session each. */
const SEED_ROWS: ReadonlyArray<SeedRow & { expectedLeaseHeld: 0 | 1 }> = [
  {
    sessionName: "pending",
    status: "pending",
    runtime: {},
    expectedLeaseHeld: 1,
  },
  {
    sessionName: "running",
    status: "running",
    runtime: {},
    expectedLeaseHeld: 1,
  },
  {
    sessionName: "paused",
    status: "paused",
    runtime: {},
    expectedLeaseHeld: 1,
  },
  {
    sessionName: "completed",
    status: "completed",
    runtime: {},
    expectedLeaseHeld: 0,
  },
  {
    sessionName: "aborted",
    status: "aborted",
    runtime: {},
    expectedLeaseHeld: 0,
  },
  {
    sessionName: "halted-resumable",
    status: "halted",
    runtime: { haltReason: RESUMABLE_HALT },
    expectedLeaseHeld: 1,
  },
  {
    sessionName: "halted-non-resumable",
    status: "halted",
    runtime: { haltReason: NON_RESUMABLE_HALT },
    expectedLeaseHeld: 0,
  },
  {
    sessionName: "halted-abandoned",
    status: "halted",
    runtime: { haltReason: RESUMABLE_HALT, abandonment: ABANDONMENT },
    expectedLeaseHeld: 0,
  },
];

function seedExecutions(db: Db, rows: readonly SeedRow[]): void {
  const insert = db.prepare(
    `INSERT INTO graph_workflow_executions (
       project_path, session_name, execution_id, seed_definition_id,
       seed_definition_revision, started_at, status, completed_at,
       definition_json, runtime_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      "/repo",
      row.sessionName,
      `exec-${row.sessionName}`,
      "wf-1",
      1,
      "2026-08-13T00:00:00.000Z",
      row.status,
      null,
      "{}",
      JSON.stringify(row.runtime),
      "2026-08-13T00:00:00.000Z",
    );
  }
}

function leaseHeldBySession(db: Db): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT session_name, lease_held FROM graph_workflow_executions ORDER BY session_name",
    )
    .all() as Array<{ session_name: string; lease_held: number }>;
  return Object.fromEntries(
    rows.map((row) => [row.session_name, row.lease_held]),
  );
}

const INSERT_DELIVERY = `INSERT INTO graph_workflow_result_deliveries (
   execution_id, boundary_seq, project_path, session_name,
   origin_conversation_id, payload_json, recorded_at, delivery_state,
   attempt_id, attempt_count, delivered_at
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe("0024-execution-lease-and-result-deliveries", () => {
  it("adds lease_held and backfills it through the canonical lifecycle rule", async () => {
    rawDb = preFloorDb();
    seedExecutions(rawDb, SEED_ROWS);
    expect(columnNames(rawDb, "graph_workflow_executions")).not.toContain(
      "lease_held",
    );

    await runMigration(rawDb);

    expect(columnNames(rawDb, "graph_workflow_executions")).toContain(
      "lease_held",
    );
    expect(leaseHeldBySession(rawDb)).toEqual(
      Object.fromEntries(
        SEED_ROWS.map((row) => [row.sessionName, row.expectedLeaseHeld]),
      ),
    );
  });

  it("backfills a readable reasonless halt as lease-free, and fails closed only when the row cannot be read", async () => {
    // The two cases differ in KIND, so the backfill must not treat them alike.
    //
    // `reasonless` is perfectly readable: status halted, no halt reason. The
    // pinned rule is `halted holds IFF isResumableHalt(haltReason)`, and there
    // is no reason to be resumable, so it is lease-free and belongs in History.
    //
    // `unparseable` cannot be classified at all. Fail-closed still governs
    // THERE: a wrongly-free lease admits a second Current run, while a
    // wrongly-held one is recoverable by abandoning it.
    rawDb = preFloorDb();
    seedExecutions(rawDb, [
      { sessionName: "reasonless", status: "halted", runtime: {} },
      { sessionName: "unparseable", status: "halted", runtime: {} },
    ]);
    rawDb
      .prepare(
        "UPDATE graph_workflow_executions SET runtime_json = 'not json' WHERE session_name = 'unparseable'",
      )
      .run();

    await runMigration(rawDb);

    expect(leaseHeldBySession(rawDb)).toEqual({
      reasonless: 0,
      unparseable: 1,
    });
  });

  it("creates the result-delivery ledger with its boundary key, states, and indexes", async () => {
    rawDb = preFloorDb();
    expect(tableNames(rawDb)).not.toContain("graph_workflow_result_deliveries");

    await runMigration(rawDb);

    expect(columnNames(rawDb, "graph_workflow_result_deliveries")).toEqual([
      "execution_id",
      "boundary_seq",
      "project_path",
      "session_name",
      "origin_conversation_id",
      "payload_json",
      "recorded_at",
      "delivery_state",
      "attempt_id",
      "attempt_count",
      "delivered_at",
      "effects_delivered_at",
    ]);
    expect(indexNames(rawDb, "graph_workflow_result_deliveries")).toEqual([
      "idx_graph_workflow_result_deliveries_pending",
      "idx_graph_workflow_result_deliveries_session",
      // SQLite's implicit index for the composite (execution_id, boundary_seq)
      // primary key — the boundary uniqueness this ledger is keyed on.
      "sqlite_autoindex_graph_workflow_result_deliveries_1",
    ]);
  });

  it("keys the ledger by boundary so a repeated recording cannot double-deliver", async () => {
    rawDb = preFloorDb();
    await runMigration(rawDb);
    const insert = rawDb.prepare(INSERT_DELIVERY);
    const args = [
      "exec-1",
      7,
      "/repo",
      "session-1",
      "conversation-1",
      '{"state":"halted"}',
      "2026-08-13T00:00:00.000Z",
      "pending",
      null,
      0,
      null,
    ] as const;
    insert.run(...args);

    expect(() => insert.run(...args)).toThrow(/UNIQUE constraint/i);
  });

  it("admits exactly the pending, delivering, and delivered states", async () => {
    rawDb = preFloorDb();
    await runMigration(rawDb);
    const insert = rawDb.prepare(INSERT_DELIVERY);

    let boundarySeq = 0;
    for (const state of ["pending", "delivering", "delivered"] as const) {
      boundarySeq += 1;
      insert.run(
        "exec-1",
        boundarySeq,
        "/repo",
        "session-1",
        "conversation-1",
        "{}",
        "2026-08-13T00:00:00.000Z",
        state,
        null,
        0,
        state === "delivered" ? "2026-08-13T00:01:00.000Z" : null,
      );
    }

    expect(() =>
      insert.run(
        "exec-1",
        99,
        "/repo",
        "session-1",
        "conversation-1",
        "{}",
        "2026-08-13T00:00:00.000Z",
        "attached",
        null,
        0,
        null,
      ),
    ).toThrow(/CHECK constraint/i);
  });

  it("replays idempotently, preserving backfilled leases and recorded deliveries", async () => {
    rawDb = preFloorDb();
    seedExecutions(rawDb, SEED_ROWS);
    await runMigration(rawDb);
    rawDb
      .prepare(INSERT_DELIVERY)
      .run(
        "exec-1",
        1,
        "/repo",
        "session-1",
        "conversation-1",
        "{}",
        "2026-08-13T00:00:00.000Z",
        "delivered",
        "attempt-1",
        2,
        "2026-08-13T00:01:00.000Z",
      );

    await runMigration(rawDb);

    expect(leaseHeldBySession(rawDb)).toEqual(
      Object.fromEntries(
        SEED_ROWS.map((row) => [row.sessionName, row.expectedLeaseHeld]),
      ),
    );
    expect(
      rawDb
        .prepare(
          "SELECT delivery_state, attempt_id, attempt_count FROM graph_workflow_result_deliveries",
        )
        .all(),
    ).toEqual([
      {
        delivery_state: "delivered",
        attempt_id: "attempt-1",
        attempt_count: 2,
      },
    ]);
  });

  it("is a no-op on a floor-created database and leaves the compatibility version alone", async () => {
    const opened = createPersistenceFixture();
    fixture = opened;
    expect(columnNames(opened.db, "graph_workflow_executions")).toContain(
      "lease_held",
    );
    expect(tableNames(opened.db)).toContain("graph_workflow_result_deliveries");
    const stampedBefore = opened.db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };

    await runMigration(opened.db);

    expect(columnNames(opened.db, "graph_workflow_executions")).toContain(
      "lease_held",
    );
    expect(
      opened.db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual(stampedBefore);
    // Version 11 is the attention-citation cutover (migration 0034); this
    // migration's own barrier remains the version-8 stamp asserted above.
    expect(KNOWN_SCHEMA_VERSION).toBe(11);
  });

  it("cascades a delivery with its session but survives losing the origin conversation", async () => {
    // Losing the origin conversation is the tombstone case: the pending row has
    // to outlive it to settle once into a session-scoped notification, so it
    // deliberately carries no conversation foreign key. A deleted session takes
    // its executions with it, and the deliveries go too.
    const opened = createPersistenceFixture();
    fixture = opened;
    opened.seedProject("/repo");
    opened.seedSession("/repo", "session-1");
    opened.db
      .prepare(INSERT_DELIVERY)
      .run(
        "exec-1",
        1,
        "/repo",
        "session-1",
        "conversation-1",
        "{}",
        "2026-08-13T00:00:00.000Z",
        "pending",
        null,
        0,
        null,
      );

    opened.db
      .prepare("DELETE FROM conversations WHERE id = 'conversation-1'")
      .run();
    expect(
      opened.db
        .prepare(
          "SELECT COUNT(*) AS count FROM graph_workflow_result_deliveries",
        )
        .get(),
    ).toEqual({ count: 1 });

    opened.db
      .prepare("DELETE FROM sessions WHERE session_name = 'session-1'")
      .run();
    expect(
      opened.db
        .prepare(
          "SELECT COUNT(*) AS count FROM graph_workflow_result_deliveries",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("leaves an upgraded database with the same shape a fresh floor creates", async () => {
    rawDb = preFloorDb();
    await runMigration(rawDb);
    const opened = createPersistenceFixture();
    fixture = opened;

    expect(columnNames(rawDb, "graph_workflow_executions")).toEqual(
      columnNames(opened.db, "graph_workflow_executions"),
    );
    expect(columnNames(rawDb, "graph_workflow_result_deliveries")).toEqual(
      columnNames(opened.db, "graph_workflow_result_deliveries"),
    );
    expect(indexNames(rawDb, "graph_workflow_result_deliveries")).toEqual(
      indexNames(opened.db, "graph_workflow_result_deliveries"),
    );
  });
});
