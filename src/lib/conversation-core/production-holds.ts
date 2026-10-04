import { createConversationsRepo, type ConversationsRepo } from "@/lib/state-store/conversations-repo";
import { getStateDb } from "@/lib/state-store/store";
import { conversationHoldRefusal } from "./conversation-record";
import type { HoldSource } from "./executor";

type Db = ReturnType<typeof getStateDb>;

let cachedRows: { db: Db; repo: ConversationsRepo } | undefined;
/** One prepared repository per database handle, so a reopened database is never read through a closed one. */
function conversationRows(db: Db): ConversationsRepo {
  if (cachedRows?.db !== db) cachedRows = { db, repo: createConversationsRepo(db) };
  return cachedRows.repo;
}

/**
 * What a session conversation's row holds (conversationHoldRefusal): a
 * collaboration's claim on its turns, and a new claim while the row forbids
 * one. Collaboration runs in session conversations only.
 */
export function createProductionConversationHold(db: () => Db = getStateDb): HoldSource {
  return {
    async refusal(conversationId, turn) {
      const row = conversationRows(db()).findById(conversationId);
      return row === null ? null : conversationHoldRefusal(row, turn);
    },
  };
}
