import { SPEC_EXECUTIONS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Retire the abandon coordinator's `release_slot` phase (D7 decision D5).
 *
 * Under the execution lease, a completed, aborted, or non-resumably-halted run
 * releases automatically and abandon covers the resumable-halt case, so the
 * phase whose whole job was calling an explicit release act no longer has an
 * act to call. Cleanup is `abort_workflow` → `finalize`.
 *
 * Two things must happen for the narrowed vocabulary to be honest:
 *
 * 1. A row parked mid-cleanup at `release_slot` is unreadable to the narrowed
 *    enum, and the spec execution repository throws rather than quarantining.
 *    It advances to `finalize`, which is where that phase was headed and what
 *    a retry would have reached: the abort already ran, and `finalize`
 *    re-observes the linked run before it will finalize anything, so nothing
 *    is skipped — the re-check is the guard, not the phase count.
 * 2. SQLite cannot narrow a CHECK constraint in place, so a database whose
 *    table predates the narrowed floor DDL is rebuilt through the same
 *    copy-and-rename flow migration 0017 established for widening it.
 *
 * NOT breaking, so no `schema_migrations` stamp and no `KNOWN_SCHEMA_VERSION`
 * bump: every value this leaves behind (`abort_workflow`, `finalize`, NULL) is
 * one an older build already reads. The exposure runs the other way — an older
 * build would fail to WRITE `release_slot` into a rebuilt table — and that is
 * a transient per-command failure on one mid-abandonment path, not the
 * set-read break the forward-only gate exists for.
 *
 * `spec_executions` is the parent of six foreign keys, so the rebuild follows
 * SQLite's documented procedure for that case: `legacy_alter_table` ON so the
 * RENAME does not rewrite the children's `REFERENCES` clauses to the temporary
 * name, and `foreign_keys` OFF so the copy is not evaluated against the
 * half-rebuilt schema. Both are connection pragmas SQLite ignores inside a
 * transaction, so they wrap it and are restored in a `finally`.
 */
export const retireReleaseSlotCleanupPhase: StateMigration = {
  name: "0026-retire-release-slot-cleanup-phase",
  up: async ({ context }) => {
    const { db } = context;
    const migrate = db.transaction(() => {
      const table = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spec_executions'",
        )
        .get() as { sql: string } | undefined;
      if (!table) {
        db.exec(SPEC_EXECUTIONS_SCHEMA_DDL);
        return;
      }
      // Data first: the rebuilt table's CHECK would refuse to accept a
      // `release_slot` row on the copy below.
      db.prepare(
        "UPDATE spec_executions SET cleanup_phase = 'finalize' WHERE cleanup_phase = 'release_slot'",
      ).run();
      if (!table.sql.includes("'release_slot'")) return;

      const before = (
        db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
          count: number;
        }
      ).count;
      db.exec(`
        DROP INDEX IF EXISTS idx_spec_executions_spec_state;
        DROP INDEX IF EXISTS uq_spec_executions_workflow_execution;
        ALTER TABLE spec_executions RENAME TO spec_executions_wide_check;
      `);
      db.exec(SPEC_EXECUTIONS_SCHEMA_DDL);
      db.exec(`
        INSERT INTO spec_executions (
          id, spec_id, revision_id, scope_json, state,
          cleanup_phase, linked_workflow_execution_id,
          cleanup_last_error, cleanup_last_error_at,
          execution_start_dial, workflow_definition_id,
          workflow_definition_revision, workflow_execution_id,
          session_name, delivered_at, abandoned_reason,
          created_at, updated_at
        )
        SELECT
          id, spec_id, revision_id, scope_json, state,
          cleanup_phase, linked_workflow_execution_id,
          cleanup_last_error, cleanup_last_error_at,
          execution_start_dial, workflow_definition_id,
          workflow_definition_revision, workflow_execution_id,
          session_name, delivered_at, abandoned_reason,
          created_at, updated_at
        FROM spec_executions_wide_check;
      `);
      // Row-count parity before the original is unrecoverable: foreign keys are
      // off for this window, so a silently partial copy would orphan every
      // child row that references a dropped execution and nothing would notice.
      const after = (
        db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
          count: number;
        }
      ).count;
      if (after !== before) {
        throw new Error(
          `0026 rebuild copied ${after} of ${before} spec_executions rows; refusing to drop the original`,
        );
      }
      db.exec("DROP TABLE spec_executions_wide_check;");
    });

    const foreignKeysEnabled =
      db.pragma("foreign_keys", { simple: true }) === 1;
    const legacyAlterTableEnabled =
      db.pragma("legacy_alter_table", { simple: true }) === 1;
    if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
    if (!legacyAlterTableEnabled) db.pragma("legacy_alter_table = ON");
    try {
      migrate.immediate();
    } finally {
      if (!legacyAlterTableEnabled) db.pragma("legacy_alter_table = OFF");
      if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
    }
  },
};
