import { createLogger } from "@/lib/logging";
import { migrateRawExecutionPlacement } from "@/lib/workflow-graph/placement-migration";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const logger = createLogger(
  "state-store/migrations/0016-graph-workflow-context-placement",
);

const MIGRATION_SCHEMA_VERSION = 5;
const MIGRATION_SCHEMA_DESCRIPTION =
  "graph-workflow execution contexts carry authored lane placement";

/**
 * BREAKING migration (D5 decision D13): put the migrated lane placement in the
 * stored bytes, and fence out every build that predates it.
 *
 * The read path already repairs a placement-less execution on inflate, but the
 * fence is what makes the repair safe rather than merely convenient. An older
 * build shares `command-center.db`, does not know the field, and would write it
 * straight back out — stripping placement from an execution whose contexts an
 * author had deliberately GROUPED onto one lane. The next read by this build
 * would then re-migrate that group into one lane per context, silently
 * dissolving the grouping and the ownership scoping that rides on it. That is
 * unrecoverable from the row alone, so the version gate refuses the older
 * reader outright; the documented rollout requirement to quiesce older open
 * workers applies.
 *
 * Backfilling is the same reasoning `0015` records for edge ids: an ACTIVE row
 * keeps the repair in memory until some later ordinary write happens to persist
 * it, and an ARCHIVED row is never rewritten by any path at all, so its repair
 * would be re-derived on every read forever. The same call the read boundary
 * makes runs once over the stored bytes here, and also drops the deleted
 * `lanePlan` field (R2.1) that no live writer would otherwise remove.
 *
 * Idempotent by construction: `migrateRawExecutionPlacement` leaves an authored
 * placement exactly as found, so a replay re-derives identical bytes, and a row
 * that already carries placement is rewritten only if its JSON text changed.
 */
export const graphWorkflowContextPlacement: StateMigration = {
  name: "0016-graph-workflow-context-placement",
  up: async ({ context }) => {
    const { db } = context;

    // Fail-closed external barrier before SQLite can expose placement-bearing
    // bytes: an older build reopening mid-cutover is refused by the
    // config-directory marker before the in-database stamp is visible to it.
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }

    /**
     * Migrate one stored blob, returning the new JSON text or null when nothing
     * changed. Comparing the serialized text keeps an already-current row
     * byte-identical, so an up-to-date database is not churned wholesale.
     */
    function migrated(json: string): string | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        // A row this migration cannot parse is a row it cannot repair.
        // Throwing would block every later migration and the server start over
        // one bad blob; the read path already refuses it with a typed error.
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;

      migrateRawExecutionPlacement(parsed);

      const next = JSON.stringify(parsed);
      return next === json ? null : next;
    }

    const migrate = db.transaction(() => {
      // Recheck under the write lock, witnessing the BUILD's known version
      // (0006 precedent) so a same-build replay after any future cutover still
      // converges while a genuinely newer build's advance refuses.
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);

      let activeMigrated = 0;
      let archivedMigrated = 0;

      // The active tier splits the execution across two columns, and the
      // working definition lives in `definition_json` — the same half `0015`
      // repairs — so the whole-execution transformer is handed that half.
      const activeRows = db
        .prepare(
          `SELECT project_path, session_name, definition_json
             FROM graph_workflow_executions`,
        )
        .all() as Array<{
        project_path: string;
        session_name: string;
        definition_json: string;
      }>;
      const updateActive = db.prepare(
        `UPDATE graph_workflow_executions
            SET definition_json = ?
          WHERE project_path = ? AND session_name = ?`,
      );
      for (const row of activeRows) {
        const next = migrated(row.definition_json);
        if (next === null) continue;
        updateActive.run(next, row.project_path, row.session_name);
        activeMigrated += 1;
      }

      // The archive tier is the load-bearing half: nothing else ever rewrites
      // these rows. Addressed by the COMPLETE primary key — an execution id is
      // unique only within a session, so matching on it alone would overwrite
      // every sibling with whichever row was migrated last.
      const archivedRows = db
        .prepare(
          `SELECT project_path, session_name, execution_id, execution_json
             FROM graph_workflow_archived_executions`,
        )
        .all() as Array<{
        project_path: string;
        session_name: string;
        execution_id: string;
        execution_json: string;
      }>;
      const updateArchived = db.prepare(
        `UPDATE graph_workflow_archived_executions
            SET execution_json = ?
          WHERE project_path = ? AND session_name = ? AND execution_id = ?`,
      );
      for (const row of archivedRows) {
        const next = migrated(row.execution_json);
        if (next === null) continue;
        updateArchived.run(
          next,
          row.project_path,
          row.session_name,
          row.execution_id,
        );
        archivedMigrated += 1;
      }

      db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      ).run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);

      logger.info("state-store.migrations.graph_workflow_context_placement", {
        activeMigrated,
        archivedMigrated,
        activeScanned: activeRows.length,
        archivedScanned: archivedRows.length,
      });
    });

    migrate.immediate();
  },
};
