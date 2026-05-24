"use client";

import { useCallback } from "react";
import TypingIndicator from "@/features/session/conversation/TypingIndicator";
import { useConversationPanelProps } from "@/features/session/hooks/use-conversation-panel-props";
import { usePromptComposerProps } from "@/features/session/hooks/use-prompt-composer-props";
import type { SessionPageViewProps } from "@/features/session/SessionPageView";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ConversationRow } from "@/features/session/conversation/conversation-rows";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { CollabConfigDraft } from "@/stores/collaboration.store";

type PromptComposerArgs = Parameters<typeof usePromptComposerProps>[0];
type ConversationPanelArgs = Parameters<typeof useConversationPanelProps>[0];
type StoreBundle = ReturnType<typeof useSessionPageStoreBundle>;
type LocalState = ReturnType<typeof useSessionPageLocalState>;
type SessionPageTopbarProps = SessionPageViewProps["topbarProps"];

export interface UseSessionPageViewPropsArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  session: SessionState;
  activeConversation: ConversationState | undefined;
  conversations: ConversationState[] | undefined;
  decodedProjectName: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  buildContext: () => string | null;
  isFinished: boolean;
  isReadOnly: boolean;
  isBusy: boolean;
  isWorkflowManagedConversation: boolean;
  isInitConversation: boolean;
  targetBranch: string;
  branchName: string;
  hasUncommittedChanges: boolean;
  commitDisabled: boolean;
  mergeDisabled: boolean;

  store: StoreBundle;
  local: LocalState;

  // dev servers
  dsServers: SessionPageTopbarProps["dsServers"];
  dsStartServer: SessionPageTopbarProps["dsStartServer"];
  dsStopServer: SessionPageTopbarProps["dsStopServer"];
  dsStartAll: SessionPageTopbarProps["dsStartAll"];
  dsStopAll: SessionPageTopbarProps["dsStopAll"];

  // tdd / layout
  tddEnabled: boolean;
  onTddChange: (val: boolean) => void;
  tddDisabled: boolean;
  onLayoutChange: SessionPageTopbarProps["onLayoutChange"];

  // diff/commits/queries
  diff: SessionPageViewProps["contentProps"]["diff"];
  commits: SessionPageViewProps["contentProps"]["commits"];
  cumulativeImageCount: number;
  messagesPending: boolean;
  rows: ConversationRow[];
  totalMessages: number;
  isCollabPassageInView: boolean;

  // conversation nav
  currentMessageIndex: number;
  handleFirstMessage: () => void;
  handlePrevMessage: () => void;
  handleNextMessage: () => void;
  handleLastMessage: () => void;
  handleRangeChanged: ConversationPanelArgs["handleRangeChanged"];
  handleAtBottomStateChange: ConversationPanelArgs["handleAtBottomStateChange"];
  handleAtTopStateChange: ConversationPanelArgs["handleAtTopStateChange"];

  // renderers
  renderMessageRow: ConversationPanelArgs["renderMessageRow"];
  renderCollabRow: ConversationPanelArgs["renderCollabRow"];

  // focus init
  focusConfirmLoading: boolean;
  handleConfirmFocus: () => void;

  // collab / prompt
  hasActiveCollab: boolean;
  hasCollabChip: boolean;
  effectiveCollabConfig: CollabConfigDraft;
  originatingCollabAgent: PromptComposerArgs["originatingCollabAgent"];
  setCollabConfigDraft: PromptComposerArgs["setCollabConfigDraft"];
  clearCollabConfigDraft: PromptComposerArgs["clearCollabConfigDraft"];

  // backend/model/effort
  backendLocked: boolean;
  selectedBackend: PromptComposerArgs["selectedBackend"];
  selectedModel: string;
  selectedEffort: EffortLevel;
  availableEffortLevels: EffortLevel[];
  effortSupported: boolean;
  setSelectedEffort: (effort: EffortLevel) => void;
  handleBackendChange: PromptComposerArgs["handleBackendChange"];
  handleModelChange: PromptComposerArgs["handleModelChange"];

  // voice
  isRecording: boolean;
  isProcessing: boolean;
  voiceAvailable: boolean;
  elapsedTime: number;
  toggleRecording: () => void;

  // handlers
  handleSendPrompt: PromptComposerArgs["handleSendPrompt"];
  handlePromptTextChange: PromptComposerArgs["handlePromptTextChange"];
  handleAnswerSubmit: SessionPageViewProps["promptInputSlotProps"]["handleAnswerSubmit"];
  handleDelete: () => void;
  handleConcurrentConfirm: () => void;
  cancelConcurrentSubmission: () => void;
  pendingConcurrentSubmission: SessionPageViewProps["dialogsProps"]["pendingConcurrentSubmission"];

  // mutations
  debugToggleMutation: PromptComposerArgs["debugToggleMutation"];
}

