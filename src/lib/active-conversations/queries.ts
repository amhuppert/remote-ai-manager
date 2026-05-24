import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { activeConversationsResponseSchema } from "./schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";

export function useActiveConversationsQuery() {
  return useQuery({
    queryKey: conversationKeys.active(),
    queryFn: async () => {
      return apiFetch(
        "/api/conversations/active",
        activeConversationsResponseSchema,
      );
    },
  });
}
