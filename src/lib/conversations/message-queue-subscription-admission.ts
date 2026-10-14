import { isOrdinaryConversationRole, type ConversationState } from "./schemas";
import { scopeRefFromStoreSessionName } from "./conversation-target";
import {
  isActiveQueuedMessageStatus,
  queuedMessageNeedsReview,
} from "./message-queue-schemas";

export function hasOnlySubscriptionWakeQueue(
  conversation: ConversationState,
): boolean {
  const active = conversation.pendingQueue.filter((row) =>
    isActiveQueuedMessageStatus(row.status),
  );
  return (
    active.length > 0 &&
    active.every((row) => row.metadata?.kind === "subscription_update")
  );
}

export function subscriptionWakeHold(input: {
  conversation: ConversationState | null;
  sessionArchived: boolean;
}): string | null {
  const row = input.conversation;
  if (!row) return "Subscription recipient no longer exists";
  if (input.sessionArchived || row.archived)
    return "Subscription recipient is archived";
  if (row.owner !== null || !isOrdinaryConversationRole(row.role))
    return "Subscription recipient is owned by another execution";
  if (row.pendingQuestionId !== null)
    return "Subscription recipient is waiting for an answer";
  if (row.debugMode?.active === true)
    return "Subscription recipient is held by its debug workflow";
  if (
    row.pendingQueue.some(
      (entry) =>
        entry.metadata?.kind === "subscription_update" &&
        queuedMessageNeedsReview(entry.status),
    )
  )
    return "Subscription wake delivery needs explicit review";
  return null;
}

export function createSubscriptionWakeAdmissionReader(deps: {
  hasAcceptedInput(conversationId: string, batchId: string): Promise<boolean>;
  isBatchCurrent?(batchId: string): Promise<boolean>;
  readHold(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<string | null>;
}) {
  return async (input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    batchId?: string;
  }): Promise<string | null> => {
    if (
      input.batchId &&
      (await deps.hasAcceptedInput(input.conversationId, input.batchId))
    )
      return "Subscription wake already has durable input acceptance";
    if (
      input.batchId &&
      deps.isBatchCurrent &&
      !(await deps.isBatchCurrent(input.batchId))
    )
      return "Subscription wake reservation is no longer current";
    return deps.readHold(input);
  };
}

export async function readSubscriptionWakeHold(input: {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}): Promise<string | null> {
  const store = await import("@/lib/state-store");
  const projectScope =
    scopeRefFromStoreSessionName(input.sessionName).scope === "project";
  const [conversation, session] = await Promise.all([
    store.getConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    ),
    projectScope
      ? Promise.resolve(null)
      : store.getSession(input.projectPath, input.sessionName),
  ]);
  return subscriptionWakeHold({
    conversation,
    sessionArchived: !projectScope && (session === null || session.archived),
  });
}
