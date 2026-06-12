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
  storageKey: string;
  hydrateLayout: (key: string) => void;
  resetConversationState: () => void;
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
  storageKey,
  hydrateLayout,
  resetConversationState,
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
  useEffect(() => {
    hydrateLayout(storageKey);
  }, [hydrateLayout, storageKey]);

  useEffect(() => {
    return () => {
      resetConversationState();
    };
  }, [resetConversationState]);

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

  const autoFocusFired = useRef(false);
  useEffect(() => {
    if (!autoFocus || autoFocusFired.current || !session?.objective) return;
    autoFocusFired.current = true;

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
