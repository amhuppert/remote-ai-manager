"use client";

import type { ConversationWorkspaceViewProps } from "@/features/session/ConversationWorkspaceView";
import { usePromptComposerProps } from "@/features/session/hooks/use-prompt-composer-props";
import type {
  SessionWorkspaceSlices,
  PromptExecutionSlice,
  CollaborationSlice,
  BackendModelEffortSlice,
  VoiceSlice,
} from "@/features/session/hooks/session-workspace-slices";

type PanelContainerProps =
  ConversationWorkspaceViewProps["contentProps"]["panelContainerProps"];

export function useSessionPageViewProps(
  slices: SessionWorkspaceSlices,
): ConversationWorkspaceViewProps {
  const {
    identity,
    prompt,
    collaboration,
    backendModelEffort,
    voice,
    devServers,
    layout,
    dialogActions,
    store,
    local,
    collab,
  } = slices;

  const panelContainerProps: PanelContainerProps = {
    projectName: identity.projectName,
    sessionName: identity.sessionName,
    conversationId: identity.conversationId,
    activeConversation: identity.activeConversation,
    conversations: identity.conversations,
    isBusy: identity.isBusy,
    isReadOnly: identity.isReadOnly,
    hasActiveCollab: collaboration.hasActiveCollab,
    worktreePath: identity.worktreePath,
    selectedBackend: backendModelEffort.selectedBackend,
    contextPercent: identity.contextPercent,
    handleDirectPrompt: prompt.handleDirectPrompt,
    handleFork: prompt.handleFork,
    canStop: prompt.canStop,
    onStop: prompt.handleStopPrompt,
    local,
    collab,
  };

  const promptComposerProps = useComposerProps(
    identity,
    prompt,
    collaboration,
    backendModelEffort,
    voice,
    store,
    local,
  );

  // The Actions-menu Rebase button submits `/rebase` exactly as if the user
  // typed it (the SDK driver intercepts the command before any agent turn),
  // rebasing onto the session's configured target branch. Omitted (disabling
  // the item) while the session is read-only or a turn is in flight, since the
  // direct submit does not queue.
  const onRebase =
    identity.isReadOnly || identity.isBusy
      ? undefined
      : () => {
          void prompt.handleDirectPrompt("/rebase");
        };

  return {
    contentProps: {
      session: identity.session,
      activeConversation: identity.activeConversation,
      projectName: identity.projectName,
      sessionName: identity.sessionName,
      conversationId: identity.conversationId,
      statusDotClass: identity.statusDotClass,
      displayStatus: identity.displayStatus,
      contextPercent: identity.contextPercent,
      buildContext: identity.buildContext,
      isFinished: identity.isFinished,
      targetBranch: identity.targetBranch,
      layout: store.layout,
      mobilePanel: store.mobilePanel,
      panelContainerProps,
      openTabs: layout.openTabs,
      tddEnabled: layout.tddEnabled,
      onTddChange: layout.onTddChange,
      tddDisabled: layout.tddDisabled,
      onLayoutChange: layout.onLayoutChange,
      dsOpen: store.dsOpen,
      dsServers: devServers.dsServers,
      dsClose: store.dsClose,
      dsToggle: store.dsToggle,
      dsStartServer: devServers.dsStartServer,
      dsStopServer: devServers.dsStopServer,
      dsStartAll: devServers.dsStartAll,
      dsStopAll: devServers.dsStopAll,
      dsUnmanagedConflict: devServers.dsUnmanagedConflict,
      dsDismissUnmanagedConflict: devServers.dsDismissUnmanagedConflict,
      dsStopUnmanagedAndRetry: devServers.dsStopUnmanagedAndRetry,
      dsIsStoppingUnmanaged: devServers.dsIsStoppingUnmanaged,
      onDelete: store.requestDelete,
      onRebase,
    },
    promptInputSlotProps: {
      isWorkflowManagedConversation: identity.isWorkflowManagedConversation,
      approvalGate: prompt.approvalGate,
      pendingQuestions: store.pendingQuestions,
      pendingQuestionId: store.pendingQuestionId,
      currentQuestionIndex: store.currentQuestionIndex,
      navigateQuestion: store.navigateQuestion,
      handleAnswerSubmit: prompt.handleAnswerSubmit,
      agentBackend: backendModelEffort.selectedBackend,
      promptComposerProps,
    },
    mobileBottomBarProps: {
      mobilePanel: store.mobilePanel,
      onSwitchPanel: store.switchMobilePanel,
      tddEnabled: layout.tddEnabled,
      onTddToggle: layout.onTddChange,
      tddDisabled: layout.tddDisabled,
      onDelete: store.requestDelete,
      devServerCounts: {
        running: devServers.dsServers.filter((s) => s.status === "running")
          .length,
        total: devServers.dsServers.length,
      },
      onDevServers: store.dsToggle,
    },
    dialogsProps: {
      sessionName: identity.session.sessionName,
      pendingConcurrentSubmission: dialogActions.pendingConcurrentSubmission,
      onDeleteConfirm: dialogActions.handleDelete,
      onConcurrentConfirm: dialogActions.handleConcurrentConfirm,
      onConcurrentCancel: dialogActions.cancelConcurrentSubmission,
    },
  };
}

