"use client";

import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { findBusyOtherConversations } from "@/lib/sessions/derived";
import {
  queueCapabilityForBackend as defaultQueueCapabilityForBackend,
  type QueueCapability,
} from "@/lib/agent-backends/capabilities-descriptor";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";
import type { ImagePayload } from "@/lib/images/schemas";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

function hasCollabPrefix(text: string): boolean {
  return text === "/collab" || text.startsWith("/collab ");
}

function stripCollabPrefix(text: string): string {
  if (text === "/collab") return "";
  if (text.startsWith("/collab ")) return text.slice("/collab ".length);
  return text;
}

interface CollabConfig {
  negotiationRounds: number;
  autonomousResolutionThreshold: "none" | "minor" | "major" | "blocking";
}

export interface UsePromptSubmissionArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  conversations: SessionState["conversations"] | undefined;
  sending: boolean;
  pendingImages: ImageAttachment[];
  promptTextRef: MutableRefObject<string>;
  editorRef: MutableRefObject<PromptEditorHandle | null>;
  setPromptText: Dispatch<SetStateAction<string>>;
  clearImages: () => void;
  clearPersistedPendingPromptOnSubmit: () => void;
  effectiveCollabConfig: CollabConfig;
  clearCollabConfigDraft: (
    project: string,
    session: string,
    conversation: string,
  ) => void;
  messagesLength: number;
  selectedModel: string;
  selectedEffort: EffortLevel;
  effortSupported: boolean;
  selectedBackend: AgentBackendId;
  sendPrompt: (
    prompt: string,
    messageCount: number,
    model: string,
    images: ImagePayload[] | undefined,
    effort: EffortLevel | undefined,
    backend: AgentBackendId,
  ) => Promise<void>;
  queueMessage: (text: string, images?: ImagePayload[]) => Promise<void>;
  queueCapabilityForBackend?: (backend: AgentBackendId) => QueueCapability;
  collaborationStartMutation: {
    mutate: (
      input: {
        brief: string;
        negotiationRounds: number;
        autonomousResolutionThreshold: "none" | "minor" | "major" | "blocking";
        conversationId: string;
        backend?: AgentBackendId;
        modelId?: string;
        effort?: string;
      },
      options?: {
        onSuccess?: () => void;
        onError?: (error: unknown) => void;
      },
    ) => void;
  };
  enqueuePromptErrorToast: (item: {
    projectName: string;
    sessionName: string;
    conversationId: string;
    error: string;
  }) => void;
}

export interface UsePromptSubmissionResult {
  handleSendPrompt: () => Promise<void>;
  handleDebugPrompt: (text: string) => Promise<void>;
  handleConcurrentConfirm: () => void;
  cancelConcurrentSubmission: () => void;
  pendingConcurrentSubmission: {
    text: string;
    images: ImagePayload[];
    busyNames: string[];
  } | null;
}

