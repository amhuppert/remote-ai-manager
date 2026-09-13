"use client";

import {
  useMemo,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type PromptComposer from "@/components/session/prompt/PromptComposer";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { stripCollabPrefix } from "@/lib/conversation-commands/parse";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type {
  CollabConfigDraft,
  EffectiveCollabConfig,
} from "@/stores/collaboration.store";
import type {
  BackendSelectionDefaultsById,
  BackendValueMap,
} from "@/lib/agent-backends/catalog";
import type {
  ImageAttachment,
  AddImageResult,
} from "@/hooks/use-image-attachments";

type PromptComposerProps = React.ComponentProps<typeof PromptComposer>;

export interface UsePromptComposerPropsArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  activeConversation: PublicConversationState | undefined;
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
  isWorkflowManagedConversation: boolean;
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
  modelCatalog: BackendModelCatalog | null;
  modelCatalogs: BackendValueMap<BackendModelCatalog | null>;
  modelSelection: BackendModelSelection;
  modelSelectionBlockedReason: string | null;
  setModelSelection(selection: BackendModelSelection): void;
  hasCollabChip: boolean;
  effectiveCollabConfig: EffectiveCollabConfig;
  /** Null when the conversation's backend cannot take a collaboration lane. */
  originatingCollabAgent: CollaborationAgent | null;
  setCollabConfigDraft: (
    project: string,
    session: string,
    conversation: string,
    next: CollabConfigDraft,
  ) => void;
  collabBackendDefaults: BackendSelectionDefaultsById;
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
    isWorkflowManagedConversation,
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
    modelCatalog,
    modelCatalogs,
    modelSelection,
    modelSelectionBlockedReason,
    setModelSelection,
    hasCollabChip,
    effectiveCollabConfig,
    originatingCollabAgent,
    setCollabConfigDraft,
    clearCollabConfigDraft,
    collabBackendDefaults,
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
      isWorkflowManagedConversation,
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
      modelCatalog,
      modelCatalogs,
      modelSelection,
      modelSelectionBlockedReason,
      onModelSelectionChange: setModelSelection,
      hasCollabChip,
      effectiveCollabConfig,
      originatingCollabAgent,
      collabBackendDefaults,
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
      isWorkflowManagedConversation,
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
      modelCatalog,
      modelCatalogs,
      modelSelection,
      modelSelectionBlockedReason,
      setModelSelection,
      hasCollabChip,
      effectiveCollabConfig,
      originatingCollabAgent,
      setCollabConfigDraft,
      setPromptText,
      clearCollabConfigDraft,
      collabBackendDefaults,
      debugToggleMutation,
    ],
  );
}
