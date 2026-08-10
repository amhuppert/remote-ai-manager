import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION, SPEC_EXECUTIONS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 5;
const MIGRATION_SCHEMA_DESCRIPTION =
  "spec_executions state vocabulary widened with abandoning + cleanup coordinator columns";

/**
 * BREAKING migration (design §10). Admit `abandoning` as a `spec_executions.state`
 * value: `spec abandon --execution` becomes a durable, resumable coordinator that
 * aborts the linked workflow, releases the slot, and only then finalizes, so the
 * in-flight cleanup has to survive a crash instead of stranding the workflow
 * (ticket #47 note 9e5ba960).
 *
 * SQLite cannot alter a CHECK constraint in place, so databases whose table
 * predates the widened floor DDL are rebuilt through the standard
 * copy-and-rename flow (the 0012 precedent): BOTH floor indexes are dropped
 * first — an index left attached to the renamed table would block the shared
 * DDL's CREATE and then be deleted with the old table — and the fresh table
 * comes from the shared `SPEC_EXECUTIONS_SCHEMA_DDL` constant, never a
 * hand-synced copy. The unique index on `workflow_execution_id` is partial, so
 * only rows that actually link a workflow are constrained; the copy preserves
 * that exactly.
 *
 * Unlike 0012's `validation_runs`, this table is the PARENT of six foreign
 * keys (spec_evidence, spec_proof_verdicts, spec_waivers,
 * spec_criterion_dispositions, spec_task_claims, spec_gate_admissions), so the
 * rebuild follows SQLite's documented procedure for that case rather than a
 * bare rename. `legacy_alter_table` is switched ON so `ALTER TABLE … RENAME`
 * does NOT rewrite those children's `REFERENCES spec_executions` clauses to
 * the temporary name — leaving them rewritten and then dropping the temporary
 * table would point every child at a table that no longer exists. Foreign keys
 * are switched OFF for the same window so the copy is not evaluated against
 * the half-rebuilt schema. Both are connection pragmas that are no-ops inside a
 * transaction, so they are flipped around it and restored in a `finally`.
 *
 * A row parked in `abandoning` is unreadable to a build whose enum lacks it —
 * the spec execution repository throws rather than quarantining — so the up
 * stamps `schema_migrations` version 5 unconditionally (fresh floor-created
 * databases included, since their tables already admit the new value) and
 * `KNOWN_SCHEMA_VERSION` is bumped in lockstep. Rebuild and stamp share one
 * immediate transaction: failure at any stage restores the narrow table and
 * leaves the version unstamped.
 */
export const specExecutionAbandonCoordinator: StateMigration = {
  name: "0017-spec-execution-abandon-coordinator",
  up: async ({ context }) => {
    const { db } = context;
    // Fail-closed external barrier before SQLite can expose widened-state
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
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spec_executions'",
        )
        .get() as { sql: string } | undefined;
      if (!table) {
        db.exec(SPEC_EXECUTIONS_SCHEMA_DDL);
      } else if (!table.sql.includes("'abandoning'")) {
        const before = (
          db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
            count: number;
          }
        ).count;
        db.exec(`
          DROP INDEX IF EXISTS idx_spec_executions_spec_state;
          DROP INDEX IF EXISTS uq_spec_executions_workflow_execution;
          ALTER TABLE spec_executions RENAME TO spec_executions_old_check;
        `);
        // The synchronous floor may already have appended the cleanup columns
        // to the legacy table, so copy named fields rather than relying on
        // table position. A pre-floor database contributes NULL for each — the
        // meaningful legacy value, since no cleanup was ever in flight.
        const legacyColumns = new Set(
          (
            db.pragma("table_info(spec_executions_old_check)") as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        );
        const legacyOrNull = (column: string): string =>
          legacyColumns.has(column) ? column : "NULL";
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
            ${legacyOrNull("cleanup_phase")},
            ${legacyOrNull("linked_workflow_execution_id")},
            ${legacyOrNull("cleanup_last_error")},
            ${legacyOrNull("cleanup_last_error_at")},
            ${legacyOrNull("execution_start_dial")}, workflow_definition_id,
            ${legacyOrNull("workflow_definition_revision")}, workflow_execution_id,
            session_name, delivered_at, abandoned_reason,
            created_at, updated_at
          FROM spec_executions_old_check;
        `);
        // Row-count parity before the old table is unrecoverable: a silently
        // partial copy would orphan every child row that references a dropped
        // execution, and foreign keys are off for this window so nothing else
        // would notice. A global `foreign_key_check` is deliberately NOT run —
        // it would also fail the migration on pre-existing orphans this rebuild
        // did not create, bricking startup for an unrelated legacy defect.
        const after = (
          db.prepare("SELECT COUNT(*) AS count FROM spec_executions").get() as {
            count: number;
          }
        ).count;
        if (after !== before) {
          throw new Error(
            `0015 rebuild copied ${after} of ${before} spec_executions rows; refusing to drop the original`,
          );
        }
        db.exec("DROP TABLE spec_executions_old_check;");
      }
      db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      ).run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
    });

    // `foreign_keys` and `legacy_alter_table` are connection pragmas that
    // SQLite ignores inside a transaction, so they wrap it. Restoring in a
    // `finally` matters: a refused migration must not leave the process with
    // foreign keys silently disabled.
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
