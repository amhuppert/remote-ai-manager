"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { findBusyOtherConversations } from "@/lib/sessions/derived";
import {
  hasCollabPrefix,
  stripCollabPrefix,
} from "@/lib/conversation-commands/parse";
import { queueCapabilityForBackend as defaultQueueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import type { QueueCapability } from "@/lib/agent-backends/descriptor";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import type { ImagePayload } from "@/lib/images/schemas";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

function samePromptDocument(
  left: SerializedPromptDoc,
  right: SerializedPromptDoc,
): boolean {
  return (
    left.prompt === right.prompt &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => {
      const other = right.images[index];
      return (
        other !== undefined &&
        image.attachmentId === other.attachmentId &&
        image.mediaType === other.mediaType &&
        image.base64Data === other.base64Data &&
        image.inlineMarkerIndex === other.inlineMarkerIndex
      );
    })
  );
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
  suppressPendingPromptAutosaveAfterSubmit: () => void;
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
    submittedPendingPromptText?: string,
  ) => Promise<void>;
  queueMessage: (
    text: string,
    images?: ImagePayload[],
    submittedPendingPromptText?: string,
  ) => Promise<void>;
  queueCapabilityForBackend?: (backend: AgentBackendId) => QueueCapability;
  collaborationStartMutation: {
    mutate: (
      input: {
        brief: string;
        submittedPendingPromptText: string;
        negotiationRounds: number;
        autonomousResolutionThreshold: "none" | "minor" | "major" | "blocking";
        conversationId: string;
        backend?: AgentBackendId;
        modelId?: string;
        effort?: string;
        images?: ImagePayload[];
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
  handleDirectPrompt: (text: string) => Promise<void>;
  handleConcurrentConfirm: () => void;
  cancelConcurrentSubmission: () => void;
  pendingConcurrentSubmission: {
    text: string;
    images: ImagePayload[];
    busyNames: string[];
    submittedPendingPromptText: string;
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
  suppressPendingPromptAutosaveAfterSubmit,
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
      submittedPendingPromptText: string;
    } | null>(null);
  const pendingImagesRef = useRef(pendingImages);
  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  const dispatchPrompt = useCallback(
    async (
      text: string,
      images: ImagePayload[],
      submittedPendingPromptText: string,
    ) => {
      suppressPendingPromptAutosaveAfterSubmit();
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
        submittedPendingPromptText,
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
      suppressPendingPromptAutosaveAfterSubmit,
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
      const collabConversationId = conversationId;
      collaborationStartMutation.mutate(
        {
          brief,
          submittedPendingPromptText: serialized.prompt,
          negotiationRounds: effectiveCollabConfig.negotiationRounds,
          autonomousResolutionThreshold:
            effectiveCollabConfig.autonomousResolutionThreshold,
          conversationId: collabConversationId,
          backend: selectedBackend,
          modelId: selectedModel,
          ...(effortSupported ? { effort: selectedEffort } : {}),
          ...(hasImages ? { images: serialized.images } : {}),
        },
        {
          onSuccess: () => {
            const currentDocument = editorRef.current?.serialize(
              pendingImagesRef.current,
            ) ?? { prompt: promptTextRef.current, images: [] };
            if (!samePromptDocument(currentDocument, serialized)) return;
            suppressPendingPromptAutosaveAfterSubmit();
            editorRef.current?.clear();
            setPromptText("");
            clearImages();
            clearCollabConfigDraft(projectName, sessionName, conversationId);
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
          },
        },
      );
      return;
    }

    const imagePayloads: ImagePayload[] = hasImages ? serialized.images : [];

    // A turn is active when this tab's own prompt stream is open (`sending`)
    // OR the conversation's server-side status says a turn is running — e.g. a
    // drained queued turn (Codex next-turn delivery), a turn started before a
    // reload, or one started from another client. Routing on `sending` alone
    // would dispatch a direct prompt into the busy conversation and 409.
    const turnActive =
      sending ||
      conversations?.find((c) => c.id === conversationId)?.status === "running";

    // Queue into running conversation instead of starting a new prompt
    if (turnActive && conversationId) {
      const capability = queueCapabilityForBackend(selectedBackend);
      // The backend can't accept a queued message. Preserve the user's input
      // rather than dropping it into a queue that won't deliver (req 6.2/10.2);
      // the composer gates this case so it is normally unreachable.
      if (!capability.acceptsWhileRunning) return;

      suppressPendingPromptAutosaveAfterSubmit();
      editorRef.current?.clear();
      setPromptText("");
      clearImages();
      await queueMessage(
        trimmedPrompt,
        imagePayloads.length > 0 ? imagePayloads : undefined,
        serialized.prompt,
      );
      return;
    }

    if (turnActive) return;

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
        submittedPendingPromptText: serialized.prompt,
      });
      return;
    }

    await dispatchPrompt(trimmedPrompt, imagePayloads, serialized.prompt);
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
    suppressPendingPromptAutosaveAfterSubmit,
    enqueuePromptErrorToast,
  ]);

  const handleConcurrentConfirm = useCallback(() => {
    if (!pendingConcurrentSubmission) return;
    const { text, images, submittedPendingPromptText } =
      pendingConcurrentSubmission;
    setPendingConcurrentSubmission(null);
    void dispatchPrompt(text, images, submittedPendingPromptText);
  }, [pendingConcurrentSubmission, dispatchPrompt]);

  const cancelConcurrentSubmission = useCallback(() => {
    setPendingConcurrentSubmission(null);
  }, []);

  const handleDirectPrompt = useCallback(
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
    handleDirectPrompt,
    handleConcurrentConfirm,
    cancelConcurrentSubmission,
    pendingConcurrentSubmission,
  };
}
