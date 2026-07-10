import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { stampedTranscriptMessageSchema } from "@/lib/conversations/schemas";

export function useConversationMessagesQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  options: { enabled?: boolean } = {},
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
    enabled: options.enabled ?? true,
  });
}
