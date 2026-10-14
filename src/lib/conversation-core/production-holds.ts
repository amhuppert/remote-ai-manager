import {
  createConversationsRepo,
  type ConversationsRepo,
} from "@/lib/state-store/conversations-repo";
import {
  createProjectConversationsRepo,
  type ProjectConversationsRepo,
} from "@/lib/state-store/project-conversations-repo";
import { getStateDb } from "@/lib/state-store/store";
import { conversationHoldRefusal } from "./conversation-record";
import type { HoldSource } from "./executor";

type Db = ReturnType<typeof getStateDb>;

let cachedRows:
  | { db: Db; session: ConversationsRepo; project: ProjectConversationsRepo }
  | undefined;
/** One prepared pair of repositories per database handle, so a reopened database is never read through a closed one. */
function conversationRows(db: Db): {
  session: ConversationsRepo;
  project: ProjectConversationsRepo;
} {
  if (cachedRows?.db !== db) {
    cachedRows = {
      db,
      session: createConversationsRepo(db),
      project: createProjectConversationsRepo(db),
    };
  }
  return cachedRows;
}

/**
 * What a conversation's row holds (conversationHoldRefusal), for session and
 * project conversations alike: a collaboration's claim on its turns, queued
 * deliveries awaiting review, and debug mode.
 */
export function createProductionConversationHold(
  db: () => Db = getStateDb,
): HoldSource {
  return {
    async refusal(conversationId, turn) {
      const rows = conversationRows(db());
      const row =
        rows.session.findById(conversationId) ??
        rows.project.findById(conversationId);
      return row === null ? null : conversationHoldRefusal(row, turn);
    },
  };
}
