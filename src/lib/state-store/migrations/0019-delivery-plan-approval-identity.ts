import { createLogger } from "@/lib/logging";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

const MIGRATION_NAME = "0019-delivery-plan-approval-identity";

/**
 * Invalidate delivery-plan approvals that predate the candidate identity.
 *
 * A stored approval used to name only the frozen snapshot and its plan hash.
 * It now binds the full candidate identity — candidateId + planHash +
 * compiledDefinitionHash — because an approval that named only the plan hash
 * still stood over a candidate compiled from different inherited defaults,
 * which is the substitution `exact-approval` exists to refuse.
 *
 * The read path parses `approval_json` strictly, so a legacy row would throw
 * on every read, reopen and start instead of naming the act that repairs it.
 * A legacy approval also cannot simply be upgraded: nothing in it records
 * which compiled bytes the human saw, and inventing that binding would forge
 * exactly the approval the invariant protects. So it is cleared, and an
 * attempt that was `approved` or `parked` on its strength returns to
 * `proposed` — the state whose own refusal names `cctl spec plan sign-off`.
 * A `launched` attempt keeps its status: the run already happened, and the
 * approval it carried is history rather than a standing permission.
 *
 * No schema-version bump. The barrier that 0017 stamped already excludes every
 * build predating this feature line, and the only readers left inside it are
 * intermediate builds of the branch that introduces the delivery plan, which
 * ships unreleased. Bumping would break the sibling worktrees still building
 * against this same shared database to guard against a build no one runs. The
 * residual — an intermediate build writing a legacy-shaped approval back after
 * this migration runs — is repaired by re-running it, because the invalidation
 * is idempotent and keyed on the row's own shape rather than on a ledger.
 */
export const deliveryPlanApprovalIdentity: StateMigration = {
  name: MIGRATION_NAME,
  up: async ({ context }) => {
    const { db } = context;
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'",
      )
      .get();
    // Migration 0015 creates the table; a database predating it has no
    // approval to invalidate and starts life with the current shape.
    if (table === undefined) return;

    const migratedAt = new Date().toISOString();
    const migrate = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT id, spec_id, status, approval_json
           FROM spec_delivery_plan_attempts
           WHERE approval_json IS NOT NULL
           ORDER BY id ASC`,
        )
        .all() as Array<{
        id: string;
        spec_id: string;
        status: string;
        approval_json: string;
      }>;

      const clearApproval = db.prepare(
        `UPDATE spec_delivery_plan_attempts
         SET approval_json = NULL, status = ?, updated_at = ?
         WHERE id = ?`,
      );
      const insertTrace = db.prepare(
        `INSERT INTO spec_events
           (spec_id, occurred_at, event_type, actor_json, payload_json)
         VALUES (?, ?, 'spec-approval-changed', ?, ?)`,
      );

      let invalidated = 0;
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.approval_json);
        } catch {
          parsed = null;
        }
        // Shape-keyed rather than ledger-keyed, so a replay converges and an
        // already-current approval is never disturbed.
        const legacy =
          typeof parsed !== "object" ||
          parsed === null ||
          typeof (parsed as { candidateId?: unknown }).candidateId !==
            "string" ||
          typeof (parsed as { compiledDefinitionHash?: unknown })
            .compiledDefinitionHash !== "string";
        if (!legacy) continue;

        const nextStatus =
          row.status === "approved" || row.status === "parked"
            ? "proposed"
            : row.status;
        clearApproval.run(nextStatus, migratedAt, row.id);
        insertTrace.run(
          row.spec_id,
          migratedAt,
          stableStringify({ kind: "system" }),
          stableStringify({
            kind: "delivery-plan-approval-invalidated",
            attemptId: row.id,
            previousStatus: row.status,
            status: nextStatus,
            reason:
              "The stored approval predates the candidate identity (candidateId + planHash + compiledDefinitionHash) and cannot name the compiled bytes it admitted.",
          }),
        );
        invalidated += 1;
      }

      if (invalidated > 0) {
        logger.info("state-store.migration_delivery_plan_approvals_cleared", {
          migration: MIGRATION_NAME,
          invalidatedCount: invalidated,
        });
      }
    });
    migrate.immediate();
  },
};
