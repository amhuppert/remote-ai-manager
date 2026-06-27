"use client";

import { useEffect } from "react";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AskQuestionItem } from "@/lib/conversations/schemas";

/**
 * The current URL with the one-shot autoFocus param removed. Pure so the
 * cleanup is testable on both host routes of the workspace.
 */
export function autoFocusStrippedUrl(location: {
  pathname: string;
  search: string;
}): string {
  const params = new URLSearchParams(location.search);
  params.delete("autoFocus");
  const query = params.toString();
  return query === "" ? location.pathname : `${location.pathname}?${query}`;
}

export interface UseSessionLifecycleArgs {
  resetConversationState: () => void;
  /**
   * Clear the composer's volatile per-conversation draft state (attached
   * images, inline image markers, the fire-and-forget voice flag). The
   * workspace is no longer remounted per conversation (it is a multi-
   * conversation surface), so this state — which a remount used to discard —
   * must be reset reactively when the active conversation changes. The text
   * draft is handled separately by usePendingPromptPersistence (persisted +
   * rehydrated per conversation).
   */
  clearDraftComposerState: () => void;
  clearConversationMessages: () => void;
  conversationId: string;
  session: SessionState | undefined;
  pendingQuestionId: string | null;
  showQuestions: (id: string, questions: AskQuestionItem[]) => void;
  clearQuestions: () => void;
}

export function useSessionLifecycle({
  resetConversationState,
  clearDraftComposerState,
  clearConversationMessages,
  conversationId,
  session,
  pendingQuestionId,
  showQuestions,
  clearQuestions,
}: UseSessionLifecycleArgs): void {
  // Reset conversation-scoped store state AND the composer's local draft state
  // when leaving a conversation (switch or unmount). `conversationId` is a dep
  // so the cleanup fires on every active-conversation change — the workspace is
  // not remounted, so this reactive reset is what gives each conversation a
  // clean slate. resetConversationState preserves host-shell state (layout,
  // sidebar), so this never drops out of the panes/tabs layout.
  useEffect(() => {
    return () => {
      resetConversationState();
      clearDraftComposerState();
    };
  }, [conversationId, resetConversationState, clearDraftComposerState]);

  useEffect(() => {
    clearConversationMessages();
    // Reset any accidental scroll on ancestors (overflow:clip prevents new
    // occurrences; this cleans up any pre-existing scroll offset).
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [conversationId, clearConversationMessages]);

  useEffect(() => {
    if (!session) return;
    const activeConvo = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!activeConvo) return;

    if (
      activeConvo.status === "waiting_for_input" &&
      activeConvo.pendingQuestionId &&
      activeConvo.pendingQuestions &&
      !pendingQuestionId
    ) {
      // Hydrate the store with persisted question data
      showQuestions(
        activeConvo.pendingQuestionId,
        activeConvo.pendingQuestions,
      );
    } else if (
      pendingQuestionId &&
      activeConvo.status !== "waiting_for_input"
    ) {
      // Another tab answered — clear stale question state
      clearQuestions();
    }
  }, [
    session,
    conversationId,
    pendingQuestionId,
    showQuestions,
    clearQuestions,
  ]);
}
