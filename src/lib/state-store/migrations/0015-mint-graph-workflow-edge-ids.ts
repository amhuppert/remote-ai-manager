import { createLogger } from "@/lib/logging";
import { normalizeRawDefinitionEdgeIds } from "@/lib/workflow-graph/edge-identity";
import type { StateMigration } from "./types";

const logger = createLogger(
  "state-store/migrations/0015-mint-graph-workflow-edge-ids",
);

/**
 * The additive D4 migration (decision D12): put the minted edge ids in the
 * column.
 *
 * D4 made `edges[].id` required and unique (decision D2). Every OTHER D4 field
 * is Zod-optional with a floor default, so absence already reads as the dormant
 * floor and needs no data change — this one field is the exception, because a
 * pre-D4 row simply does not carry it.
 *
 * The read path repairs it on inflate, but a repair that is only ever
 * re-derived is not the same as a migration:
 *   - an ACTIVE row keeps the repair in memory until some later ordinary write
 *     happens to persist it, so until then the stored bytes disagree with every
 *     id-addressed reference taken from them;
 *   - an ARCHIVED row is never rewritten by any path at all, so the repair is
 *     re-derived on every single read, forever.
 * Running the same deterministic minting over the stored bytes once removes
 * both gaps, and leaves the read-time repair as the backstop it should be.
 *
 * Idempotent by construction: `normalizeRawDefinitionEdgeIds` is deterministic
 * and first-claim-wins, so a replay re-derives the identical ids, and a row that
 * already carries them is rewritten only if its JSON text actually changed.
 */
export const mintGraphWorkflowEdgeIds: StateMigration = {
  name: "0015-mint-graph-workflow-edge-ids",
  up: async ({ context }) => {
    const { db } = context;

    /**
     * Repair one stored blob, returning the new JSON text or null when nothing
     * changed. Comparing the serialized text (rather than tracking whether an
     * id was minted) is what keeps an already-current row byte-identical: a
     * migration that rewrote every row would churn the whole table on an
     * up-to-date database.
     */
    function repaired(json: string): string | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        // A row this migration cannot parse is a row it cannot repair. Throwing
        // would block every later migration and the server start over one bad
        // blob; the read path already refuses it with a typed validation error.
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) return null;

      // Both tiers nest the definition: the active tier's `definition_json`
      // holds the execution's definition half, and the archive's
      // `execution_json` holds the whole execution.
      normalizeRawDefinitionEdgeIds(
        (parsed as { workingDefinition?: unknown }).workingDefinition,
      );

      const next = JSON.stringify(parsed);
      return next === json ? null : next;
    }

    const migrate = db.transaction(() => {
      let activeRepaired = 0;
      let archivedRepaired = 0;

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
        const next = repaired(row.definition_json);
        if (next === null) continue;
        updateActive.run(next, row.project_path, row.session_name);
        activeRepaired += 1;
      }

      // The archive tier is the load-bearing half: nothing else ever rewrites
      // these rows.
      //
      // Addressed by the COMPLETE primary key. An execution id is unique only
      // within a session, so sibling sessions and projects can archive rows
      // sharing one — and an UPDATE matching on the id alone would overwrite
      // every sibling with whichever row was repaired last, destroying history
      // no other path can rebuild.
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
        const next = repaired(row.execution_json);
        if (next === null) continue;
        updateArchived.run(
          next,
          row.project_path,
          row.session_name,
          row.execution_id,
        );
        archivedRepaired += 1;
      }

      logger.info("state-store.migrations.mint_graph_workflow_edge_ids", {
        activeRepaired,
        archivedRepaired,
        activeScanned: activeRows.length,
        archivedScanned: archivedRows.length,
      });
    });

    migrate.immediate();
  },
};
