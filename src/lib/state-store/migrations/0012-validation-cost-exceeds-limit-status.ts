import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION, VALIDATION_RUNS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 4;
const MIGRATION_SCHEMA_DESCRIPTION =
  "validation_runs status vocabulary widened with cost_exceeds_limit";

/**
 * BREAKING migration. Admit `cost_exceeds_limit` as a terminal
 * `validation_runs.status` value (design: validation-concurrency §3): a
 * queued run made oversized by a limit lowering is a durable configuration
 * error, not a cancellation. SQLite cannot alter a CHECK constraint in place,
 * so databases whose table predates the widened floor DDL are rebuilt through
 * the standard copy-and-rename flow; BOTH floor indexes are dropped first
 * (an index left attached to the renamed table would block the shared DDL's
 * CREATE and then be deleted with the old table), and the fresh table comes
 * from the shared DDL constant, never a hand-synced copy.
 *
 * Rows carrying the widened status are unreadable to a build whose enum lacks
 * it, so the up stamps `schema_migrations` version 4 unconditionally — fresh
 * floor-created databases included, since their tables already admit the new
 * value — and `KNOWN_SCHEMA_VERSION` is bumped in lockstep. Rebuild and stamp
 * share one immediate transaction: failure at any stage restores the narrow
 * table and leaves the version unstamped.
 */
export const validationCostExceedsLimitStatus: StateMigration = {
  name: "0012-validation-cost-exceeds-limit-status",
  up: async ({ context }) => {
    const { db } = context;
    // Fail-closed external barrier before SQLite can expose widened-status
    // bytes: an older build that reopens mid-cutover is refused by the
    // config-directory marker before the in-database stamp is visible to it.
    // A rolled-back transaction leaves it published, which is the safe
    // direction (older readers stay excluded while this build retries).
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    const migrate = db.transaction(() => {
      // Recheck under the write lock, witnessing the build's known version
      // (0006 precedent) so a same-build replay after any future cutover
      // still converges while a newer build's advance refuses.
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      const table = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'validation_runs'",
        )
        .get() as { sql: string } | undefined;
      if (!table) {
        db.exec(VALIDATION_RUNS_SCHEMA_DDL);
      } else if (!table.sql.includes("'cost_exceeds_limit'")) {
        db.exec(`
          DROP INDEX IF EXISTS idx_validation_runs_status_queue;
          DROP INDEX IF EXISTS idx_validation_runs_project_command;
          ALTER TABLE validation_runs RENAME TO validation_runs_old_check;
        `);
        // The synchronous floor may already have appended additive columns to
        // the legacy table, so copy named fields rather than relying on table
        // position. A pre-session floor contributes NULL for that attribution.
        const legacyColumns = new Set(
          (
            db.pragma("table_info(validation_runs_old_check)") as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        );
        const sessionNameExpression = legacyColumns.has("session_name")
          ? "session_name"
          : "NULL";
        db.exec(VALIDATION_RUNS_SCHEMA_DDL);
        db.exec(`
          INSERT INTO validation_runs (
            run_id, source, command_name, cost, queue_order, status, nonce,
            lease_token, lease_expires_at, process_group_pid,
            project_path, worktree_path, session_name, conversation_id,
            workflow_execution_id, workflow_context_id, workflow_role,
            submitted_at, started_at, finished_at, queue_ms, exec_ms,
            scoped, scoped_path_count, exit_code, timed_out
          )
          SELECT
            run_id, source, command_name, cost, queue_order, status, nonce,
            lease_token, lease_expires_at, process_group_pid,
            project_path, worktree_path, ${sessionNameExpression}, conversation_id,
            workflow_execution_id, workflow_context_id, workflow_role,
            submitted_at, started_at, finished_at, queue_ms, exec_ms,
            scoped, scoped_path_count, exit_code, timed_out
          FROM validation_runs_old_check;
          DROP TABLE validation_runs_old_check;
        `);
      }
      db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      ).run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
    });
    migrate.immediate();
  },
};
