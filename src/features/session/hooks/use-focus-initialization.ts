"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useFinalizeInitializationMutation } from "@/lib/sessions/mutations";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useFailPrompt } from "@/stores/session-detail.store";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface UseFocusInitializationArgs {
  projectName: string;
  sessionName: string;
  isBusy: boolean;
  messagesLength: number;
  selectedModel: string;
  selectedEffort: EffortLevel;
  effortSupported: boolean;
  selectedBackend: AgentBackendId;
  sendPrompt: (
    prompt: string,
    messageCount: number,
    model: string,
    images: undefined,
    effort: EffortLevel | undefined,
    backend: AgentBackendId,
  ) => Promise<void> | void;
  /**
   * When provided, invoked instead of `router.push` to open the finalized
   * conversation, so a host like /conversations can switch in place with the
   * history API (§1.2). When absent, behavior is the per-conversation
   * route's `router.push`.
   */
  onOpenConversation?: (target: { conversationId: string }) => void;
}

export interface UseFocusInitializationResult {
  focusConfirmLoading: boolean;
  handleConfirmFocus: () => void;
}

export function useFocusInitialization({
  projectName,
  sessionName,
  isBusy,
  messagesLength,
  selectedModel,
  selectedEffort,
  effortSupported,
  selectedBackend,
  sendPrompt,
  onOpenConversation,
}: UseFocusInitializationArgs): UseFocusInitializationResult {
  const router = useRouter();
  const failPrompt = useFailPrompt();
  const finalizeMutation = useFinalizeInitializationMutation(
    projectName,
    sessionName,
  );
  const [focusConfirmLoading, setFocusConfirmLoading] = useState(false);
  const [awaitingFinalize, setAwaitingFinalize] = useState(false);

  // Step 1: User clicks confirm → send write-focus-document prompt, set flag
  const handleConfirmFocus = useCallback(() => {
    setFocusConfirmLoading(true);
    setAwaitingFinalize(true);
    void import("@/lib/prompt/templates").then(
      ({ getWriteFocusDocumentPrompt }) => {
        void sendPrompt(
          getWriteFocusDocumentPrompt(),
          messagesLength,
          selectedModel,
          undefined,
          effortSupported ? selectedEffort : undefined,
          selectedBackend,
        );
      },
    );
  }, [
    sendPrompt,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
  ]);

  // Step 2: Once the prompt finishes (session no longer busy), finalize
  useEffect(() => {
    if (!awaitingFinalize || isBusy) return;
    setAwaitingFinalize(false);

    void (async () => {
      try {
        const result = await finalizeMutation.mutateAsync();
        if (onOpenConversation !== undefined) {
          onOpenConversation({ conversationId: result.conversationId });
        } else {
          router.push(
            conversationsPageHref({ conversationId: result.conversationId }),
          );
        }
      } catch {
        failPrompt("Failed to finalize initialization");
        setFocusConfirmLoading(false);
      }
    })();
  }, [
    awaitingFinalize,
    isBusy,
    finalizeMutation,
    router,
    projectName,
    sessionName,
    failPrompt,
    onOpenConversation,
  ]);

  return { focusConfirmLoading, handleConfirmFocus };
}
