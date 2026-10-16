import {
  isEligibleSubscriptionRecipient,
  type DurableConversationIdentity,
} from "@/lib/conversations/provenance";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import {
  deliverQueuedMessage,
  type QueueMessageDeps,
} from "@/lib/prompt/queue";
import type { SubscriptionWakeBatch } from "./active-wait-schemas";

export interface ActiveWaitDeliveryDeps {
  isBatchDispatchable(batchId: string): Promise<boolean>;
  readConversation(
    conversationId: string,
  ):
    | DurableConversationIdentity
    | null
    | Promise<DurableConversationIdentity | null>;
  drainConversation(conversationId: string): Promise<void>;
  queueDeps?: Partial<QueueMessageDeps>;
}

/** Deliver a reserved wake through the conversation's live input or next-turn queue. */
export async function deliverSubscriptionWake(
  batch: SubscriptionWakeBatch,
  signal: AbortSignal,
  deps: ActiveWaitDeliveryDeps,
): Promise<void> {
  if (signal.aborted || !(await deps.isBatchDispatchable(batch.id))) return;
  const identity = await deps.readConversation(batch.recipient.conversationId);
  if (
    !identity ||
    !isEligibleSubscriptionRecipient(identity, batch.recipient.projectPath)
  )
    return;
  const entry = identity.conversation.pendingQueue.find(
    (row) =>
      row.metadata?.kind === "subscription_update" &&
      row.metadata.batchId === batch.id,
  );
  if (!entry || entry.status !== "pending" || signal.aborted) return;
  // Once a live attempt was refused, leave it to the next turn. Reconciliation
  // must not spend the queue's retry allowance on the same unsupported live input.
  if (entry.attemptCount > 0) {
    await deps.drainConversation(identity.conversation.id);
    return;
  }
  const outcome = await deliverQueuedMessage({
    projectPath: identity.projectPath,
    sessionName: storeSessionNameFromScopeRef(
      identity.sessionName === null
        ? { scope: "project" }
        : { scope: "session", sessionName: identity.sessionName },
    ),
    conversationId: identity.conversation.id,
    backend: identity.conversation.agentBackend,
    entry,
    signal,
    deps: deps.queueDeps,
  });
  // The core owns input once sent. Shutdown must not start a fallback turn after its acknowledgement.
  if (!signal.aborted && outcome.deliveryTiming === "next_turn")
    await deps.drainConversation(identity.conversation.id);
}
