import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";

export function activeConversationNeedsAttention(
  row: ActiveConversation,
): boolean {
  return (
    row.status === "waiting_for_input" ||
    row.unread ||
    row.pendingApproval !== null
  );
}

export function activeConversationContextLabel(
  row: ActiveConversation,
): string {
  return row.scope === "session" ? row.sessionName : "main";
}

export function activeConversationHref(row: ActiveConversation): string {
  if (row.scope === "session") {
    return conversationsPageHref({ conversationId: row.id });
  }
  return `/projects/${encodeURIComponent(row.projectName)}?focus=${encodeURIComponent(row.id)}`;
}
