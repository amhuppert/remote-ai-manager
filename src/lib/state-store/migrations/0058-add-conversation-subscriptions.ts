import { CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

// Additive tables are shared with the synchronous floor and fence no old readers.
export const addConversationSubscriptions: StateMigration = {
  name: "0058-add-conversation-subscriptions",
  up: async ({ context }) => {
    context.db.exec(CONVERSATION_SUBSCRIPTIONS_SCHEMA_DDL);
  },
};
