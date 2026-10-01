import type { StateMigration } from "./types";
import {
  SUBSCRIPTION_WAIT_GENERATIONS_SCHEMA_VERSION,
  KNOWN_SCHEMA_VERSION,
  migrateSubscriptionWaitGenerationsSchema,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";

export const subscriptionWaitGenerations: StateMigration = {
  name: "0065-subscription-wait-generations",
  async up({ context }) {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        SUBSCRIPTION_WAIT_GENERATIONS_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        const db = context.db;
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        migrateSubscriptionWaitGenerationsSchema(db);
        db.prepare(
          `UPDATE conversation_subscriptions SET mode='passive',expires_at=NULL
        WHERE mode='active' AND EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=conversation_subscriptions.id)
        AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits w WHERE w.subscription_id=conversation_subscriptions.id AND w.state IN ('waiting','ready'))`,
        ).run();
        db.prepare(
          `UPDATE conversation_subscription_deliveries SET state='superseded',accepted_at=NULL,last_error='Legacy cancelled wake was explicitly withdrawn'
        WHERE state IN ('pending','failed') AND EXISTS (SELECT 1 FROM conversation_subscription_waits w JOIN conversation_subscription_wake_batches b ON b.id=w.batch_id WHERE w.delivery_id=conversation_subscription_deliveries.id AND w.state IN ('settled','cancelled') AND b.state='cancelled')`,
        ).run();
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
        ).run(
          SUBSCRIPTION_WAIT_GENERATIONS_SCHEMA_VERSION,
          "preserve finite wait generations and continuing source follows",
        );
      })
      .immediate();
  },
};