export function useSessionPageViewProps(
  args: UseSessionPageViewPropsArgs,
): SessionPageViewProps {
  const { store, local } = args;
  const typingIndicatorVisible =
    !args.hasActiveCollab &&
    (store.sending || args.activeConversation?.status === "running");
  const renderTypingIndicator = useCallback(
    () => (
      <TypingIndicator
        selectedBackend={args.selectedBackend}
        visible={typingIndicatorVisible}
      />
    ),
    [args.selectedBackend, typingIndicatorVisible],
  );

  const conversationPanelProps = useConversationPanelProps({
    conversations: args.conversations,
    activeConversation: args.activeConversation,
    openMobileSidebar: local.openMobileSidebar,
    currentMessageIndex: args.currentMessageIndex,
    totalMessages: args.totalMessages,
    handleFirstMessage: args.handleFirstMessage,
    handlePrevMessage: args.handlePrevMessage,
    handleNextMessage: args.handleNextMessage,
    handleLastMessage: args.handleLastMessage,
    contextPercent: args.contextPercent,
    promptError: store.promptError,
    promptCancelled: store.promptCancelled,
    dismissError: store.dismissError,
    dismissCancelled: store.dismissCancelled,
    panelBodyRef: local.panelBodyRef,
    selectedBackend: args.selectedBackend,
    setCollabPinnedTopTarget: local.setCollabPinnedTopTarget,
    isCollabPassageInView: args.isCollabPassageInView,
    messagesPending: args.messagesPending,
    rows: args.rows,
    virtuosoRef: local.virtuosoRef,
    conversationId: args.conversationId,
    renderMessageRow: args.renderMessageRow,
    renderCollabRow: args.renderCollabRow,
    renderTypingIndicator,
    handleRangeChanged: args.handleRangeChanged,
    handleAtBottomStateChange: args.handleAtBottomStateChange,
    handleAtTopStateChange: args.handleAtTopStateChange,
    showFocusConfirmation:
      args.isInitConversation &&
      !store.pendingQuestions &&
      (!args.isBusy || args.focusConfirmLoading) &&
      (args.activeConversation?.promptCount ?? 0) > 0,
    focusConfirmLoading: args.focusConfirmLoading,
    handleConfirmFocus: args.handleConfirmFocus,
    isReadOnly: args.isReadOnly,
  });

  const promptComposerProps = usePromptComposerProps({
    projectName: args.projectName,
    sessionName: args.sessionName,
    conversationId: args.conversationId,
    activeConversation: args.activeConversation,
    editorRef: local.editorRef,
    fileInputRef: local.fileInputRef,
    promptText: local.promptText,
    handlePromptTextChange: args.handlePromptTextChange,
    setPromptText: local.setPromptText,
    handleSendPrompt: args.handleSendPrompt,
    pendingImages: local.pendingImages,
    inlineMarkerIds: local.inlineMarkerIds,
    setInlineMarkerIds: local.setInlineMarkerIds,
    addImage: local.addImage,
    removeImage: local.removeImage,
    isAtLimit: local.isAtLimit,
    cumulativeImageCount: args.cumulativeImageCount,
    failPrompt: store.failPrompt,
    showPlaceholder: store.showPlaceholder,
    promptPlaceholder: store.promptPlaceholder,
    isReadOnly: args.isReadOnly,
    isFinished: args.isFinished,
    sending: store.sending,
    hasActiveCollab: args.hasActiveCollab,
    isRecording: args.isRecording,
    isProcessing: args.isProcessing,
    voiceAvailable: args.voiceAvailable,
    elapsedTime: args.elapsedTime,
    toggleRecording: args.toggleRecording,
    backendLocked: args.backendLocked,
    selectedBackend: args.selectedBackend,
    handleBackendChange: args.handleBackendChange,
    selectedModel: args.selectedModel,
    handleModelChange: args.handleModelChange,
    selectedEffort: args.selectedEffort,
    setSelectedEffort: args.setSelectedEffort,
    availableEffortLevels: args.availableEffortLevels,
    effortSupported: args.effortSupported,
    hasCollabChip: args.hasCollabChip,
    effectiveCollabConfig: args.effectiveCollabConfig,
    originatingCollabAgent: args.originatingCollabAgent,
    setCollabConfigDraft: args.setCollabConfigDraft,
    clearCollabConfigDraft: args.clearCollabConfigDraft,
    debugToggleMutation: args.debugToggleMutation,
  });

  return {
    mobilePanel: store.mobilePanel,
    topbarProps: {
      projectName: args.projectName,
      sessionName: args.session.sessionName,
      decodedProjectName: args.decodedProjectName,
      statusDotClass: args.statusDotClass,
      displayStatus: args.displayStatus,
      tddEnabled: args.tddEnabled,
      onTddChange: args.onTddChange,
      tddDisabled: args.tddDisabled,
      layout: store.layout,
      onLayoutChange: args.onLayoutChange,
      dsOpen: store.dsOpen,
      dsServers: args.dsServers,
      dsClose: store.dsClose,
      dsToggle: store.dsToggle,
      dsStartServer: args.dsStartServer,
      dsStopServer: args.dsStopServer,
      dsStartAll: args.dsStartAll,
      dsStopAll: args.dsStopAll,
      commitDisabled: args.commitDisabled,
      mergeDisabled: args.mergeDisabled,
      targetBranch: args.targetBranch,
      onCommit: store.requestCommit,
      onMerge: store.requestMerge,
      onDelete: store.requestDelete,
    },
    contentProps: {
      session: args.session,
      activeConversation: args.activeConversation,
      conversations: args.conversations,
      projectName: args.projectName,
      sessionName: args.sessionName,
      conversationId: args.conversationId,
      statusDotClass: args.statusDotClass,
      displayStatus: args.displayStatus,
      contextPercent: args.contextPercent,
      buildContext: args.buildContext,
      isFinished: args.isFinished,
      targetBranch: args.targetBranch,
      sidebarCollapsed: store.sidebarCollapsed,
      toggleSidebar: store.toggleSidebar,
      mobileSidebarOpen: local.mobileSidebarOpen,
      closeMobileSidebar: local.closeMobileSidebar,
      layout: store.layout,
      mobilePanel: store.mobilePanel,
      diff: args.diff,
      commits: args.commits,
      conversationPanelProps,
    },
    promptInputSlotProps: {
      isWorkflowManagedConversation: args.isWorkflowManagedConversation,
      pendingQuestions: store.pendingQuestions,
      pendingQuestionId: store.pendingQuestionId,
      currentQuestionIndex: store.currentQuestionIndex,
      navigateQuestion: store.navigateQuestion,
      handleAnswerSubmit: args.handleAnswerSubmit,
      promptComposerProps,
    },
    mobileBottomBarProps: {
      mobilePanel: store.mobilePanel,
      onSwitchPanel: store.switchMobilePanel,
      tddEnabled: args.tddEnabled,
      onTddToggle: args.onTddChange,
      tddDisabled: args.tddDisabled,
      commitDisabled: args.commitDisabled,
      mergeDisabled: args.mergeDisabled,
      targetBranch: args.targetBranch,
      onCommit: store.requestCommit,
      onMerge: store.requestMerge,
      onDelete: store.requestDelete,
      devServerCounts: {
        running: args.dsServers.filter((s) => s.status === "running").length,
        total: args.dsServers.length,
      },
      onDevServers: store.dsToggle,
    },
    dialogsProps: {
      projectName: args.projectName,
      sessionName: args.session.sessionName,
      branchName: args.branchName,
      targetBranch: args.targetBranch,
      commitCount: args.commits.length,
      hasUncommittedChanges: args.hasUncommittedChanges,
      pendingConcurrentSubmission: args.pendingConcurrentSubmission,
      onDeleteConfirm: args.handleDelete,
      onConcurrentConfirm: args.handleConcurrentConfirm,
      onConcurrentCancel: args.cancelConcurrentSubmission,
    },
  };
}
