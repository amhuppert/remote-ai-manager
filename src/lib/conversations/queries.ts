import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, apiFetchOptional } from "@/lib/api/fetcher";
import { conversationKeys } from "./query-keys";
import {
  allConversationsResponseSchema,
  conversationListItemSchema,
  publicConversationStateSchema,
} from "./schemas";

export function useConversationsQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: conversationKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        z.array(publicConversationStateSchema),
      ),
  });
}

/**
 * Resolve a session-scoped conversation by id alone via
 * GET /api/conversations/[conversationId]. `data === null` is the
 * distinguishable not-found state (lookup 404); other failures surface as a
 * regular query error. Disabled while `conversationId` is null.
 */
export function useConversationLookupQuery(conversationId: string | null) {
  return useQuery({
    queryKey: conversationKeys.lookup(conversationId ?? ""),
    queryFn: () =>
      apiFetchOptional(
        `/api/conversations/${encodeURIComponent(conversationId ?? "")}`,
        conversationListItemSchema,
      ),
    enabled: conversationId !== null,
  });
}

export function useAllConversationsQuery(
  params: { includeArchived: boolean },
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: conversationKeys.allConversations(params),
    queryFn: () =>
      apiFetch(
        `/api/conversations/all?includeArchived=${params.includeArchived ? "true" : "false"}`,
        allConversationsResponseSchema,
      ),
    staleTime: 30_000,
    enabled: options?.enabled,
  });
}
