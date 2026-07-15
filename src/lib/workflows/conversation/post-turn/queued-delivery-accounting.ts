/**
 * Post-turn step: durable-queue delivery accounting for auto-drained turns.
 *
 * Hides the ownership handoff between the durable message queue and the JSONL
 * transcript: for a queued (auto-drained) turn the queue — not the transcript
 * — owns the user content until the backend confirms acceptance, so the
 * coalesced user entry is appended exactly once on `input_accepted` (append
 * BEFORE the queue mark, so a failed mark cannot cause a second append), the
 * claimed rows are marked delivered only after that append succeeds, and a
 * batch that never reached acceptance is returned to `pending` — never
 * guessed `failed` — so it is never silently lost. Normal turns append their
 * user entry at dispatch and never touch queue marks.
 */

import { createLogger } from "@/lib/logging";
import type { QueuedDeliveryMetadata } from "../types";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conversation-actor");

export interface QueuedDeliveryAccountingDeps {
  markQueuedDelivered(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<void>;
  markQueuedPending(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
}

export interface QueuedDeliveryAccounting {
  /** Append the user entry now for a NON-queued turn; no-op when queued. */
  appendUserEntryAtDispatch(): Promise<void>;
  /**
   * Backend accepted the input: append the coalesced user entry exactly once
   * and mark the claimed rows delivered. Safe against repeated events.
   */
  handleInputAccepted(): Promise<void>;
  /**
   * Turn `finally`: return a claimed batch that never reached acceptance to
   * `pending`. Mark failures are logged, never rethrown.
   */
  settleAfterTurn(): Promise<void>;
}

export function createQueuedDeliveryAccounting(
  deps: QueuedDeliveryAccountingDeps,
  input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    queuedDelivery: QueuedDeliveryMetadata | undefined;
    appendUserEntry(): Promise<void>;
  },
): QueuedDeliveryAccounting {
  // Guards the queued-delivery transcript append. Set true the instant the
  // coalesced user entry is appended on backend acceptance so a repeated
  // `input_accepted` cannot re-append, and so a later `markQueuedDelivered`
  // failure cannot trigger a second append. Read on all exit paths to decide
  // whether a queued batch must be returned to `pending` (no acceptance).
  let queuedUserEntryAppended = false;

  return {
    async appendUserEntryAtDispatch(): Promise<void> {
      if (input.queuedDelivery) return;
      await input.appendUserEntry();
    },

    async handleInputAccepted(): Promise<void> {
      if (!input.queuedDelivery || queuedUserEntryAppended) return;
      await input.appendUserEntry();
      // Mark appended before the queue write so a `markQueuedDelivered`
      // failure cannot cause the entry to be appended twice.
      queuedUserEntryAppended = true;
      await deps.markQueuedDelivered({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        ids: input.queuedDelivery.messageIds,
        deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      });
      logger.info("queue.accepted", {
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        messageIds: input.queuedDelivery.messageIds,
        deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      });
    },

    async settleAfterTurn(): Promise<void> {
      // Queued delivery that never reached backend acceptance (turn completed,
      // errored, or aborted before `input_accepted`): return the claimed batch
      // to `pending` so it is never silently lost (req 4.2). No transcript
      // entry was appended for it. All acceptance failures are treated as
      // recoverable — the turn result does not surface a terminal
      // queue-acceptance signal, so we never guess `failed` here.
      if (!input.queuedDelivery || queuedUserEntryAppended) return;
      try {
        await deps.markQueuedPending({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          ids: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error: "queued delivery did not reach backend acceptance",
        });
        logger.info("queue.return_pending", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
        });
      } catch (err) {
        logger.error("queue.return_pending_failed", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error: getErrorMessage(err),
        });
      }
    },
  };
}
