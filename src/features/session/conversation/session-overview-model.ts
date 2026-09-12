import type { PublicConversationState } from "@/lib/conversations/schemas";

export type ConversationFilter = "all" | "attention" | "running" | "unread";

export function selectSessionConversations(
  conversations: readonly PublicConversationState[],
  options: { filter: ConversationFilter; query: string; showArchived: boolean },
): PublicConversationState[] {
  const query = options.query.trim().toLocaleLowerCase();
  return conversations
    .filter((conversation) => {
      if (conversation.role !== null) return false;
      if (conversation.archived && !options.showArchived) return false;
      if (
        options.filter === "attention" &&
        conversation.status !== "waiting_for_input"
      )
        return false;
      if (options.filter === "running" && conversation.status !== "running")
        return false;
      if (options.filter === "unread" && !conversation.unread) return false;
      return [
        conversation.name,
        conversation.summary,
        conversation.id,
        conversation.agentBackend,
      ].some((value) => value?.toLocaleLowerCase().includes(query));
    })
    .sort((a, b) => {
      if (a.archived !== b.archived)
        return Number(a.archived) - Number(b.archived);
      const priority = {
        waiting_for_input: 0,
        running: 1,
        awaiting: 2,
        new: 2,
      };
      return (
        priority[a.status] - priority[b.status] ||
        b.lastActivityAt.localeCompare(a.lastActivityAt)
      );
    });
}

export function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
