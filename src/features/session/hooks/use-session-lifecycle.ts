"use client";

import { useEffect, useRef } from "react";
import type { SessionState } from "@/lib/sessions/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
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
  autoFocus: boolean | undefined;
  sendPrompt: (
    prompt: string,
    messageCount: number,
    model: string,
    images: undefined,
    effort: EffortLevel | undefined,
    backend: AgentBackendId,
  ) => Promise<void> | void;
  messagesLength: number;
  selectedModel: string;
  selectedEffort: EffortLevel;
  effortSupported: boolean;
  selectedBackend: AgentBackendId;
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
  autoFocus,
  sendPrompt,
  messagesLength,
  selectedModel,
  selectedEffort,
  effortSupported,
  selectedBackend,
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

  // Tracks the conversation the objective auto-prompt has already fired for.
  // Keyed by id (not a bare boolean) because the workspace persists across
  // conversation switches: a boolean guard would block the auto-prompt for a
  // later conversation opened with autoFocus while the workspace stays mounted.
  const autoFocusFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (
      !autoFocus ||
      autoFocusFiredFor.current === conversationId ||
      !session?.objective
    )
      return;
    autoFocusFiredFor.current = conversationId;

    // One-shot param: strip it shallowly so refresh/back can't re-trigger the
    // objective prompt. Must never be an App Router navigation (§1.2) — the
    // workspace's host shell stays mounted.
    window.history.replaceState(
      null,
      "",
      autoFocusStrippedUrl(window.location),
    );

    void import("@/lib/prompt/templates").then(
      ({ getUnderstandObjectivePrompt }) => {
        const prompt = getUnderstandObjectivePrompt(session.objective!);
        void sendPrompt(
          prompt,
          messagesLength,
          selectedModel,
          undefined,
          effortSupported ? selectedEffort : undefined,
          selectedBackend,
        );
      },
    );
  }, [
    autoFocus,
    session,
    sendPrompt,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    conversationId,
  ]);
}
