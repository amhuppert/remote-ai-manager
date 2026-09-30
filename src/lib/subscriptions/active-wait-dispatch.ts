import type { PendingQueuedMessageStatus } from "@/lib/conversations/message-queue-schemas";
import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SubscriptionWakeBatch } from "./active-wait-schemas";
import type { SubscriptionRecipient } from "./schemas";

export interface WakeDispatchObservation {
  recipientEligible: boolean;
  accepted: boolean;
  queueStatus: PendingQueuedMessageStatus | null;
  error?: string | null;
}

export type WakeDispatchDecision =
  | "hold"
  | "enqueue"
  | "drain"
  | "accepted"
  | "failed"
  | "uncertain"
  | "cancelled";

export function decideWakeDispatch(
  state: SubscriptionWakeBatch["state"],
  observation: WakeDispatchObservation,
): WakeDispatchDecision {
  if (state === "accepted" || state === "cancelled") return "hold";
  if (observation.accepted) return "accepted";
  if (!observation.recipientEligible) return "hold";
  switch (observation.queueStatus) {
    case "pending":
      return "drain";
    case "delivering":
      return "hold";
    case "delivered":
      return "accepted";
    case "failed":
      return "failed";
    case "uncertain":
      return "uncertain";
    case "cancelled":
      return "cancelled";
    case null:
      return state === "planned" ? "enqueue" : "uncertain";
  }
}

export interface ActiveWaitDispatchService {
  reconcile(): Promise<unknown>;
  listPendingBatches(): Promise<SubscriptionWakeBatch[]>;
  listRecipients(): Promise<SubscriptionRecipient[]>;
  prepareBatch(
    recipient: SubscriptionRecipient,
  ): Promise<SubscriptionWakeBatch | null>;
  markBatchQueued(batchId: string): Promise<void>;
  settleBatch(
    batchId: string,
    state: "accepted" | "failed" | "uncertain" | "cancelled",
    error?: string,
  ): Promise<void>;
}

export interface ActiveWaitDispatcherDeps {
  service: ActiveWaitDispatchService;
  reconcilePassive?(): Promise<void>;
  observe(batch: SubscriptionWakeBatch): Promise<WakeDispatchObservation>;
  enqueue(batch: SubscriptionWakeBatch): Promise<void>;
  drain(batch: SubscriptionWakeBatch): Promise<void>;
  confirmAccepted(batch: SubscriptionWakeBatch): Promise<void>;
  logger?: Logger;
}

/** Coordinates durable wait policy with the existing queue; owns no conversation turns. */
export function createActiveWaitDispatcher(deps: ActiveWaitDispatcherDeps) {
  const logger = deps.logger ?? createLogger("subscription-wakes");
  let current: Promise<void> | null = null;
  let stopped = false;

  async function dispatch(batch: SubscriptionWakeBatch): Promise<void> {
    try {
      const observation = await deps.observe(batch);
      if (stopped) return;
      const decision = decideWakeDispatch(batch.state, observation);
      if (decision === "hold") return;
      if (decision === "accepted") {
        // Repair a retained uncertain queue row only from positive acceptance evidence.
        await deps.confirmAccepted(batch);
        await deps.service.settleBatch(batch.id, "accepted");
        return;
      }
      if (decision === "enqueue") {
        // Persist intent before exposing input to an independently draining actor.
        // A crash in the following handoff is inspected, never guessed to be unsent.
        await deps.service.markBatchQueued(batch.id);
        try {
          await deps.enqueue(batch);
        } catch (error) {
          await deps.service.settleBatch(
            batch.id,
            "uncertain",
            getErrorMessage(error),
          );
          throw error;
        }
        if (!stopped) await deps.drain(batch);
        return;
      }
      if (decision === "drain") {
        await deps.service.markBatchQueued(batch.id);
        if (!stopped) await deps.drain(batch);
        return;
      }
      const error =
        observation.error ??
        (observation.queueStatus === null
          ? "The attempted wake has no queue row or accepted transcript entry. Inspect delivery before retrying."
          : `Wake input is ${observation.queueStatus}; inspect its conversation queue.`);
      if (batch.state !== decision || batch.lastError !== error)
        await deps.service.settleBatch(batch.id, decision, error);
    } catch (error) {
      logger.error("subscription.wake_dispatch_failed", {
        conversationId: batch.recipient.conversationId,
        batchId: batch.id,
        error: getErrorMessage(error),
      });
    }
  }

  async function run(): Promise<void> {
    await deps.service.reconcile();
    await deps.reconcilePassive?.();
    if (stopped) return;
    const visited = new Set<string>();
    for (const batch of await deps.service.listPendingBatches()) {
      if (stopped) return;
      visited.add(batch.id);
      await dispatch(batch);
    }
    for (const recipient of await deps.service.listRecipients()) {
      if (stopped) return;
      try {
        const batch = await deps.service.prepareBatch(recipient);
        if (batch && !visited.has(batch.id)) await dispatch(batch);
      } catch (error) {
        logger.error("subscription.wake_batch_failed", {
          conversationId: recipient.conversationId,
          error: getErrorMessage(error),
        });
      }
    }
  }

  return {
    tick(): Promise<void> {
      if (stopped) return Promise.resolve();
      current ??= run().finally(() => {
        current = null;
      });
      return current;
    },
    async stop(): Promise<void> {
      stopped = true;
      await current;
    },
  };
}
