import { createLogger } from "@/lib/logging";
import { deliveryPlanDocumentSchema } from "@/lib/specs/delivery-plan";
import { graphWorkflowExecutionOriginSchema } from "@/lib/workflow-graph/schemas";
import { stableStringify } from "../serialization";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

function directPlanDocument(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const source: Record<string, unknown> =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const normalized = deliveryPlanDocumentSchema.safeParse({
      launch: Object.hasOwn(source, "launch") ? source.launch : null,
      binding: Object.hasOwn(source, "binding")
        ? source.binding
        : { dispositions: [], claims: [] },
    });
    return stableStringify(
      normalized.success
        ? normalized.data
        : { launch: null, binding: { dispositions: [], claims: [] } },
    );
  } catch {
    return stableStringify({
      launch: null,
      binding: { dispositions: [], claims: [] },
    });
  }
}

function activeLegacyExecutionIds(
  db: Parameters<StateMigration["up"]>[0]["context"]["db"],
): string[] {
  const rows = db
    .prepare(
      `SELECT id, workflow_seed_source_json
       FROM spec_executions
      WHERE state NOT IN ('abandoned', 'delivered')`,
    )
    .all() as Array<{ id: string; workflow_seed_source_json: string | null }>;
  return rows.flatMap((row) => {
    if (row.workflow_seed_source_json === null) return [row.id];
    let candidate: unknown;
    try {
      candidate = JSON.parse(row.workflow_seed_source_json);
    } catch {
      return [row.id];
    }
    const parsed = graphWorkflowExecutionOriginSchema.safeParse(candidate);
    return parsed.success && parsed.data.kind === "spec_delivery"
      ? []
      : [row.id];
  });
}

export const retireLegacySpecExecutions: StateMigration = {
  name: "0028-retire-legacy-spec-executions",
  async up({ context }) {
    const { db } = context;
    const executionTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_executions'",
      )
      .get();
    if (executionTable !== undefined) {
      const activeLegacyExecutionIdsForCutover = activeLegacyExecutionIds(db);
      if (activeLegacyExecutionIdsForCutover.length > 0) {
        logger.warn("state-store.legacy_native_sdd_cutover_refused", {
          activeExecutionCount: activeLegacyExecutionIdsForCutover.length,
          activeExecutionIds: activeLegacyExecutionIdsForCutover,
        });
        throw new Error(
          `Cannot retire native-SDD runtime while active legacy-linked native-SDD execution(s) exist: ${activeLegacyExecutionIdsForCutover.join(", ")}`,
        );
      }
    }
    const attemptTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_attempts'",
      )
      .get();
    let rewrittenAttempts = 0;
    let rewrittenSnapshots = 0;
    if (attemptTable !== undefined) {
      const attempts = db
        .prepare("SELECT id, content_json FROM spec_delivery_plan_attempts")
        .all() as Array<{ id: string; content_json: string }>;
      const snapshots = db
        .prepare(
          "SELECT id, attempt_id, content_json FROM spec_delivery_plan_snapshots",
        )
        .all() as Array<{
        id: string;
        attempt_id: string;
        content_json: string;
      }>;
      const updateAttempt = db.prepare(
        "UPDATE spec_delivery_plan_attempts SET content_json = ?, updated_at = datetime('now') WHERE id = ? AND content_json = ?",
      );
      const updateSnapshot = db.prepare(
        "UPDATE spec_delivery_plan_snapshots SET content_json = ? WHERE id = ? AND content_json = ?",
      );
      const resetAttempt = db.prepare(
        "UPDATE spec_delivery_plan_attempts SET status = 'draft', proposed_snapshot_id = NULL, approval_json = NULL, prelaunch_json = NULL, updated_at = datetime('now') WHERE id = ? AND status IN ('proposed', 'approved', 'parked')",
      );
      // The compiled-candidate table is gone after the version-2 cutover and
      // never exists on a fresh install, so this replays against both shapes.
      const candidateTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spec_delivery_plan_candidates'",
        )
        .get();
      const deleteCandidates =
        candidateTable === undefined
          ? null
          : db.prepare(
              "DELETE FROM spec_delivery_plan_candidates WHERE attempt_id = ?",
            );
      db.transaction(() => {
        const changedAttempts = new Set<string>();
        for (const attempt of attempts) {
          const next = directPlanDocument(attempt.content_json);
          if (next === attempt.content_json) continue;
          if (
            updateAttempt.run(next, attempt.id, attempt.content_json)
              .changes !== 1
          )
            throw new Error(`delivery-plan cutover lost attempt ${attempt.id}`);
          changedAttempts.add(attempt.id);
          rewrittenAttempts += 1;
        }
        for (const snapshot of snapshots) {
          const next = directPlanDocument(snapshot.content_json);
          if (next === snapshot.content_json) continue;
          if (
            updateSnapshot.run(next, snapshot.id, snapshot.content_json)
              .changes !== 1
          )
            throw new Error(
              `delivery-plan cutover lost snapshot ${snapshot.id}`,
            );
          changedAttempts.add(snapshot.attempt_id);
          rewrittenSnapshots += 1;
        }
        for (const attemptId of changedAttempts) {
          deleteCandidates?.run(attemptId);
          resetAttempt.run(attemptId);
        }
      }).immediate();
    }
    logger.info("state-store.legacy_native_sdd_retired", {
      rewrittenAttempts,
      rewrittenSnapshots,
    });
  },
};
