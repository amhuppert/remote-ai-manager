import type { ConversationTurnDependencies } from "@/lib/conversation-core/turn/dependencies";
import type { SubscriptionRecipient } from "@/lib/subscriptions/schemas";
import {
  inertBriefingContext,
  trackBriefingDelivery,
  type InputBriefing,
} from "./passive-subscription-context";

/**
 * The reminder that the previous runtime's background tasks ended with it, so
 * their completion will never arrive. It rides at the head of a turn's own
 * input, once: the durable notices it quotes are claimed for this input and
 * settle with it.
 */
export async function prepareRuntimeRecoveryContext(
  effects: Pick<
    ConversationTurnDependencies["effects"],
    "prepareRuntimeLossNotice"
  >,
  input: {
    recipient: SubscriptionRecipient;
    attemptId: string;
    eligible: boolean;
  },
): Promise<InputBriefing> {
  if (!input.eligible) return inertBriefingContext;
  const briefing = await effects.prepareRuntimeLossNotice({
    recipient: input.recipient,
    attemptId: input.attemptId,
  });
  if (briefing.block === null) return inertBriefingContext;
  // Settled by the input's own settlement, as the passive briefing is.
  return trackBriefingDelivery(briefing, () => {});
}
