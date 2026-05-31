"use client";

import type { ComponentProps } from "react";
import type SessionContent from "@/features/session/conversation/SessionContent";
import type { SessionPageViewProps } from "@/features/session/SessionPageView";
import type { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import type { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import type { useCollabContext } from "@/features/session/hooks/use-collab-context";
import { usePromptComposerProps } from "@/features/session/hooks/use-prompt-composer-props";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { CollabConfigDraft } from "@/stores/collaboration.store";

type PromptComposerArgs = Parameters<typeof usePromptComposerProps>[0];
type StoreBundle = ReturnType<typeof useSessionPageStoreBundle>;
type LocalState = ReturnType<typeof useSessionPageLocalState>;
type CollabContext = ReturnType<typeof useCollabContext>;
type PanelContainerProps =
  SessionPageViewProps["contentProps"]["panelContainerProps"];
type SessionContentProps = ComponentProps<typeof SessionContent>;

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
  collab: CollabContext;

  // dev servers
  dsServers: SessionContentProps["dsServers"];
  dsStartServer: SessionContentProps["dsStartServer"];
  dsStopServer: SessionContentProps["dsStopServer"];
  dsStartAll: () => void;
  dsStopAll: () => void;
  dsUnmanagedConflict?: SessionContentProps["dsUnmanagedConflict"];
  dsDismissUnmanagedConflict?: () => void;
  dsStopUnmanagedAndRetry?: () => void;
  dsIsStoppingUnmanaged?: boolean;

  // tdd / layout
  tddEnabled: boolean;
  onTddChange: (val: boolean) => void;
  tddDisabled: boolean;
  onLayoutChange: SessionContentProps["onLayoutChange"];

  // diff/commits/queries
  diff: SessionContentProps["diff"];
  commits: SessionContentProps["commits"];
  cumulativeImageCount: number;
  messagesPending: boolean;
  messages: readonly TranscriptMessage[];

  // panel container inputs
  worktreePath: string | undefined;
  handleDebugPrompt: PanelContainerProps["handleDebugPrompt"];
  handleFork: PanelContainerProps["handleFork"];

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
  stopAndSubmit: () => void;

  // handlers
  handleSendPrompt: PromptComposerArgs["handleSendPrompt"];
  handlePromptTextChange: PromptComposerArgs["handlePromptTextChange"];
  canStop: boolean;
  handleStopPrompt: () => void;
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

  const panelContainerProps: PanelContainerProps = {
    projectName: args.projectName,
    sessionName: args.sessionName,
    conversationId: args.conversationId,
    activeConversation: args.activeConversation,
    conversations: args.conversations,
    messages: args.messages,
    isBusy: args.isBusy,
    isReadOnly: args.isReadOnly,
    isInitConversation: args.isInitConversation,
    hasActiveCollab: args.hasActiveCollab,
    worktreePath: args.worktreePath,
    selectedBackend: args.selectedBackend,
    contextPercent: args.contextPercent,
    messagesPending: args.messagesPending,
    focusConfirmLoading: args.focusConfirmLoading,
    handleConfirmFocus: args.handleConfirmFocus,
    handleDebugPrompt: args.handleDebugPrompt,
    handleFork: args.handleFork,
    canStop: args.canStop,
    onStop: args.handleStopPrompt,
    store,
    local,
    collab: args.collab,
  };

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
    stopAndSubmit: args.stopAndSubmit,
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
      breadcrumbs: [
        { label: "projects", href: "/projects" },
        {
          label: args.decodedProjectName,
          href: `/projects/${encodeURIComponent(args.projectName)}`,
        },
        {
          label: args.session.sessionName,
          href: `/projects/${encodeURIComponent(args.projectName)}/${encodeURIComponent(args.session.sessionName)}`,
          isSession: true,
        },
      ],
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
      panelContainerProps,
      tddEnabled: args.tddEnabled,
      onTddChange: args.onTddChange,
      tddDisabled: args.tddDisabled,
      onLayoutChange: args.onLayoutChange,
      dsOpen: store.dsOpen,
      dsServers: args.dsServers,
      dsClose: store.dsClose,
      dsToggle: store.dsToggle,
      dsStartServer: args.dsStartServer,
      dsStopServer: args.dsStopServer,
      dsStartAll: args.dsStartAll,
      dsStopAll: args.dsStopAll,
      dsUnmanagedConflict: args.dsUnmanagedConflict,
      dsDismissUnmanagedConflict: args.dsDismissUnmanagedConflict,
      dsStopUnmanagedAndRetry: args.dsStopUnmanagedAndRetry,
      dsIsStoppingUnmanaged: args.dsIsStoppingUnmanaged,
      commitDisabled: args.commitDisabled,
      onCommit: store.requestCommit,
      onMerge: store.requestMerge,
      onDelete: store.requestDelete,
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
