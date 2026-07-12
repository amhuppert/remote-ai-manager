"use client";

import type { ComponentProps } from "react";
import type SessionContent from "@/features/session/conversation/SessionContent";
import type { ConversationWorkspaceViewProps } from "@/features/session/ConversationWorkspaceView";
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
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";

type PromptComposerArgs = Parameters<typeof usePromptComposerProps>[0];
type StoreBundle = ReturnType<typeof useSessionPageStoreBundle>;
type LocalState = ReturnType<typeof useSessionPageLocalState>;
type CollabContext = ReturnType<typeof useCollabContext>;
type PanelContainerProps =
  ConversationWorkspaceViewProps["contentProps"]["panelContainerProps"];
type SessionContentProps = ComponentProps<typeof SessionContent>;

export interface UseSessionPageViewPropsArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  session: SessionState;
  activeConversation: ConversationState | undefined;
  conversations: ConversationState[] | undefined;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  buildContext: () => string | null;
  isFinished: boolean;
  isReadOnly: boolean;
  isBusy: boolean;
  isWorkflowManagedConversation: boolean;
  approvalGate: ConversationWorkspaceViewProps["promptInputSlotProps"]["approvalGate"];
  targetBranch: string;

  // Page-level open-tabs working set (present only on /conversations); flows
  // into SessionContent's tab strip + panes grid.
  openTabs?: OpenTabsApi;

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

  cumulativeImageCount: number;
  messagesPending: boolean;
  messages: readonly TranscriptMessage[];

  // panel container inputs
  worktreePath: string | undefined;
  handleDebugPrompt: PanelContainerProps["handleDebugPrompt"];
  handleFork: PanelContainerProps["handleFork"];

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
  handleAnswerSubmit: ConversationWorkspaceViewProps["promptInputSlotProps"]["handleAnswerSubmit"];
  handleDelete: () => void;
  handleConcurrentConfirm: () => void;
  cancelConcurrentSubmission: () => void;
  pendingConcurrentSubmission: ConversationWorkspaceViewProps["dialogsProps"]["pendingConcurrentSubmission"];

  // mutations
  debugToggleMutation: PromptComposerArgs["debugToggleMutation"];
}

export function useSessionPageViewProps(
  args: UseSessionPageViewPropsArgs,
): ConversationWorkspaceViewProps {
  const { store, local } = args;

  const panelContainerProps: PanelContainerProps = {
    projectName: args.projectName,
    sessionName: args.sessionName,
    conversationId: args.conversationId,
    activeConversation: args.activeConversation,
    conversations: args.conversations,
    isBusy: args.isBusy,
    isReadOnly: args.isReadOnly,
    hasActiveCollab: args.hasActiveCollab,
    worktreePath: args.worktreePath,
    selectedBackend: args.selectedBackend,
    contextPercent: args.contextPercent,
    handleDebugPrompt: args.handleDebugPrompt,
    handleFork: args.handleFork,
    canStop: args.canStop,
    onStop: args.handleStopPrompt,
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
    isWorkflowManagedConversation: args.isWorkflowManagedConversation,
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
    contentProps: {
      session: args.session,
      activeConversation: args.activeConversation,
      projectName: args.projectName,
      sessionName: args.sessionName,
      conversationId: args.conversationId,
      statusDotClass: args.statusDotClass,
      displayStatus: args.displayStatus,
      contextPercent: args.contextPercent,
      buildContext: args.buildContext,
      isFinished: args.isFinished,
      targetBranch: args.targetBranch,
      layout: store.layout,
      mobilePanel: store.mobilePanel,
      panelContainerProps,
      openTabs: args.openTabs,
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
      onDelete: store.requestDelete,
    },
    promptInputSlotProps: {
      isWorkflowManagedConversation: args.isWorkflowManagedConversation,
      approvalGate: args.approvalGate,
      pendingQuestions: store.pendingQuestions,
      pendingQuestionId: store.pendingQuestionId,
      currentQuestionIndex: store.currentQuestionIndex,
      navigateQuestion: store.navigateQuestion,
      handleAnswerSubmit: args.handleAnswerSubmit,
      agentBackend: args.selectedBackend,
      promptComposerProps,
    },
    mobileBottomBarProps: {
      mobilePanel: store.mobilePanel,
      onSwitchPanel: store.switchMobilePanel,
      tddEnabled: args.tddEnabled,
      onTddToggle: args.onTddChange,
      tddDisabled: args.tddDisabled,
      onDelete: store.requestDelete,
      devServerCounts: {
        running: args.dsServers.filter((s) => s.status === "running").length,
        total: args.dsServers.length,
      },
      onDevServers: store.dsToggle,
    },
    dialogsProps: {
      sessionName: args.session.sessionName,
      pendingConcurrentSubmission: args.pendingConcurrentSubmission,
      onDeleteConfirm: args.handleDelete,
      onConcurrentConfirm: args.handleConcurrentConfirm,
      onConcurrentCancel: args.cancelConcurrentSubmission,
    },
  };
}
