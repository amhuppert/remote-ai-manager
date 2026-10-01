import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
export function subscriptionTurnHref(
  target: ConversationTarget,
  batchId: string,
): string {
  return target.scope === "session"
    ? conversationsPageHref({
        conversationId: target.conversationId,
        messageId: batchId,
      })
    : `/projects/${encodeURIComponent(target.projectName)}?focus=${encodeURIComponent(target.conversationId)}&m=${encodeURIComponent(batchId)}`;
}
export function subscriptionMessageIndex(
  params: URLSearchParams,
  conversationId: string,
  messages: readonly Pick<TranscriptMessage, "id" | "origin" | "sourceParts">[],
): number | null {
  if ((params.get("c") ?? params.get("focus")) !== conversationId) return null;
  const messageId = params.get("m");
  if (!messageId) return null;
  const index = messages.findIndex(
    (message) =>
      message.id === messageId ||
      (message.origin?.source === "subscription_update" &&
        message.origin.subscriptionUpdate?.batchId === messageId) ||
      message.sourceParts?.some(
        (part) =>
          part.origin?.source === "subscription_update" &&
          part.origin.subscriptionUpdate?.batchId === messageId,
      ),
  );
  return index < 0 ? null : index;
}