export function usePromptSubmission({
  projectName,
  sessionName,
  conversationId,
  conversations,
  sending,
  pendingImages,
  promptTextRef,
  editorRef,
  setPromptText,
  clearImages,
  clearPersistedPendingPromptOnSubmit,
  effectiveCollabConfig,
  clearCollabConfigDraft,
  messagesLength,
  selectedModel,
  selectedEffort,
  effortSupported,
  selectedBackend,
  sendPrompt,
  queueMessage,
  queueCapabilityForBackend = defaultQueueCapabilityForBackend,
  collaborationStartMutation,
  enqueuePromptErrorToast,
}: UsePromptSubmissionArgs): UsePromptSubmissionResult {
  const [pendingConcurrentSubmission, setPendingConcurrentSubmission] =
    useState<{
      text: string;
      images: ImagePayload[];
      busyNames: string[];
    } | null>(null);

  const dispatchPrompt = useCallback(
    async (text: string, images: ImagePayload[]) => {
      // Clear the persisted pendingPromptText BEFORE invoking the agent so a
      // slow agent response can't resurrect stale input on reload.
      clearPersistedPendingPromptOnSubmit();
      editorRef.current?.clear();
      setPromptText("");
      clearImages();
      await sendPrompt(
        text,
        messagesLength,
        selectedModel,
        images.length > 0 ? images : undefined,
        effortSupported ? selectedEffort : undefined,
        selectedBackend,
      );
    },
    [
      sendPrompt,
      messagesLength,
      selectedModel,
      effortSupported,
      selectedEffort,
      selectedBackend,
      clearImages,
      clearPersistedPendingPromptOnSubmit,
      editorRef,
      setPromptText,
    ],
  );

  const handleSendPrompt = useCallback(async () => {
    const serialized = editorRef.current?.serialize(pendingImages) ?? {
      prompt: promptTextRef.current,
      images: [],
    };
    const trimmedPrompt = serialized.prompt.trim();
    const hasImages = serialized.images.length > 0;
    if (!trimmedPrompt && !hasImages) return;

    if (hasCollabPrefix(trimmedPrompt)) {
      const brief = stripCollabPrefix(trimmedPrompt).trim();
      if (!brief) return;
      const originalPromptText = trimmedPrompt;
      const collabConversationId = conversationId;
      editorRef.current?.clear();
      setPromptText("");
      collaborationStartMutation.mutate(
        {
          brief,
          negotiationRounds: effectiveCollabConfig.negotiationRounds,
          autonomousResolutionThreshold:
            effectiveCollabConfig.autonomousResolutionThreshold,
          conversationId: collabConversationId,
          backend: selectedBackend,
          modelId: selectedModel,
          ...(effortSupported ? { effort: selectedEffort } : {}),
        },
        {
          onSuccess: () => {
            clearPersistedPendingPromptOnSubmit();
          },
          onError: (err) => {
            const message =
              err instanceof Error
                ? err.message
                : "Failed to start collaboration run";
            enqueuePromptErrorToast({
              projectName,
              sessionName,
              conversationId: collabConversationId,
              error: message,
            });
            setPromptText(originalPromptText);
            const editorInstance = editorRef.current?.editor;
            if (editorInstance) {
              editorInstance.commands.setContent(originalPromptText);
            }
          },
        },
      );
      clearCollabConfigDraft(projectName, sessionName, conversationId);
      return;
    }

    const imagePayloads: ImagePayload[] = hasImages ? serialized.images : [];

    // Queue into running conversation instead of starting a new prompt
    if (sending && conversationId) {
      const capability = queueCapabilityForBackend(selectedBackend);
      // The backend can't accept a queued message. Preserve the user's input
      // rather than dropping it into a queue that won't deliver (req 6.2/10.2);
      // the composer gates this case so it is normally unreachable.
      if (!capability.acceptsWhileRunning) return;

      clearPersistedPendingPromptOnSubmit();
      editorRef.current?.clear();
      setPromptText("");
      clearImages();
      await queueMessage(
        trimmedPrompt,
        imagePayloads.length > 0 ? imagePayloads : undefined,
      );
      return;
    }

    if (sending) return;

    // Warn — but do not block — when other conversations in this session are
    // actively running. Trust the user; concurrent edits in the same worktree
    // can step on each other but read-only / review prompts are fine.
    const busyOthers = findBusyOtherConversations(
      conversations,
      conversationId,
    );
    if (busyOthers.length > 0) {
      setPendingConcurrentSubmission({
        text: trimmedPrompt,
        images: imagePayloads,
        busyNames: busyOthers.map((c, i) => c.name ?? `Conversation ${i + 1}`),
      });
      return;
    }

    await dispatchPrompt(trimmedPrompt, imagePayloads);
  }, [
    sending,
    conversationId,
    queueMessage,
    queueCapabilityForBackend,
    clearImages,
    pendingImages,
    promptTextRef,
    editorRef,
    setPromptText,
    selectedBackend,
    selectedModel,
    selectedEffort,
    effortSupported,
    collaborationStartMutation,
    effectiveCollabConfig.negotiationRounds,
    effectiveCollabConfig.autonomousResolutionThreshold,
    clearCollabConfigDraft,
    projectName,
    sessionName,
    conversations,
    dispatchPrompt,
    clearPersistedPendingPromptOnSubmit,
    enqueuePromptErrorToast,
  ]);

  const handleConcurrentConfirm = useCallback(() => {
    if (!pendingConcurrentSubmission) return;
    const { text, images } = pendingConcurrentSubmission;
    setPendingConcurrentSubmission(null);
    void dispatchPrompt(text, images);
  }, [pendingConcurrentSubmission, dispatchPrompt]);

  const cancelConcurrentSubmission = useCallback(() => {
    setPendingConcurrentSubmission(null);
  }, []);

  const handleDebugPrompt = useCallback(
    (text: string): Promise<void> =>
      sendPrompt(
        text,
        messagesLength,
        selectedModel,
        undefined,
        undefined,
        selectedBackend,
      ),
    [sendPrompt, messagesLength, selectedModel, selectedBackend],
  );

  return {
    handleSendPrompt,
    handleDebugPrompt,
    handleConcurrentConfirm,
    cancelConcurrentSubmission,
    pendingConcurrentSubmission,
  };
}
