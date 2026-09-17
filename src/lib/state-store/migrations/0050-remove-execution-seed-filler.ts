import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 18;

export const removeExecutionSeedFiller: StateMigration = {
  name: "0050-remove-execution-seed-filler",
  up: async ({ context: { db, configDir } }) => {
    if (configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      for (const [table, column] of [
        ["graph_workflow_executions", "definition_json"],
        ["graph_workflow_archived_executions", "execution_json"],
      ]) {
        const exists = db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table);
        if (!exists) continue;
        const projections =
          table === "graph_workflow_executions"
            ? "seed_definition_id = NULL, seed_definition_revision = NULL,"
            : "";
        db.exec(`UPDATE ${table} SET ${projections}
          ${column} = json_set(${column}, '$.seedDefinitionId', NULL, '$.seedDefinitionRevision', NULL)
          WHERE json_extract(${column}, '$.origin.kind') = 'one_off'
             OR (json_extract(${column}, '$.origin.kind') = 'spec_delivery'
                 AND json_extract(${column}, '$.seedDefinitionId') LIKE 'spec-delivery:%')`);
      }
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      ).run(
        MIGRATION_SCHEMA_VERSION,
        "Remove invented saved-definition identities from graph executions",
      );
    }).immediate();
  },
};
