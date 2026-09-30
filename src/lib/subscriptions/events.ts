import { publishEventBestEffort } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type { SubscriptionRecipient, SubscriptionSourceRef } from "./schemas";
import { subscriptionsChangedEventSchema } from "./controls-schemas";
const logger = createLogger("subscriptions.events");

export function publishSubscriptionChange(
  recipient: SubscriptionRecipient,
  source?: SubscriptionSourceRef,
): void {
  publishEventBestEffort({
    logger,
    failureEvent: "subscriptions.publish_failed",
    context: { conversationId: recipient.conversationId },
    build: () =>
      subscriptionsChangedEventSchema.parse({
        type: "subscriptions-changed",
        ...recipient,
        ...(source ? { source } : {}),
      }),
  });
}
