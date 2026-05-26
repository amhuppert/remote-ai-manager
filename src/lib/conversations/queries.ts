import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "./query-keys";
import {
  allConversationsResponseSchema,
  conversationStateSchema,
  transcriptMessageSchema,
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
        z.array(conversationStateSchema),
      ),
  });
}

export const stampedTranscriptMessageSchema = transcriptMessageSchema.extend({
  seq: z.number().int().nonnegative(),
});

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
