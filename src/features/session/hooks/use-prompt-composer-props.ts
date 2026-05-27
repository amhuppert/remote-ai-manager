"use client";

import {
  useMemo,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type PromptComposer from "@/features/session/prompt/PromptComposer";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { CollabConfigDraft } from "@/stores/collaboration.store";
import type {
  ImageAttachment,
  AddImageResult,
} from "@/hooks/use-image-attachments";

type PromptComposerProps = React.ComponentProps<typeof PromptComposer>;

function stripCollabPrefix(text: string): string {
  if (text === "/collab") return "";
  if (text.startsWith("/collab ")) return text.slice("/collab ".length);
  return text;
}

export interface UsePromptComposerPropsArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  activeConversation: ConversationState | undefined;
  editorRef: RefObject<PromptEditorHandle | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  promptText: string;
  handlePromptTextChange: (text: string) => void;
  setPromptText: Dispatch<SetStateAction<string>>;
  handleSendPrompt: () => Promise<void>;
  pendingImages: ImageAttachment[];
  inlineMarkerIds: string[];
  setInlineMarkerIds: Dispatch<SetStateAction<string[]>>;
  addImage: (file: File | Blob, fileName?: string) => Promise<AddImageResult>;
  removeImage: (id: string) => void;
  isAtLimit: boolean;
  cumulativeImageCount: number;
  failPrompt: (message: string) => void;
  showPlaceholder: (text: string) => void;
  promptPlaceholder: string | null;
  isReadOnly: boolean;
  isFinished: boolean;
  sending: boolean;
  hasActiveCollab: boolean;
  isRecording: boolean;
  isProcessing: boolean;
  voiceAvailable: boolean;
  elapsedTime: number;
  toggleRecording: () => void;
  stopAndSubmit: () => void;
  backendLocked: boolean;
  selectedBackend: AgentBackendId;
  handleBackendChange: (backend: AgentBackendId) => void;
  selectedModel: string;
  handleModelChange: (model: string) => void;
  selectedEffort: EffortLevel;
  setSelectedEffort: (effort: EffortLevel) => void;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  hasCollabChip: boolean;
  effectiveCollabConfig: CollabConfigDraft;
  originatingCollabAgent: "claude" | "codex";
  setCollabConfigDraft: (
    project: string,
    session: string,
    conversation: string,
    next: CollabConfigDraft,
  ) => void;
  clearCollabConfigDraft: (
    project: string,
    session: string,
    conversation: string,
  ) => void;
  debugToggleMutation: {
    isPending: boolean;
    mutate: (action: "enter" | "exit") => void;
  };
}

export function usePromptComposerProps(
  args: UsePromptComposerPropsArgs,
): PromptComposerProps {
  const {
    projectName,
    sessionName,
    conversationId,
    activeConversation,
    editorRef,
    fileInputRef,
    promptText,
    handlePromptTextChange,
    setPromptText,
    handleSendPrompt,
    pendingImages,
    inlineMarkerIds,
    setInlineMarkerIds,
    addImage,
    removeImage,
    isAtLimit,
    cumulativeImageCount,
    failPrompt,
    showPlaceholder,
    promptPlaceholder,
    isReadOnly,
    isFinished,
    sending,
    hasActiveCollab,
    isRecording,
    isProcessing,
    voiceAvailable,
    elapsedTime,
    toggleRecording,
    stopAndSubmit,
    backendLocked,
    selectedBackend,
    handleBackendChange,
    selectedModel,
    handleModelChange,
    selectedEffort,
    setSelectedEffort,
    availableEffortLevels,
    effortSupported,
    hasCollabChip,
    effectiveCollabConfig,
    originatingCollabAgent,
    setCollabConfigDraft,
    clearCollabConfigDraft,
    debugToggleMutation,
  } = args;
  return useMemo<PromptComposerProps>(
    () => ({
      projectName,
      sessionName,
      conversationId,
      activeConversation,
      editorRef,
      fileInputRef,
      promptText,
      onPromptTextChange: handlePromptTextChange,
      onSendPrompt: () => void handleSendPrompt(),
      pendingImages,
      inlineMarkerIds,
      onInlineMarkersChange: setInlineMarkerIds,
      addImage,
      removeImage,
      isAtLimit,
      cumulativeImageCount,
      failPrompt,
      showPlaceholder,
      promptPlaceholder,
      isReadOnly,
      isFinished,
      sending,
      hasActiveCollab,
      isRecording,
      isProcessing,
      voiceAvailable,
      elapsedTime,
      toggleRecording,
      stopAndSubmit,
      backendLocked,
      selectedBackend,
      onBackendChange: handleBackendChange,
      selectedModel,
      onModelChange: handleModelChange,
      selectedEffort,
      onEffortChange: setSelectedEffort,
      availableEffortLevels,
      effortSupported,
      hasCollabChip,
      effectiveCollabConfig,
      originatingCollabAgent,
      onCollabConfigChange: (next: CollabConfigDraft) =>
        setCollabConfigDraft(projectName, sessionName, conversationId, next),
      onCollabDismiss: () => {
        setPromptText(stripCollabPrefix(promptText));
        clearCollabConfigDraft(projectName, sessionName, conversationId);
      },
      onDebugToggle: () =>
        debugToggleMutation.mutate(
          activeConversation?.debugMode?.active ? "exit" : "enter",
        ),
      debugTogglePending: debugToggleMutation.isPending,
    }),
    [
      projectName,
      sessionName,
      conversationId,
      activeConversation,
      editorRef,
      fileInputRef,
      promptText,
      handlePromptTextChange,
      handleSendPrompt,
      pendingImages,
      inlineMarkerIds,
      setInlineMarkerIds,
      addImage,
      removeImage,
      isAtLimit,
      cumulativeImageCount,
      failPrompt,
      showPlaceholder,
      promptPlaceholder,
      isReadOnly,
      isFinished,
      sending,
      hasActiveCollab,
      isRecording,
      isProcessing,
      voiceAvailable,
      elapsedTime,
      toggleRecording,
      stopAndSubmit,
      backendLocked,
      selectedBackend,
      handleBackendChange,
      selectedModel,
      handleModelChange,
      selectedEffort,
      setSelectedEffort,
      availableEffortLevels,
      effortSupported,
      hasCollabChip,
      effectiveCollabConfig,
      originatingCollabAgent,
      setCollabConfigDraft,
      setPromptText,
      clearCollabConfigDraft,
      debugToggleMutation,
    ],
  );
}
