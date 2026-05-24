import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import type { SessionState } from "@/lib/sessions/schemas";
/** Build the pending-prompt persistence URL for a given conversation. */
function pendingPromptUrl(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return (
    `/api/projects/${encodeURIComponent(projectName)}/sessions/` +
    `${encodeURIComponent(sessionName)}/conversations/` +
    `${encodeURIComponent(conversationId)}/pending-prompt`
  );
}

/**
 * Fire-and-forget pending-prompt save via navigator.sendBeacon, used during
 * page unload when the regular mutation's fetch would be aborted. Returns
 * true when the beacon was queued by the browser, false otherwise (e.g., no
 * navigator, no sendBeacon, or the user agent rejected the payload).
 */
export function sendPendingPromptBeacon(
  projectName: string,
  sessionName: string,
  conversationId: string,
  text: string | null,
): boolean {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
  const url = pendingPromptUrl(projectName, sessionName, conversationId);
  const blob = new Blob([JSON.stringify({ text })], {
    type: "application/json",
  });
  return navigator.sendBeacon(url, blob);
}

/**
 * Persist or clear the in-progress prompt text on a conversation.
 *
 * Used by the prompt input to keep typed text alive across navigations and
 * reloads. Optimistically updates the cached session detail so that a
 * subsequent re-mount can read the latest value before the server roundtrip
 * settles. Errors are intentionally swallowed at the mutation layer — the user
 * is still typing and a transient save failure shouldn't blow away their input;
 * the next keystroke will retry the save.
 */
export function useUpdatePendingPromptTextMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const detailKey = sessionKeys.detail(projectName, sessionName);

  return useMutation({
    mutationFn: ({
      conversationId,
      text,
    }: {
      conversationId: string;
      text: string | null;
    }) =>
      mutationFetch(
        pendingPromptUrl(projectName, sessionName, conversationId),
        "update-pending-prompt-text",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      ),
    onMutate: async ({ conversationId, text }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData<SessionState>(detailKey);
      if (previous) {
        queryClient.setQueryData<SessionState>(detailKey, {
          ...previous,
          conversations: previous.conversations.map((c) =>
            c.id === conversationId ? { ...c, pendingPromptText: text } : c,
          ),
        });
      }
      return { previous };
    },
  });
}
