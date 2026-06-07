import type { ActiveConversation } from "@/lib/active-conversations/schemas";

export function activeConversationNeedsAttention(
  row: ActiveConversation,
): boolean {
  return row.status === "waiting_for_input" || row.unread;
}

export function activeConversationHref(row: ActiveConversation): string {
  const projectName = encodeURIComponent(row.projectName);
  const conversationId = encodeURIComponent(row.id);
  if (row.scope === "session") {
    return `/projects/${projectName}/${encodeURIComponent(row.sessionName)}/${conversationId}`;
  }
  return `/projects/${projectName}?focus=${conversationId}`;
}
