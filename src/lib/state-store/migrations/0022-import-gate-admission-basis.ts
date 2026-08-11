import { SPEC_GATE_ADMISSIONS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Admit `import` as a `spec_gate_admissions.basis` value: an imported spec
 * crosses its authoring gates on the strength of an external document, and that
 * provenance is recorded as an admission with no approval row behind it.
 *
 * SQLite cannot alter a CHECK constraint in place, so a database whose table
 * predates the widened floor DDL is rebuilt through the standard
 * copy-and-rename flow (the 0017 precedent). The fresh table comes from the
 * shared `SPEC_GATE_ADMISSIONS_SCHEMA_DDL` constant rather than a hand-synced
 * copy, and the floor index is dropped first — an index left attached to the
 * renamed table would block the shared DDL's CREATE and then be deleted with
 * the old table.
 *
 * Nothing references `spec_gate_admissions`, so this rebuild needs neither the
 * `legacy_alter_table` dance nor a child-table repair; foreign keys are still
 * switched off for the window so the copy is not evaluated against the
 * half-rebuilt schema.
 *
 * NOT breaking, so no `KNOWN_SCHEMA_VERSION` bump: widening a CHECK only adds
 * values a writer may use, and no build can write `import` until the spec-import
 * service exists. Every row an older build can produce still satisfies the wider
 * constraint, and every row it can read still parses. The forward-only fence
 * belongs with the change that first WRITES an import-basis row — a build whose
 * basis enum lacks `import` cannot read that row — and must be stamped there.
 */
export const importGateAdmissionBasis: StateMigration = {
  name: "0022-import-gate-admission-basis",
  up: async ({ context }) => {
    const { db } = context;
    const migrate = db.transaction(() => {
      const table = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'spec_gate_admissions'",
        )
        .get() as { sql: string } | undefined;
      if (table === undefined) {
        db.exec(SPEC_GATE_ADMISSIONS_SCHEMA_DDL);
        return;
      }
      if (table.sql.includes("'import'")) return;

      const before = (
        db
          .prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions")
          .get() as { count: number }
      ).count;
      db.exec(`
        DROP INDEX IF EXISTS idx_spec_gate_admissions_spec_gate;
        ALTER TABLE spec_gate_admissions RENAME TO spec_gate_admissions_old_check;
      `);
      db.exec(SPEC_GATE_ADMISSIONS_SCHEMA_DDL);
      db.exec(`
        INSERT INTO spec_gate_admissions (
          id, spec_id, gate, basis, approval_id, revision_id, execution_id,
          actor_json, created_at
        )
        SELECT
          id, spec_id, gate, basis, approval_id, revision_id, execution_id,
          actor_json, created_at
        FROM spec_gate_admissions_old_check;
      `);
      // Row-count parity before the old table is unrecoverable: foreign keys
      // are off for this window, so a silently partial copy would drop audit
      // rows with nothing else noticing.
      const after = (
        db
          .prepare("SELECT COUNT(*) AS count FROM spec_gate_admissions")
          .get() as { count: number }
      ).count;
      if (after !== before) {
        throw new Error(
          `0022 rebuild copied ${after} of ${before} spec_gate_admissions rows; refusing to drop the original`,
        );
      }
      db.exec("DROP TABLE spec_gate_admissions_old_check;");
    });

    // `foreign_keys` is a connection pragma SQLite ignores inside a
    // transaction, so it wraps it; restoring in a `finally` matters, because a
    // failed migration must not leave the process with foreign keys disabled.
    const foreignKeysEnabled =
      db.pragma("foreign_keys", { simple: true }) === 1;
    if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
    try {
      migrate.immediate();
    } finally {
      if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
    }
  },
};
