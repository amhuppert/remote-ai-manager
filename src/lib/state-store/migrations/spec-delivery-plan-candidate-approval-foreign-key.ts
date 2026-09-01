import { SPEC_DELIVERY_PLAN_SCHEMA_DDL } from "../state-db";
import type { MigrationContext } from "./types";

type Db = MigrationContext["db"];

export function hasCurrentCandidateApprovalForeignKey(db: Db): boolean {
  const foreignKeys = db
    .prepare("PRAGMA foreign_key_list(spec_delivery_plan_candidate_approvals)")
    .all() as Array<{ table: string; from: string; to: string }>;
  return foreignKeys.some(
    (foreignKey) =>
      foreignKey.table === "spec_delivery_plan_snapshots" &&
      foreignKey.from === "snapshot_id" &&
      foreignKey.to === "id",
  );
}

export function rebuildCandidateApprovalForeignKey(db: Db): number {
  db.exec(`
    ALTER TABLE spec_delivery_plan_candidate_approvals
      RENAME TO spec_delivery_plan_candidate_approvals_legacy_foreign_key;
  `);
  db.exec(SPEC_DELIVERY_PLAN_SCHEMA_DDL);
  const preserved = db
    .prepare(
      `INSERT INTO spec_delivery_plan_candidate_approvals (
         snapshot_id, candidate_id, candidate_hash, approved_at,
         approved_by_json
       )
       SELECT approval.snapshot_id, approval.candidate_id,
              approval.candidate_hash, approval.approved_at,
              approval.approved_by_json
         FROM spec_delivery_plan_candidate_approvals_legacy_foreign_key approval
         JOIN spec_delivery_plan_snapshots snapshot
           ON snapshot.id = approval.snapshot_id`,
    )
    .run();
  db.exec(
    "DROP TABLE spec_delivery_plan_candidate_approvals_legacy_foreign_key",
  );
  return preserved.changes;
}
