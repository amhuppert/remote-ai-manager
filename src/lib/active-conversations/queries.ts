import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { activeConversationsResponseSchema } from "./schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import type { ConversationBackgroundActivity } from "@/lib/conversations/schemas";

function activeConversationsQueryOptions() {
  return {
    queryKey: conversationKeys.active(),
    queryFn: async () =>
      apiFetch("/api/conversations/active", activeConversationsResponseSchema),
  };
}

export function useActiveConversationsQuery() {
  return useQuery(activeConversationsQueryOptions());
}

export function useSidebarConversationsQuery(includeArchived: boolean) {
  return useQuery({
    queryKey: conversationKeys.sidebar(includeArchived),
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch(
        `/api/conversations/active?view=sidebar&includeArchived=${includeArchived}`,
        activeConversationsResponseSchema,
      ),
  });
}

/**
 * This conversation's live harness background work, selected out of the shared
 * active-conversations cache. A `select` rather than a `find` over the whole
 * response so a transcript host re-renders only when its own conversation's
 * snapshot changes, not on every feed refresh.
 */
export function useConversationBackgroundActivity(
  conversationId: string,
): ConversationBackgroundActivity | null {
  const { data } = useQuery({
    ...activeConversationsQueryOptions(),
    select: (response) =>
      response.conversations.find(
        (conversation) => conversation.id === conversationId,
      )?.backgroundActivity ?? null,
  });
  return data ?? null;
}
