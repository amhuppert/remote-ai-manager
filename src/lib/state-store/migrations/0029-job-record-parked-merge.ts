import { addColumnToleratingRace } from "../state-db";
import type { StateMigration } from "./types";

const PARKED_MERGE_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "parked_ref", type: "TEXT" },
  { name: "prepared_sha", type: "TEXT" },
  { name: "expected_target_sha", type: "TEXT" },
  // Nullable, not `NOT NULL DEFAULT 0`: a row written before the column never
  // recorded the decision, and defaulting it would tell a land re-entry a
  // user-driven merge finishes no session.
  { name: "finalize_session_on_publish", type: "INTEGER" },
  { name: "resolution_context", type: "TEXT" },
];

/**
 * Add the `job_records` parked-merge columns — the bookkeeping a land or
 * discard re-entry reconstructs its merge input from when the in-memory job
 * registry did not survive a restart.
 *
 * Purely additive and nullable, so no `KNOWN_SCHEMA_VERSION` bump: an older
 * build reads the row through a schema that has no such keys and sees the job
 * exactly as it saw it before. No back-fill either — these facts lived only in
 * the registry, so null is the truth for every pre-existing row and a
 * reconstructed parked ref would point a land at a commit nobody parked.
 *
 * The synchronous schema floor adds the same columns on every open, so on a
 * floor-initialized database this is a no-op; the migration records the change
 * in the ordered ledger and covers a database opened between the floor's own
 * passes. The existence check and the `ALTER` are not atomic across
 * connections, so each add goes through `addColumnToleratingRace` — parallel
 * openers (a `next build` fan-out) otherwise race the same `ALTER` and the
 * losers fail.
 */
export const jobRecordParkedMerge: StateMigration = {
  name: "0029-job-record-parked-merge",
  up: async ({ context }) => {
    const { db } = context;
    const columns = db.pragma("table_info(job_records)") as Array<{
      name: string;
    }>;
    // A database that predates the table has nothing to alter and picks the
    // columns up with the table itself.
    if (columns.length === 0) return;
    const existing = new Set(columns.map((column) => column.name));
    for (const column of PARKED_MERGE_COLUMNS) {
      if (existing.has(column.name)) continue;
      addColumnToleratingRace(db, "job_records", column.name, column.type);
    }
  },
};
