import { z } from "zod";
import type { Db } from "./schemas";
import type { WriteQueue } from "./write-queue";
import {
  recipientSubscriptionPreferencesSchema,
  subscriptionRecipientSchema,
  type RecipientSubscriptionPreferences,
  type SubscriptionRecipient,
} from "@/lib/subscriptions/schemas";
export { subscriptionDeliveryReadStateSchema } from "@/lib/subscriptions/schemas";
export const subscriptionPreferencesSchema =
  recipientSubscriptionPreferencesSchema;
export type SubscriptionPreferences = RecipientSubscriptionPreferences;
export interface ConversationSubscriptionPreferencesRepo {
  getPreferences(
    recipient: SubscriptionRecipient,
  ): Promise<SubscriptionPreferences>;
  setHintsEnabled(
    recipient: SubscriptionRecipient,
    enabled: boolean,
  ): Promise<SubscriptionPreferences>;
  markDeliveryRead(
    recipient: SubscriptionRecipient,
    id: string,
    read: boolean,
    at: string,
  ): Promise<boolean>;
  getReadAt(
    recipient: SubscriptionRecipient,
    id: string,
  ): Promise<string | null>;
  listReadAt(recipient: SubscriptionRecipient): Promise<Map<string, string>>;
}
export function createConversationSubscriptionPreferencesRepo(
  db: Db,
  writeQueue: WriteQueue,
): ConversationSubscriptionPreferencesRepo {
  const scope = (recipient: SubscriptionRecipient) => {
    const value = subscriptionRecipientSchema.parse(recipient);
    return {
      project_path: value.projectPath,
      conversation_id: value.conversationId,
    };
  };
  return {
    async getPreferences(recipient) {
      const raw: unknown = db
        .prepare(
          "SELECT hints_enabled FROM conversation_subscription_preferences WHERE project_path=@project_path AND conversation_id=@conversation_id",
        )
        .get(scope(recipient));
      return {
        hintsEnabled:
          raw === undefined
            ? true
            : z.object({ hints_enabled: z.number() }).parse(raw)
                .hints_enabled === 1,
      };
    },
    async setHintsEnabled(recipient, enabled) {
      await writeQueue.withWriteQueueSync("subscriptions.preferences", () =>
        db
          .prepare(
            "INSERT INTO conversation_subscription_preferences(project_path,conversation_id,hints_enabled) VALUES (@project_path,@conversation_id,@enabled) ON CONFLICT(project_path,conversation_id) DO UPDATE SET hints_enabled=excluded.hints_enabled",
          )
          .run({ ...scope(recipient), enabled: enabled ? 1 : 0 }),
      );
      return { hintsEnabled: enabled };
    },
    async markDeliveryRead(recipient, id, read, at) {
      return writeQueue.withWriteQueueSync("subscriptions.read-state", () => {
        const params = { ...scope(recipient), id };
        if (
          db
            .prepare(
              "SELECT 1 FROM conversation_subscription_deliveries WHERE project_path=@project_path AND conversation_id=@conversation_id AND id=@id",
            )
            .get(params) === undefined
        )
          return false;
        if (read)
          db.prepare(
            "INSERT INTO conversation_subscription_read_state(project_path,conversation_id,delivery_id,read_at) VALUES (@project_path,@conversation_id,@id,@at) ON CONFLICT(project_path,conversation_id,delivery_id) DO NOTHING",
          ).run({ ...params, at });
        else
          db.prepare(
            "DELETE FROM conversation_subscription_read_state WHERE project_path=@project_path AND conversation_id=@conversation_id AND delivery_id=@id",
          ).run(params);
        return true;
      });
    },
    async getReadAt(recipient, id) {
      const raw: unknown = db
        .prepare(
          "SELECT read_at FROM conversation_subscription_read_state WHERE project_path=@project_path AND conversation_id=@conversation_id AND delivery_id=@id",
        )
        .get({ ...scope(recipient), id });
      return raw === undefined
        ? null
        : z.object({ read_at: z.string() }).parse(raw).read_at;
    },
    async listReadAt(recipient) {
      const rows: unknown[] = db
        .prepare(
          "SELECT delivery_id,read_at FROM conversation_subscription_read_state WHERE project_path=@project_path AND conversation_id=@conversation_id",
        )
        .all(scope(recipient));
      return new Map(
        rows.map((raw) => {
          const row = z
            .object({ delivery_id: z.string(), read_at: z.string() })
            .parse(raw);
          return [row.delivery_id, row.read_at];
        }),
      );
    },
  };
}
