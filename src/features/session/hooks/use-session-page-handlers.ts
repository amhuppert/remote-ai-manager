"use client";

import type { useRouter } from "next/navigation";
import {
  useAnswerQuestionMutation,
  useForkConversationMutation,
} from "@/lib/conversations/mutations";
import { useDeleteSessionMutation } from "@/lib/sessions/mutations";
import { usePromptSubmission } from "@/features/session/hooks/use-prompt-submission";
import { useVoiceWiring } from "@/hooks/use-voice-wiring";
import { useSessionHandlers } from "@/features/session/hooks/use-session-handlers";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { EffectiveCollabConfig } from "@/stores/collaboration.store";

type SubmissionArgs = Parameters<typeof usePromptSubmission>[0];

export interface UseSessionPageHandlersArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  session: SessionState | undefined;
  conversations: ConversationState[] | undefined;
  router: ReturnType<typeof useRouter>;
  store: ReturnType<typeof useSessionPageStoreBundle>;
  local: ReturnType<typeof useSessionPageLocalState>;
  isBusy: boolean;
  messagesLength: number;
  selectedModel: string;
  selectedEffort: EffortLevel;
  effortSupported: boolean;
  selectedBackend: SubmissionArgs["selectedBackend"];
  selectedCodexFastMode: boolean;
  sendPrompt: SubmissionArgs["sendPrompt"];
  queueMessage: SubmissionArgs["queueMessage"];
  collaborationStartMutation: SubmissionArgs["collaborationStartMutation"];
  effectiveCollabConfig: EffectiveCollabConfig;
  clearCollabConfigDraft: SubmissionArgs["clearCollabConfigDraft"];
  suppressPendingPromptAutosaveAfterSubmit: SubmissionArgs["suppressPendingPromptAutosaveAfterSubmit"];
  enqueuePromptErrorToast: SubmissionArgs["enqueuePromptErrorToast"];
  onOpenConversation?: (target: { conversationId: string }) => void;
}

export function useSessionPageHandlers(args: UseSessionPageHandlersArgs) {
  const {
    projectName,
    sessionName,
    conversationId,
    session,
    conversations,
    router,
    store,
    local,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    selectedCodexFastMode,
    sendPrompt,
    queueMessage,
    collaborationStartMutation,
    effectiveCollabConfig,
    clearCollabConfigDraft,
    suppressPendingPromptAutosaveAfterSubmit,
    enqueuePromptErrorToast,
    onOpenConversation,
  } = args;

  const deleteMutation = useDeleteSessionMutation(projectName);
  const answerMutation = useAnswerQuestionMutation(
    projectName,
    sessionName,
    conversationId,
  );
  const forkConversationMutation = useForkConversationMutation(
    projectName,
    sessionName,
  );

  const {
    handleSendPrompt,
    handleDirectPrompt,
    handleConcurrentConfirm,
    cancelConcurrentSubmission,
    pendingConcurrentSubmission,
  } = usePromptSubmission({
    projectName,
    sessionName,
    conversationId,
    conversations,
    sending: store.sending,
    pendingImages: local.pendingImages,
    promptTextRef: local.promptTextRef,
    editorRef: local.editorRef,
    setPromptText: local.setPromptText,
    clearImages: local.clearImages,
    suppressPendingPromptAutosaveAfterSubmit,
    effectiveCollabConfig,
    clearCollabConfigDraft,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    selectedCodexFastMode,
    sendPrompt,
    queueMessage,
    collaborationStartMutation,
    enqueuePromptErrorToast,
  });

  const { handleAnswerSubmit, handleDelete, handleFork, buildContext } =
    useSessionHandlers({
      projectName,
      sessionName,
      conversationId,
      session,
      router,
      answerMutation,
      deleteMutation,
      forkMutation: forkConversationMutation,
      cancelDelete: store.cancelDelete,
      clearQuestions: store.clearQuestions,
      failPrompt: store.failPrompt,
      onOpenConversation,
    });

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
    stopAndSubmit,
  } = useVoiceWiring({
    projectName,
    promptTextRef: local.promptTextRef,
    editorRef: local.editorRef,
    pendingImages: local.pendingImages,
    fireAndForgetRef: local.fireAndForgetRef,
    handleSendPrompt,
  });

  return {
    handleSendPrompt,
    handleDirectPrompt,
    handleConcurrentConfirm,
    cancelConcurrentSubmission,
    pendingConcurrentSubmission,
    handleAnswerSubmit,
    handleDelete,
    handleFork,
    buildContext,
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
    stopAndSubmit,
  };
}
