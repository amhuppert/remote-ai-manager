import type { RunningTurnDescription } from "@/lib/conversation-core/interactive-turns";
import type { SubscriptionWakeBatch } from "./active-wait-schemas";
import type { SubscriptionRecipient } from "./schemas";

interface CausationDependencies {
  getBatch(
    id: string,
  ): Promise<Pick<SubscriptionWakeBatch, "id" | "recipient"> | null>;
}

/** Verified wake inputs available to this turn; no claim about which one caused its next action. */
export async function activeWaitCausation(
  recipient: SubscriptionRecipient,
  turn: RunningTurnDescription | null,
  deps: CausationDependencies,
): Promise<string[]> {
  if (turn === null) return [];
  const candidates = new Set([
    ...(turn.originMessageId === null ? [] : [turn.originMessageId]),
    ...(turn.acceptedSubscriptionBatchIds ?? []),
  ]);
  const verified: string[] = [];
  for (const id of candidates) {
    const parent = await deps.getBatch(id);
    if (
      parent?.recipient.conversationId === recipient.conversationId &&
      parent.recipient.projectPath === recipient.projectPath
    )
      verified.push(parent.id);
  }
  return verified.slice(-8);
}
