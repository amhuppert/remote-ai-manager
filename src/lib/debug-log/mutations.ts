import { useMutation, useQueryClient } from "@tanstack/react-query";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { debugLogKeys } from "./query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import type { SessionState } from "@/lib/sessions/schemas";

function debugModeUrl(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/debug-mode`;
}

export function useDebugModeToggleMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (action: "enter" | "exit") =>
      mutationFetch(
        debugModeUrl(projectName, sessionName, conversationId),
        "debug-mode-toggle",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
    },
  });
}

export function useDebugPhaseMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      action:
        | "mark_reproduced"
        | "mark_fix_verified"
        | "mark_fix_failed"
        | "revert_to_awaiting_reproduction"
        | "revert_to_awaiting_verification"
        | "retry_turn",
    ) =>
      mutationFetch(
        debugModeUrl(projectName, sessionName, conversationId),
        "debug-phase-transition",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useDebugRecordingMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  const queryKey = sessionKeys.detail(projectName, sessionName);

  return useMutation({
    mutationFn: (recording: boolean) =>
      mutationFetch(
        `${debugModeUrl(projectName, sessionName, conversationId)}/recording`,
        "debug-recording-toggle",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recording }),
        },
      ),
    onMutate: async (recording) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SessionState>(queryKey);
      if (previous) {
        queryClient.setQueryData<SessionState>(queryKey, {
          ...previous,
          conversations: previous.conversations.map((c) =>
            c.id === conversationId && c.debugMode
              ? { ...c, debugMode: { ...c.debugMode, recording } }
              : c,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _recording, context) => {
      if (context?.previous) {
        queryClient.setQueryData<SessionState>(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useClearDebugLogsMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `${debugModeUrl(projectName, sessionName, conversationId)}/logs`,
        "clear-debug-logs",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: debugLogKeys.stats(projectName, sessionName, conversationId),
      });
    },
  });
}
