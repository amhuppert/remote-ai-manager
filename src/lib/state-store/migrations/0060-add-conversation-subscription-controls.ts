import {
  CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_DDL,
  KNOWN_SCHEMA_VERSION,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import type { StateMigration } from "./types";
export const CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_VERSION = 25;
/** Older builds cannot honor pause and may deliver suspended subscriptions. */
export const addConversationSubscriptionControls: StateMigration = {
  name: "0060-add-conversation-subscription-controls",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        enforceCurrentSchemaCompatibility(
          context.db,
          context.db.name,
          KNOWN_SCHEMA_VERSION,
        );
        const columns = context.db
          .prepare("PRAGMA table_info(conversation_subscriptions)")
          .all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "paused_at"))
          context.db.exec(
            "ALTER TABLE conversation_subscriptions ADD COLUMN paused_at TEXT",
          );
        context.db.exec(CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_DDL);
        context.db
          .prepare(
            "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
          )
          .run(
            CONVERSATION_SUBSCRIPTION_CONTROLS_SCHEMA_VERSION,
            "subscription pause, human read state and recipient hint preference",
          );
      })
      .immediate();
  },
};
