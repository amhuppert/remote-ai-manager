import type { ConversationTarget } from "@/lib/conversations/conversation-target";
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
  messages: readonly { id?: string }[],
): number | null {
  if ((params.get("c") ?? params.get("focus")) !== conversationId) return null;
  const messageId = params.get("m");
  if (!messageId) return null;
  const index = messages.findIndex((message) => message.id === messageId);
  return index < 0 ? null : index;
}
