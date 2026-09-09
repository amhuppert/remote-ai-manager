/**
 * Repair of a queued delivery's missing receipt from a durable checkpoint
 * acceptance, applied wherever a host learns of the conversation's queue:
 * when a host wakes, at startup restore, and when a turn is refused for
 * queue review.
 *
 * A delivery turn records the checkpoint's acceptance before it marks the
 * queued rows delivered; a crash between the two leaves rows the queue holds
 * for review although the input provably ran. `repairableQueuedAcceptance`
 * decides from durable facts alone whether the accepted checkpoint's binding
 * names those very rows and their bound input; only then are they confirmed
 * — never re-sent — and the user entry the crash may also have skipped is
 * appended once under the same stable id the delivery turn would have used.
 *
 * Private to the conversation lifecycle: the manager and startup rehydration
 * are its only callers.
 */

import { checkpointErrorFields } from "@/lib/conversation-checkpoints/diagnostics";
import type { ConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import { fingerprintSubmittedInput } from "@/lib/conversation-checkpoints/input-fingerprint";
import { repairableQueuedAcceptance } from "@/lib/conversation-checkpoints/queued-acceptance";
import type { CheckpointScopeKey } from "@/lib/conversation-checkpoints/schemas";
import { queuedBatchToSubmitPrompt } from "@/lib/conversations/message-queue-drain";
import { coalesceContent } from "@/lib/conversations/message-queue-service";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import type { Logger } from "@/lib/logging";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

import { checkpointScopeKeyForStoreIdentity } from "./actor-input-loader";

export interface CheckpointQueueRepairInfrastructure {
  repo: Pick<
    ConversationCheckpointsRepo,
    "getStateForAdmission" | "getOperation"
  >;
  readQueue(identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<readonly PendingQueuedMessage[] | null>;
  confirmDelivery(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<number>;
  /** Append the user entry the delivery turn owed, at most once per id. */
  appendUserEntryOnce(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
  now(): string;
  log: Logger;
}

/** The submitted-input fingerprint the drain's assembly of these rows binds a delivery to. */
export function fingerprintQueuedRows(
  rows: readonly PendingQueuedMessage[],
): string {
  const assembled = queuedBatchToSubmitPrompt(coalesceContent(rows));
  return fingerprintSubmittedInput({
    promptText: assembled.promptText,
    images: assembled.images,
    documentFeedback: assembled.documentFeedback,
    notepadFeedback: assembled.notepadFeedback,
  });
}

/**
 * Confirm the queued rows a durable checkpoint acceptance proves delivered.
 * Returns the number of rows released; zero when nothing matched.
 */
export async function repairQueuedAcceptanceFromCheckpoint(
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  infra: CheckpointQueueRepairInfrastructure,
): Promise<number> {
  const key: CheckpointScopeKey = checkpointScopeKeyForStoreIdentity(identity);
  const queue = await infra.readQueue(identity);
  if (queue === null) return 0;
  if (
    !queue.some(
      (row) => row.status === "delivering" || row.status === "uncertain",
    )
  )
    return 0;
  const state = await infra.repo.getStateForAdmission(key);
  if (state.latestAccepted === null) return 0;
  const operation = await infra.repo.getOperation(
    key,
    state.latestAccepted.operationId,
  );
  if (operation === null) return 0;
  const repair = repairableQueuedAcceptance({
    operation,
    queue,
    fingerprintRows: fingerprintQueuedRows,
  });
  const fields = {
    ...scopeRefFromStoreSessionName(identity.sessionName),
    conversationId: identity.conversationId,
    operationId: operation.id,
    attemptId: operation.acceptance?.attemptId ?? null,
    queuedAttemptId: operation.delivery?.queuedAttemptId ?? null,
  };
  if (repair === null) {
    infra.log.info("checkpoint.queue_repair.no_match", fields);
    return 0;
  }
  // The transcript entry precedes the release, as it does on the live path:
  // a row is released only once the archive holds what the agent received.
  const first = repair.rows[0];
  if (first !== undefined) {
    try {
      await infra.appendUserEntryOnce(identity.conversationId, {
        id: first.id,
        timestamp: infra.now(),
        type: "user",
        role: "user",
        content: coalesceContent(repair.rows),
        ...(first.modelSelection !== undefined
          ? { modelSelection: first.modelSelection }
          : {}),
      });
    } catch (error) {
      infra.log.error("checkpoint.queue_repair.append_failed", {
        ...fields,
        ...checkpointErrorFields(error),
      });
      throw error;
    }
  }
  const released = await infra.confirmDelivery({
    ...identity,
    ids: repair.messageIds,
    deliveryAttemptId: repair.deliveryAttemptId,
  });
  infra.log.info("checkpoint.queue_repair.confirmed", {
    ...fields,
    messageIds: repair.messageIds,
    released,
  });
  return released;
}
