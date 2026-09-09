/**
 * Composition root for the checkpoint repository.
 *
 * A singleton for the same reason the state store is one: the repository's
 * readiness write reaches the conversation repositories' parsed-row caches, and
 * a second instance over the same connection would clear a provider reference
 * that every cached list read keeps serving. Callers take the repository from
 * here rather than building their own.
 *
 * SSE publication is composed here rather than at the lifecycle call sites, so
 * every production writer — the manager, maintenance, restart and pre-turn
 * delivery — emits its phase change after the write commits without knowing the
 * wire exists.
 */

import { getProjectDisplayName } from "@/lib/projects/resolver";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";
import { getStateDb, getStateStore } from "@/lib/state-store";
import {
  _resetForTesting,
  tryWithWriteQueue,
  withWriteQueue,
  withWriteQueueSync,
} from "@/lib/state-store/write-queue";

import { withCheckpointPublication } from "./publication";
import {
  createConversationCheckpointsRepo,
  type ConversationCheckpointsRepo,
} from "./repo";

export function getConversationCheckpointsRepo(): ConversationCheckpointsRepo {
  return getGlobalSingleton("__cc_conversation_checkpoints_repo", () =>
    withCheckpointPublication(
      createConversationCheckpointsRepo(
        getStateDb(),
        {
          withWriteQueue,
          withWriteQueueSync,
          tryWithWriteQueue,
          _resetForTesting,
        },
        getStateStore().checkpointContinuation,
      ),
      { projectName: getProjectDisplayName },
    ),
  );
}
