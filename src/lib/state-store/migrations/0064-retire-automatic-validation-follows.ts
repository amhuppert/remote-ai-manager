import type { StateMigration } from "./types";

export const retireAutomaticValidationFollows: StateMigration = {
  name: "0064-retire-automatic-validation-follows",
  up: async ({ context }) => {
    const at = new Date().toISOString();
    context.db
      .transaction(() => {
        context.db
          .prepare(
            `UPDATE conversation_subscriptions
        SET status='unfollowed',unfollowed_at=@at,updated_at=@at
        WHERE source_kind='validation' AND reason='Validation submitted by this conversation'
          AND mode='passive' AND status='following'
          AND NOT EXISTS (SELECT 1 FROM conversation_subscription_waits AS wait
            WHERE wait.subscription_id=conversation_subscriptions.id)`,
          )
          .run({ at });
      })
      .immediate();
  },
};