function useComposerProps(
  identity: SessionWorkspaceSlices["identity"],
  prompt: PromptExecutionSlice,
  collaboration: CollaborationSlice,
  backendModelEffort: BackendModelEffortSlice,
  voice: VoiceSlice,
  store: SessionWorkspaceSlices["store"],
  local: SessionWorkspaceSlices["local"],
) {
  return usePromptComposerProps({
    projectName: identity.projectName,
    sessionName: identity.sessionName,
    conversationId: identity.conversationId,
    activeConversation: identity.activeConversation,
    editorRef: local.editorRef,
    fileInputRef: local.fileInputRef,
    promptText: local.promptText,
    handlePromptTextChange: prompt.handlePromptTextChange,
    setPromptText: local.setPromptText,
    handleSendPrompt: prompt.handleSendPrompt,
    pendingImages: local.pendingImages,
    inlineMarkerIds: local.inlineMarkerIds,
    setInlineMarkerIds: local.setInlineMarkerIds,
    addImage: local.addImage,
    removeImage: local.removeImage,
    isAtLimit: local.isAtLimit,
    cumulativeImageCount: identity.cumulativeImageCount,
    failPrompt: store.failPrompt,
    showPlaceholder: store.showPlaceholder,
    promptPlaceholder: store.promptPlaceholder,
    isReadOnly: identity.isReadOnly,
    isFinished: identity.isFinished,
    isWorkflowManagedConversation: identity.isWorkflowManagedConversation,
    sending: store.sending,
    hasActiveCollab: collaboration.hasActiveCollab,
    isRecording: voice.isRecording,
    isProcessing: voice.isProcessing,
    voiceAvailable: voice.voiceAvailable,
    elapsedTime: voice.elapsedTime,
    toggleRecording: voice.toggleRecording,
    stopAndSubmit: voice.stopAndSubmit,
    backendLocked: backendModelEffort.backendLocked,
    selectedBackend: backendModelEffort.selectedBackend,
    handleBackendChange: backendModelEffort.handleBackendChange,
    selectedModel: backendModelEffort.selectedModel,
    handleModelChange: backendModelEffort.handleModelChange,
    selectedEffort: backendModelEffort.selectedEffort,
    setSelectedEffort: backendModelEffort.setSelectedEffort,
    availableEffortLevels: backendModelEffort.availableEffortLevels,
    effortSupported: backendModelEffort.effortSupported,
    hasCollabChip: collaboration.hasCollabChip,
    effectiveCollabConfig: collaboration.effectiveCollabConfig,
    originatingCollabAgent: collaboration.originatingCollabAgent,
    setCollabConfigDraft: collaboration.setCollabConfigDraft,
    clearCollabConfigDraft: collaboration.clearCollabConfigDraft,
    debugToggleMutation: prompt.debugToggleMutation,
  });
}
