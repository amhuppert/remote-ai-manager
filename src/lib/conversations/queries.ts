import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "./query-keys";
import { conversationStateSchema, transcriptMessageSchema } from "./schemas";

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

export function useConversationMessagesQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  return useQuery({
    queryKey: conversationKeys.messages(
      projectName,
      sessionName,
      conversationId,
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/messages`,
        z.array(stampedTranscriptMessageSchema),
      ),
  });
}
