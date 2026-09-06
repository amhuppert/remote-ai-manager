/**
 * Post-turn step: durable-queue delivery accounting for auto-drained turns.
 *
 * Hides the ownership handoff between the durable message queue and the JSONL
 * transcript: for a queued (auto-drained) turn the queue — not the transcript
 * — owns the user content until the backend confirms acceptance, so the
 * coalesced user entry is appended exactly once on `input_accepted` (append
 * BEFORE the queue mark), and the claimed rows leave the queue only after
 * both durable writes succeed. Any incomplete handoff is retained for review:
 * a missing acknowledgement does not prove the request never ran.
 * Normal turns append their user entry at dispatch and never touch queue marks.
 */

import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import type { QueuedDeliveryMetadata } from "../types";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("conversation-actor");

export interface QueuedDeliveryAccountingDeps {
  markQueuedUncertain(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
  markQueuedDelivered(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
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
   * Turn `finally`: retain any incomplete delivery for review. Mark failures
   * are logged; the original claim remains recoverable after restart.
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
  // A successful transcript append and a successful queue acknowledgement are
  // separate facts. Retain ownership until both have completed.
  let queuedUserEntryAppended = false;
  let deliveryRecorded = false;

  return {
    async appendUserEntryAtDispatch(): Promise<void> {
      if (input.queuedDelivery) return;
      await input.appendUserEntry();
    },

    async handleInputAccepted(): Promise<void> {
      if (!input.queuedDelivery || deliveryRecorded) return;
      if (!queuedUserEntryAppended) {
        await input.appendUserEntry();
        queuedUserEntryAppended = true;
      }
      await deps.markQueuedDelivered({
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        ids: input.queuedDelivery.messageIds,
        deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      });
      deliveryRecorded = true;
      logger.info("queue.accepted", {
        ...scopeRefFromStoreSessionName(input.sessionName),
        conversationId: input.conversationId,
        messageIds: input.queuedDelivery.messageIds,
        deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      });
    },

    async settleAfterTurn(): Promise<void> {
      if (!input.queuedDelivery || deliveryRecorded) return;
      try {
        await deps.markQueuedUncertain({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          ids: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error:
            "Delivery may have reached the agent, but its acknowledgement was not durably completed. Review before retrying or discarding.",
        });
        logger.warn("queue.delivery_review_required", {
          ...scopeRefFromStoreSessionName(input.sessionName),
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
        });
      } catch (err) {
        logger.error("queue.delivery_review_failed", {
          ...scopeRefFromStoreSessionName(input.sessionName),
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error: getErrorMessage(err),
        });
      }
    },
  };
}
