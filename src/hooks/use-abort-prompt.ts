"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import {
  useCompletePrompt,
  useClearQuestions,
  useMarkCancelled,
} from "@/stores/session-detail.store";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { gitKeys } from "@/lib/git/query-keys";

/**
 * Hook that aborts a running prompt by:
 * 1. Calling the server-side abort endpoint (signals SDK AbortController)
 * 2. Cleaning up Zustand UI state (sending, pending questions)
 * 3. Invalidating TanStack Query caches
 */
export function useAbortPrompt(
  projectName: string,
  sessionName: string,
  conversationId?: string,
): () => Promise<void> {
  const queryClient = useQueryClient();
  const completePrompt = useCompletePrompt();
  const clearQuestions = useClearQuestions();
  const markCancelled = useMarkCancelled();

  return useCallback(async () => {
    if (!conversationId) return;

    const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/abort`;

    try {
      const res = await tracedFetch(url, "abort-prompt", {
        method: "POST",
      });

      if (res.ok || res.status === 409) {
        // 409 means nothing was running — still safe to clean up UI state
        clearQuestions();
        completePrompt();
        markCancelled();

        // Invalidate caches so the UI refreshes with final state
        void queryClient.invalidateQueries({
          queryKey: conversationKeys.messages(
            projectName,
            sessionName,
            conversationId,
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: gitKeys.diff(projectName, sessionName),
        });
        void queryClient.invalidateQueries({
          queryKey: gitKeys.commits(projectName, sessionName),
        });
      }
    } catch {
      // Network error — still try to clean up local UI
      completePrompt();
    }
  }, [
    projectName,
    sessionName,
    conversationId,
    queryClient,
    completePrompt,
    clearQuestions,
    markCancelled,
  ]);
}
