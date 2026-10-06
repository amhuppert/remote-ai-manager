import type { StateMigration } from "./types";
import {
  KNOWN_SCHEMA_VERSION,
  RUN_SUBSCRIPTION_SOURCE_SCHEMA_VERSION,
  migrateConversationNoticeSourceSchema,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";

/**
 * Admits run boundaries as a subscription source and adds the waking follow.
 * A breaking change: an older build cannot parse a `run` subscription, and its
 * recipients' inbox reads would fail as a whole.
 */
export const runSubscriptionSource: StateMigration = {
  name: "0068-run-subscription-source",
  async up({ context }) {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        RUN_SUBSCRIPTION_SOURCE_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        const db = context.db;
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        migrateConversationNoticeSourceSchema(db);
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
        ).run(
          RUN_SUBSCRIPTION_SOURCE_SCHEMA_VERSION,
          "run boundaries as a subscription source and waking follows",
        );
      })
      .immediate();
  },
};
