/**
 * Post-turn step: durable-queue delivery accounting for auto-drained turns.
 *
 * Hides the ownership handoff between the durable message queue and the JSONL
 * transcript: for a queued (auto-drained) turn the queue — not the transcript
 * — owns the user content until the backend confirms acceptance, so the
 * coalesced user entry is appended exactly once on `input_accepted` (append
 * BEFORE the queue release), and the claimed rows leave the queue only after
 * both durable writes succeed. Any incomplete handoff is retained for review:
 * a missing acknowledgement does not prove the request never ran.
 * Normal turns append their user entry at dispatch and never touch queue marks.
 *
 * A checkpoint delivery splits the two halves: it archives the accepted input
 * in event order but releases the rows only once its own acceptance is
 * durable, so a release that runs from a repaired receipt may find the rows
 * already held for review by this attempt's settlement. The confirming effect
 * releases both.
 */

import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import type { QueuedDeliveryMetadata } from "../turn-spec";
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
  confirmQueuedDelivery(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<number>;
}

export interface QueuedDeliveryAccounting {
  /** Append the user entry now for a NON-queued turn; no-op when queued. */
  appendUserEntryAtDispatch(): Promise<void>;
  /**
   * Archive the accepted queued input now, for a caller that releases the
   * rows later through `handleInputAccepted`; no-op for a normal turn, whose
   * entry was appended at dispatch. Safe against repeated events.
   */
  appendAcceptedUserEntry(): Promise<void>;
  /**
   * Backend accepted the input: append the coalesced user entry exactly once
   * and release the claimed rows. Safe against repeated events.
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
  // A successful transcript append and a successful queue release are
  // separate facts. Retain ownership until both have completed.
  let userEntry: Promise<void> | undefined;
  let deliveryRecorded = false;
  let acceptance: Promise<void> | undefined;

  function appendQueuedUserEntryOnce(): Promise<void> {
    userEntry ??= Promise.resolve()
      .then(() => input.appendUserEntry())
      .catch((error: unknown) => {
        userEntry = undefined;
        throw error;
      });
    return userEntry;
  }

  return {
    async appendUserEntryAtDispatch(): Promise<void> {
      if (input.queuedDelivery) return;
      await input.appendUserEntry();
    },

    async appendAcceptedUserEntry(): Promise<void> {
      if (!input.queuedDelivery || deliveryRecorded) return;
      await appendQueuedUserEntryOnce();
    },

    handleInputAccepted(): Promise<void> {
      if (acceptance) return acceptance;
      acceptance = (async () => {
        if (!input.queuedDelivery || deliveryRecorded) return;
        await appendQueuedUserEntryOnce();
        const released = await deps.confirmQueuedDelivery({
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
          released,
        });
      })();
      void acceptance.catch(() => {
        acceptance = undefined;
      });
      return acceptance;
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
