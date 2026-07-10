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
 *
 * `preserveQuestions` skips the pending-question cleanup: the question panel
 * is workspace-scoped (it belongs to the composer's target conversation), so
 * a surface stopping a DIFFERENT conversation (a background pane) must not
 * clear the active conversation's questions.
 */
export function useAbortPrompt(
  projectName: string,
  sessionName: string,
  conversationId?: string,
  options: { preserveQuestions?: boolean } = {},
): () => Promise<void> {
  const queryClient = useQueryClient();
  const completePrompt = useCompletePrompt();
  const clearQuestions = useClearQuestions();
  const markCancelled = useMarkCancelled();
  const { preserveQuestions = false } = options;

  return useCallback(async () => {
    if (!conversationId) return;

    const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/abort`;

    try {
      const res = await tracedFetch(url, "abort-prompt", {
        method: "POST",
      });

      if (res.ok || res.status === 409) {
        // 409 means nothing was running — still safe to clean up UI state
        if (!preserveQuestions) clearQuestions();
        completePrompt(conversationId);
        markCancelled(conversationId);

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
      completePrompt(conversationId);
    }
  }, [
    projectName,
    sessionName,
    conversationId,
    queryClient,
    completePrompt,
    clearQuestions,
    markCancelled,
    preserveQuestions,
  ]);
}
