import {
  CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL,
  KNOWN_SCHEMA_VERSION,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import type { StateMigration } from "./types";

export const CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION = 24;

/** New queued wake metadata cannot be decoded by older conversation readers. */
export const addConversationSubscriptionWaits: StateMigration = {
  name: "0059-add-conversation-subscription-waits",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        enforceCurrentSchemaCompatibility(
          context.db,
          context.db.name,
          KNOWN_SCHEMA_VERSION,
        );
        context.db.exec(CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_DDL);
        context.db
          .prepare(
            "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
          )
          .run(
            CONVERSATION_SUBSCRIPTION_WAITS_SCHEMA_VERSION,
            "one-time subscription waits persist typed wake queue metadata",
          );
      })
      .immediate();
  },
};
