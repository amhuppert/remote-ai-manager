import type { ActiveSubscriptionWait } from "./active-wait-schemas";
import type { ConversationSubscription, SubscriptionDelivery } from "./schemas";

/** Pending badges describe work that can progress, while held receipts stay inspectable. */
export function isActionableSubscriptionDelivery(
  delivery: SubscriptionDelivery,
  subscription: ConversationSubscription,
  waits: readonly ActiveSubscriptionWait[],
  at: string,
): boolean {
  if (
    subscription.status !== "following" ||
    subscription.pausedAt !== null ||
    !["pending", "failed", "queued"].includes(delivery.state)
  )
    return false;
  if (delivery.state === "queued") return true;
  const ready = waits.find(
    (wait) =>
      wait.subscriptionId === subscription.id &&
      wait.deliveryId === delivery.id &&
      wait.state === "ready",
  );
  if (ready && subscription.mode === "active")
    return ready.batchId === null && delivery.state === "pending";
  if (
    subscription.mode !== "passive" &&
    subscription.source.kind !== "workflow"
  )
    return false;
  return (
    subscription.expiresAt === null ||
    subscription.expiresAt > at ||
    (subscription.source.kind === "workflow" &&
      subscription.mode === "active") ||
    (ready !== undefined && ready.batchId === null)
  );
}
