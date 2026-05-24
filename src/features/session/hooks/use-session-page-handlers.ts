"use client";

import type { useRouter } from "next/navigation";
import {
  useAnswerQuestionMutation,
  useForkConversationMutation,
} from "@/lib/conversations/mutations";
import { useDeleteSessionMutation } from "@/lib/sessions/mutations";
import { useFocusInitialization } from "@/features/session/hooks/use-focus-initialization";
import { usePromptSubmission } from "@/features/session/hooks/use-prompt-submission";
import { useVoiceWiring } from "@/features/session/hooks/use-voice-wiring";
import { useSessionHandlers } from "@/features/session/hooks/use-session-handlers";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { CollabConfigDraft } from "@/stores/collaboration.store";

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
  sendPrompt: SubmissionArgs["sendPrompt"];
  queueMessage: SubmissionArgs["queueMessage"];
  collaborationStartMutation: SubmissionArgs["collaborationStartMutation"];
  effectiveCollabConfig: CollabConfigDraft;
  clearCollabConfigDraft: SubmissionArgs["clearCollabConfigDraft"];
  clearPersistedPendingPromptOnSubmit: SubmissionArgs["clearPersistedPendingPromptOnSubmit"];
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
    isBusy,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    sendPrompt,
    queueMessage,
    collaborationStartMutation,
    effectiveCollabConfig,
    clearCollabConfigDraft,
    clearPersistedPendingPromptOnSubmit,
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
    handleDebugPrompt,
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
    collaborationStartMutation,
  });

  const { focusConfirmLoading, handleConfirmFocus } = useFocusInitialization({
    projectName,
    sessionName,
    isBusy,
    messagesLength,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    sendPrompt,
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
    });

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
  } = useVoiceWiring({
    projectName,
    promptTextRef: local.promptTextRef,
    editorRef: local.editorRef,
    fireAndForgetRef: local.fireAndForgetRef,
    handleSendPrompt,
  });

  return {
    handleSendPrompt,
    handleDebugPrompt,
    handleConcurrentConfirm,
    cancelConcurrentSubmission,
    pendingConcurrentSubmission,
    focusConfirmLoading,
    handleConfirmFocus,
    handleAnswerSubmit,
    handleDelete,
    handleFork,
    buildContext,
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
  };
}
