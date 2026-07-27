import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  conversationTargetApiBase,
  conversationTargetKey,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PendingPromptRequest } from "@/lib/prompt/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

/** Build the pending-prompt persistence URL for the addressed conversation. */
function pendingPromptUrl(target: ConversationTarget): string {
  return `${conversationTargetApiBase(target)}/pending-prompt`;
}

/**
 * Fire-and-forget pending-prompt save via navigator.sendBeacon, used during
 * page unload when the regular mutation's fetch would be aborted. Returns
 * true when the beacon was queued by the browser, false otherwise (e.g., no
 * navigator, no sendBeacon, or the user agent rejected the payload).
 */
export function sendPendingPromptBeacon(
  target: ConversationTarget,
  text: string | null,
): boolean {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
  const blob = new Blob([JSON.stringify({ text })], {
    type: "application/json",
  });
  return navigator.sendBeacon(pendingPromptUrl(target), blob);
}

/**
 * Patch the cached conversation the surface for this scope actually renders
 * from, so a re-mount (conversation switch, tab activation) rehydrates the draft
 * the user just typed rather than the last value the server confirmed. The two
 * scopes read from different caches — a session's conversations arrive inside
 * its session detail, a project's as their own list — so this is the one place
 * the target's scope is branched on.
 */
async function patchCachedDraft(
  queryClient: ReturnType<typeof useQueryClient>,
  target: ConversationTarget,
  text: string | null,
): Promise<void> {
  const withDraft = (c: ConversationState): ConversationState =>
    c.id === target.conversationId ? { ...c, pendingPromptText: text } : c;

  if (target.scope === "session") {
    const detailKey = sessionKeys.detail(
      target.projectName,
      target.sessionName,
    );
    await queryClient.cancelQueries({ queryKey: detailKey });
    const previous = queryClient.getQueryData<SessionState>(detailKey);
    if (!previous) return;
    queryClient.setQueryData<SessionState>(detailKey, {
      ...previous,
      conversations: previous.conversations.map(withDraft),
    });
    return;
  }

  const listKey = projectConversationKeys.list(target.projectName);
  await queryClient.cancelQueries({ queryKey: listKey });
  const previous = queryClient.getQueryData<ConversationState[]>(listKey);
  if (!previous) return;
  queryClient.setQueryData<ConversationState[]>(
    listKey,
    previous.map(withDraft),
  );
}

/**
 * The request body the pending-prompt route validates, plus the conversation it
 * addresses. `text`/`expectedText` are the schema's own fields — `expectedText`
 * clears only while the persisted draft still equals it, so text typed while a
 * submit-clear was in flight is not discarded.
 */
export interface UpdatePendingPromptTextInput extends PendingPromptRequest {
  /**
   * The conversation whose draft is being written. Carried per call rather than
   * bound to the hook because a flush on conversation switch has to address the
   * conversation the user just LEFT — that is the one with unsaved text.
   */
  target: ConversationTarget;
}

/**
 * Persist or clear the in-progress prompt text on a conversation of EITHER
 * scope. Addressing is a `ConversationTarget`, so the project variant has no
 * field the internal session sentinel could occupy and the URL builder is the
 * shared one.
 *
 * Used by the prompt input to keep typed text alive across navigations and
 * reloads. Optimistically updates the scope's cached conversation so a
 * subsequent re-mount can read the latest value before the server roundtrip
 * settles. Errors are intentionally swallowed at the mutation layer — the user
 * is still typing and a transient save failure shouldn't blow away their input;
 * the next keystroke will retry the save.
 *
 * `scopeTarget` is null only on the project cockpit's create-and-send path,
 * before a conversation id exists; nothing is submitted under it.
 */
export function useUpdatePendingPromptTextMutation(
  scopeTarget: ConversationTarget | null,
) {
  const queryClient = useQueryClient();

  return useMutation({
    scope: {
      id: JSON.stringify([
        "pending-prompt",
        ...(scopeTarget ? conversationTargetKey(scopeTarget) : []),
      ]),
    },
    mutationFn: ({
      target,
      text,
      expectedText,
    }: UpdatePendingPromptTextInput) =>
      mutationFetch(pendingPromptUrl(target), "update-pending-prompt-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, expectedText }),
      }),
    onMutate: async ({ target, text }) => {
      await patchCachedDraft(queryClient, target, text);
    },
  });
}
