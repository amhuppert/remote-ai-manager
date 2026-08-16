import { createLogger } from "@/lib/logging";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");
const MIGRATION_NAME = "0026-delivery-plan-launch-cutover";

function addMissingLaunch(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.hasOwn(parsed, "launch")
  ) {
    return null;
  }
  return stableStringify({ ...parsed, launch: null });
}

/**
 * Adds the explicit un-authored launch state to pre-cutover plan documents.
 * Proposals that predate an immutable launch have no approved envelope to
 * preserve, so they return to draft and must be authored and proposed again.
 */
export const deliveryPlanLaunchCutover: StateMigration = {
  name: MIGRATION_NAME,
  async up({ context }) {
    const { db } = context;
    const attemptTable = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'`,
      )
      .get();
    if (attemptTable === undefined) return;

    const attempts = db
      .prepare(
        `SELECT id, content_json
           FROM spec_delivery_plan_attempts
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: string; content_json: string }>;
    const snapshots = db
      .prepare(
        `SELECT id, attempt_id, content_json
           FROM spec_delivery_plan_snapshots
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: string; attempt_id: string; content_json: string }>;
    const updateAttempt = db.prepare(
      `UPDATE spec_delivery_plan_attempts
          SET content_json = ?, updated_at = datetime('now')
        WHERE id = ? AND content_json = ?`,
    );
    const updateSnapshot = db.prepare(
      `UPDATE spec_delivery_plan_snapshots
          SET content_json = ?
        WHERE id = ? AND content_json = ?`,
    );
    const resetAttempt = db.prepare(
      `UPDATE spec_delivery_plan_attempts
          SET status = 'draft',
              proposed_snapshot_id = NULL,
              approval_json = NULL,
              prelaunch_json = NULL,
              updated_at = datetime('now')
        WHERE id = ? AND status IN ('proposed', 'approved', 'parked')`,
    );
    // The compiled-candidate table is gone once the version-2 cutover has
    // run, and a fresh database never creates it. This migration still has to
    // replay cleanly on both, so it prepares the delete only when the table is
    // actually there.
    const candidateTable = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'spec_delivery_plan_candidates'`,
      )
      .get();
    const deleteCandidates =
      candidateTable === undefined
        ? null
        : db.prepare(
            "DELETE FROM spec_delivery_plan_candidates WHERE attempt_id = ?",
          );

    let documentsUpdated = 0;
    let snapshotsUpdated = 0;
    let proposalsReset = 0;
    db.transaction(() => {
      const affectedAttempts = new Set<string>();
      for (const attempt of attempts) {
        const next = addMissingLaunch(attempt.content_json);
        if (next === null) continue;
        if (
          updateAttempt.run(next, attempt.id, attempt.content_json).changes !==
          1
        ) {
          throw new Error(
            `Delivery-plan launch cutover lost attempt ${attempt.id} to a concurrent write`,
          );
        }
        affectedAttempts.add(attempt.id);
        documentsUpdated += 1;
      }
      for (const snapshot of snapshots) {
        const next = addMissingLaunch(snapshot.content_json);
        if (next === null) continue;
        if (
          updateSnapshot.run(next, snapshot.id, snapshot.content_json)
            .changes !== 1
        ) {
          throw new Error(
            `Delivery-plan launch cutover lost snapshot ${snapshot.id} to a concurrent write`,
          );
        }
        affectedAttempts.add(snapshot.attempt_id);
        snapshotsUpdated += 1;
      }
      for (const attemptId of affectedAttempts) {
        deleteCandidates?.run(attemptId);
        proposalsReset += resetAttempt.run(attemptId).changes;
      }
    }).immediate();

    logger.info("state-store.delivery_plan_launch_cutover", {
      documentsUpdated,
      snapshotsUpdated,
      proposalsReset,
    });
  },
};
