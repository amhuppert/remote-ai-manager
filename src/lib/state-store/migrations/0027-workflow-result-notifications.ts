import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import {
  KNOWN_SCHEMA_VERSION,
  migrateNotificationsTableForWorkflowResults,
} from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 8;
const MIGRATION_SCHEMA_DESCRIPTION =
  "notifications admit session-scoped graph-workflow results";

/**
 * Admit durable workflow-result notifications after publishing the forward-only
 * fence. Notification list reads decode every row, so the new source is a
 * whole-result-set compatibility break rather than an additive opaque column.
 */
export const workflowResultNotifications: StateMigration = {
  name: "0027-workflow-result-notifications",
  up: async ({ context }) => {
    const { db } = context;
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      migrateNotificationsTableForWorkflowResults(db);
      db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      ).run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
    }).immediate();
  },
};
