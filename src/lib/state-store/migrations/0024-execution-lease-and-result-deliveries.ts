import { createLogger } from "@/lib/logging";
import { rawRecordHoldsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";
import {
  addColumnToleratingRace,
  GRAPH_WORKFLOW_RESULT_DELIVERIES_SCHEMA_DDL,
} from "../state-db";
import type { StateMigration } from "./types";

const logger = createLogger("state-store.migrations");

const LEASE_HELD_COLUMN = {
  name: "lease_held",
  type: "INTEGER NOT NULL DEFAULT 1",
} as const;

interface ExecutionRow {
  project_path: string;
  session_name: string;
  status: string;
  runtime_json: string;
}

function isExecutionRow(value: unknown): value is ExecutionRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.project_path === "string" &&
    typeof row.session_name === "string" &&
    typeof row.status === "string" &&
    typeof row.runtime_json === "string"
  );
}

/**
 * Decide the backfilled projection for one stored row through the canonical
 * predicate rather than restating halt resumability in SQL — the halt reason
 * lives inside `runtime_json`, which is the wrong layer for a classifier.
 *
 * Only the storage shape is decided here — the status column and the runtime
 * blob it has to be combined with. The verdict, unreadable inputs included, is
 * the classifier's, so a backfilled projection and a read of the same row can
 * never disagree.
 */
function backfilledLeaseHeld(row: ExecutionRow): boolean {
  let runtime: unknown;
  try {
    runtime = JSON.parse(row.runtime_json);
  } catch {
    return true;
  }
  if (typeof runtime !== "object" || runtime === null) return true;
  const record = runtime as Record<string, unknown>;

  return rawRecordHoldsExecutionLease({
    status: row.status,
    haltReason: record.haltReason ?? null,
    abandonment: record.abandonment ?? null,
  });
}

/**
 * The D7 persistence foundation, in one additive migration (decisions D8/D15):
 * the derived `graph_workflow_executions.lease_held` projection plus the
 * `graph_workflow_result_deliveries` ledger.
 *
 * Purely additive — an older build ignores the new table, and the new column
 * carries a default it can write through — so deliberately no
 * KNOWN_SCHEMA_VERSION bump. The synchronous floor already creates both on
 * every open, so on a floor-initialized database this only backfills; the
 * migration records the change in the ordered ledger and applies the identical
 * DDL (shared constant, no hand-synced copy) to any database that predates the
 * floor entries.
 *
 * Idempotent by construction: the DDL guards with IF NOT EXISTS, the column add
 * is skipped when present and tolerates a concurrent winner, and the backfill
 * recomputes a pure projection of bytes it does not touch.
 */
export const executionLeaseAndResultDeliveries: StateMigration = {
  name: "0024-execution-lease-and-result-deliveries",
  up: async ({ context }) => {
    const { db } = context;
    db.exec(GRAPH_WORKFLOW_RESULT_DELIVERIES_SCHEMA_DDL);

    const executionColumns = new Set(
      (
        db.pragma("table_info(graph_workflow_executions)") as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (executionColumns.size === 0) return;
    if (!executionColumns.has(LEASE_HELD_COLUMN.name)) {
      addColumnToleratingRace(
        db,
        "graph_workflow_executions",
        LEASE_HELD_COLUMN.name,
        LEASE_HELD_COLUMN.type,
      );
    }

    const rows = db
      .prepare(
        `SELECT project_path, session_name, status, runtime_json
           FROM graph_workflow_executions`,
      )
      .all() as unknown[];
    const update = db.prepare(
      `UPDATE graph_workflow_executions
          SET lease_held = @lease_held
        WHERE project_path = @project_path AND session_name = @session_name`,
    );
    let released = 0;
    db.transaction(() => {
      for (const row of rows) {
        if (!isExecutionRow(row)) continue;
        const leaseHeld = backfilledLeaseHeld(row);
        if (!leaseHeld) released += 1;
        update.run({
          lease_held: leaseHeld ? 1 : 0,
          project_path: row.project_path,
          session_name: row.session_name,
        });
      }
    })();

    logger.info("state-store.migrations.execution_lease_backfilled", {
      migration: "0024-execution-lease-and-result-deliveries",
      projected: rows.length,
      released,
    });
  },
};
