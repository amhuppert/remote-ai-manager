import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { mutationFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type { CreateSessionRequest } from "@/lib/sessions/schemas";

const createdSessionSchema = z.object({
  sessionName: z.string(),
  conversations: z
    .array(
      z.object({
        id: z.string(),
      }),
    )
    .default([]),
});

export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: CreateSessionRequest) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        createdSessionSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      // Refresh the active-conversations feed so the new session's initial
      // conversation surfaces immediately. The feed has a persistent observer
      // (the Topbar), so without this it stays cached and the new conversation
      // never appears in the /conversations tabs/panes until something else
      // refetches it.
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}
