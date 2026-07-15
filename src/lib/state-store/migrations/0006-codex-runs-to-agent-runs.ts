import type { StateMigration } from "./types";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";

/**
 * The codex-runs domain became the backend-generic agent-runs domain: rows
 * move from `codex_run_records` into `agent_run_records` (created by the
 * schema floor) with `backend = 'codex'`, and the terminal vocabulary aligns
 * with BackgroundJob's — `succeeded` → `completed`, `timed_out` → `failed`
 * (the timeout detail already lives in `error_message`). The legacy table is
 * dropped after the copy.
 *
 * Idempotent: the copy uses INSERT OR IGNORE and only runs while the legacy
 * table exists, so a crash-before-ledger replay converges (after the drop the
 * whole migration is a no-op). A legacy table written before the `owner_pid`
 * column existed is handled by probing the column list first.
 */
export const codexRunsToAgentRuns: StateMigration = {
  name: "0006-codex-runs-to-agent-runs",
  up: async ({ context }) => {
    const { db } = context;
    const migrate = db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      const legacyTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_run_records'",
        )
        .get();
      if (legacyTable === undefined) return;

      const legacyColumns = db.pragma(
        "table_info(codex_run_records)",
      ) as Array<{
        name: string;
      }>;
      const ownerPidExpr = legacyColumns.some((col) => col.name === "owner_pid")
        ? "owner_pid"
        : "NULL";

      db.prepare(
        `INSERT OR IGNORE INTO agent_run_records
           (run_id, backend, project_name, session_name, status, started_at,
            completed_at, summary, reference_documents, error_message, owner_pid)
         SELECT
           run_id, 'codex', project_name, session_name,
           CASE status
             WHEN 'succeeded' THEN 'completed'
             WHEN 'timed_out' THEN 'failed'
             ELSE status
           END,
           started_at, completed_at, summary, reference_documents,
           error_message, ${ownerPidExpr}
         FROM codex_run_records`,
      ).run();
      db.prepare("DROP TABLE codex_run_records").run();
    });
    // Lock before probing. A concurrent migration either finishes first (this
    // worker then sees no legacy table) or waits until copy+drop commit.
    migrate.immediate();
  },
};
