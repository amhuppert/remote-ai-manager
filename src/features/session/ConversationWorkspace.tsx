"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { deriveSessionStatus } from "@/lib/sessions/derived";
import { isSessionNotFoundError } from "@/lib/sessions/queries";
import { useDebugModeToggleMutation } from "@/lib/debug-log/mutations";
import { useCollaborationStartMutation } from "@/lib/workflows/mutations";
import { usePendingPromptPersistence } from "@/features/session/hooks/use-pending-prompt-persistence";
import { useTddToggleMutation } from "@/lib/sessions/mutations";
import { useSessionPageHandlers } from "@/features/session/hooks/use-session-page-handlers";
import { useSessionLifecycle } from "@/features/session/hooks/use-session-lifecycle";
import { computeContextFillPercent } from "@/lib/conversations/context-fill";
import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useAbortPrompt } from "@/hooks/use-abort-prompt";
import ConversationWorkspaceView from "@/features/session/ConversationWorkspaceView";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import { type EffortLevel } from "@/lib/agent-backends/schemas";
import { useBackendModelEffort } from "@/features/session/hooks/use-backend-model-effort";
import { useImageIndexCountQuery } from "@/hooks/use-image-index-count";
import { useDevServers } from "@/hooks/use-dev-servers";
import { useClearInputHotkey } from "@/features/session/hooks/use-clear-input-hotkey";
import { useCollabContext } from "@/features/session/hooks/use-collab-context";
import { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import { useSessionPageDisplay } from "@/features/session/hooks/use-session-page-display";
import { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import { useSessionPageQueries } from "@/features/session/hooks/use-session-page-queries";
import { useSessionPageViewProps } from "@/features/session/hooks/use-session-page-view-props";
import { useApprovalGate } from "@/features/session/hooks/use-approval-gate";
import { useEnqueuePromptErrorToast } from "@/stores/notification.store";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import { CONVERSATIONS_LAYOUT_STORAGE_KEY } from "@/features/session/conversations-page-state";
import { type OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
import { useTabPaneKeyboard } from "@/features/session/tabs/use-tab-pane-keyboard";

export interface ConversationWorkspaceProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  defaultModel: string;
  defaultEffort?: EffortLevel;
  autoFocus?: boolean;
  /**
   * When provided, conversation switches originating inside the workspace
   * (fork open, focus-initialization finalize) are routed through this
   * callback instead of `router.push`, so a host like /conversations can
   * switch in place with the history API (§1.2). When absent, behavior is
   * the per-conversation route's `router.push`.
   */
  onOpenConversation?: (target: { conversationId: string }) => void;
  /**
   * The page-level open-tabs working set + operations, hosted by
   * /conversations. Consumed by SessionContent to render the tab strip and
   * panes grid; absent on the per-conversation route, which has no working set.
   */
  openTabs?: OpenTabsApi;
}

function hasCollabPrefix(text: string): boolean {
  return text === "/collab" || text.startsWith("/collab ");
}

function WorkspaceFallback({ title }: { title: string }): React.JSX.Element {
  return (
    <EmptyState>
      <EmptyStateTitle>{title}</EmptyStateTitle>
    </EmptyState>
  );
}

export default function ConversationWorkspace({
  projectName,
  sessionName,
  conversationId,
  defaultModel,
  defaultEffort = "high",
  autoFocus,
  onOpenConversation,
  openTabs,
}: ConversationWorkspaceProps): React.JSX.Element {
  const router = useRouter();

  const {
    sessionQuery,
    conversationsQuery,
    collaborationListQuery,
    graphWorkflowExecutionQuery,
    messagesQuery,
    rawMessages,
  } = useSessionPageQueries(projectName, sessionName, conversationId);

  const store = useSessionPageStoreBundle();

  const {
    servers: dsServers,
    startServer: dsStartServer,
    stopServer: dsStopServer,
    startAll: dsStartAll,
    stopAll: dsStopAll,
    unmanagedConflict: dsUnmanagedConflict,
    dismissUnmanagedConflict: dsDismissUnmanagedConflict,
    stopUnmanagedAndRetry: dsStopUnmanagedAndRetry,
    isStoppingUnmanaged: dsIsStoppingUnmanaged,
  } = useDevServers(projectName, sessionName);

  const session = sessionQuery.data;
  const conversations = conversationsQuery.data;
  const sessionStatus = session ? deriveSessionStatus(session) : "idle";
  const isFinished = session?.finished ?? false;
  const targetBranch = session?.targetBranch ?? "main";
  const conversationRole = session?.conversations.find(
    (c) => c.id === conversationId,
  )?.role;
  const isWorkflowManagedConversation =
    conversationRole === "iteration" || conversationRole === "validator";

  const activeConversation = useMemo(
    () => session?.conversations.find((c) => c.id === conversationId),
    [session?.conversations, conversationId],
  );
  const isBusy =
    store.sending ||
    sessionStatus === "running" ||
    sessionStatus === "waiting_for_input" ||
    !!store.pendingQuestions;
  const isInitConversation = activeConversation?.role === "initialization";
  const contextPercent = computeContextFillPercent(
    activeConversation?.contextTokens ?? null,
    activeConversation?.contextWindowMax ?? null,
  );

  const tddMutation = useTddToggleMutation(projectName, sessionName);
  const collaborationStartMutation = useCollaborationStartMutation(
    projectName,
    sessionName,
  );
  const enqueuePromptErrorToast = useEnqueuePromptErrorToast();

  const collab = useCollabContext({
    projectName,
    sessionName,
    conversationId,
    collaborationListQuery,
    activeConversation,
    rawMessages,
    openDocById: store.openDocById,
  });
  const {
    hasActiveCollab,
    originatingCollabAgent,
    effectiveCollabConfig,
    setCollabConfigDraft,
    clearCollabConfigDraft,
  } = collab;
  // An undecided approval gate keeps chat live alongside the panel (6.1);
  // once the decision is recorded the standing clears and the workflow-managed
  // read-only treatment returns.
  const approvalGate = useApprovalGate({
    projectName,
    sessionName,
    conversationId,
    execution: graphWorkflowExecutionQuery.data ?? null,
    conversationBusy: activeConversation?.status === "running",
  });
  const isReadOnly =
    isFinished ||
    (isWorkflowManagedConversation && approvalGate === null) ||
    hasActiveCollab;

  const {
    send: sendPrompt,
    queue: queueMessage,
    abortClient,
  } = useSendPrompt(projectName, sessionName, conversationId);
  const abortPrompt = useAbortPrompt(projectName, sessionName, conversationId);

  const local = useSessionPageLocalState();
  const hasCollabChip = hasCollabPrefix(local.promptText);
  const lastUserTurnAgentSettings = useMemo(
    () => selectLastUserTurnAgentSettings(rawMessages),
    [rawMessages],
  );
  const {
    selectedBackend,
    selectedModel,
    selectedEffort,
    availableEffortLevels,
    effortSupported,
    backendLocked,
    setSelectedEffort,
    handleBackendChange,
    handleModelChange,
  } = useBackendModelEffort({
    conversationId,
    activeConversation,
    defaultModel,
    defaultEffort,
    lastUsedModelId: lastUserTurnAgentSettings.modelId,
    lastUsedEffort: lastUserTurnAgentSettings.effort,
  });

  const { handlePromptTextChange, clearPersistedPendingPromptOnSubmit } =
    usePendingPromptPersistence({
      projectName,
      sessionName,
      conversationId,
      activeConversation,
      promptText: local.promptText,
      setPromptText: local.setPromptText,
      promptTextRef: local.promptTextRef,
      editorRef: local.editorRef,
    });

  const cumulativeImageCountQuery = useImageIndexCountQuery(
    projectName,
    sessionName,
    conversationId,
  );
  const cumulativeImageCount = cumulativeImageCountQuery.data ?? 0;
  const debugToggleMutation = useDebugModeToggleMutation(
    projectName,
    sessionName,
    conversationId,
  );

  // Stable identity required: useSessionLifecycle's reset effect depends on it,
  // and the three accessors are themselves stable (useCallback / setState /
  // useRef), so destructuring keeps this callback from changing per render.
  const { clearImages, setInlineMarkerIds, fireAndForgetRef } = local;
  const clearDraftComposerState = useCallback(() => {
    clearImages();
    setInlineMarkerIds([]);
    fireAndForgetRef.current = false;
  }, [clearImages, setInlineMarkerIds, fireAndForgetRef]);

  useSessionLifecycle({
    resetConversationState: store.resetConversationState,
    clearDraftComposerState,
    clearConversationMessages: store.clearConversationMessages,
    conversationId,
    session,
    pendingQuestionId: store.pendingQuestionId,
    showQuestions: store.showQuestions,
    clearQuestions: store.clearQuestions,
    autoFocus,
    sendPrompt,
    messagesLength: rawMessages.length,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
  });

  const conversationRunning =
    activeConversation?.status === "running" ||
    activeConversation?.status === "waiting_for_input";
  // Suppress Stop when the active turn is workflow-driven (e.g. smart-merge's
  // validation-fix task_run) so users can't abort background work from the
  // conversation header — that button only stops the panel's user turn.
  const conversationDrivenByWorkflow =
    activeConversation?.activeTurnSource === "workflow";
  const canStop =
    (store.sending || conversationRunning) && !conversationDrivenByWorkflow;
  const handleStopPrompt = useCallback(() => {
    if (store.sending) abortClient();
    void abortPrompt();
  }, [store.sending, abortClient, abortPrompt]);
  useClearInputHotkey({
    editorRef: local.editorRef,
    setPromptText: local.setPromptText,
    clearPlaceholder: store.clearPlaceholder,
    clearImages: local.clearImages,
    isPromptFocused: useCallback(
      () => local.editorRef.current?.editor?.isFocused ?? false,
      [local.editorRef],
    ),
  });

  const handleLayoutChange = useCallback(
    (mode: Parameters<typeof store.switchLayout>[0]) => {
      store.switchLayout(mode, CONVERSATIONS_LAYOUT_STORAGE_KEY);
    },
    [store],
  );

  // Bind tab-activation (mod+1…9) and panes-exit (Escape) shortcuts. On the
  // per-conversation route `openTabs` is undefined: the empty working set plus
  // the non-panes layout make both shortcuts inert.
  useTabPaneKeyboard({
    workingSet: openTabs?.workingSet ?? [],
    activate: openTabs?.activate ?? (() => {}),
    layout: store.layout,
    onExitPanes: () => handleLayoutChange("default"),
  });

  const {
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
    stopAndSubmit,
  } = useSessionPageHandlers({
    projectName,
    sessionName,
    conversationId,
    session,
    conversations,
    router,
    store,
    local,
    isBusy,
    messagesLength: rawMessages.length,
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
    enqueuePromptErrorToast,
    onOpenConversation,
  });

  const { displayStatus, statusDotClass } = useSessionPageDisplay({
    projectName,
    isFinished,
    pendingQuestions: store.pendingQuestions,
    sending: store.sending,
    sessionStatus,
  });

  if (isSessionNotFoundError(sessionQuery.error)) {
    return <WorkspaceFallback title="Session not found." />;
  }

  if (sessionQuery.isPending || !session) {
    return <WorkspaceFallback title="Loading session..." />;
  }

  return (
    <WorkspaceContent
      args={{
        projectName,
        sessionName,
        conversationId,
        session,
        activeConversation,
        conversations,
        statusDotClass,
        displayStatus,
        contextPercent,
        buildContext,
        isFinished,
        isReadOnly,
        isBusy,
        isWorkflowManagedConversation,
        approvalGate,
        isInitConversation,
        targetBranch,
        openTabs,
        store,
        local,
        collab,
        dsServers,
        dsStartServer,
        dsStopServer,
        dsStartAll,
        dsStopAll,
        dsUnmanagedConflict,
        dsDismissUnmanagedConflict,
        dsStopUnmanagedAndRetry,
        dsIsStoppingUnmanaged,
        tddEnabled: session.tddEnabled,
        onTddChange: (val) => tddMutation.mutate(val),
        tddDisabled: tddMutation.isPending,
        onLayoutChange: handleLayoutChange,
        cumulativeImageCount,
        messagesPending: messagesQuery.isPending,
        messages: rawMessages,
        worktreePath: session.worktreePath,
        handleDebugPrompt,
        handleFork,
        focusConfirmLoading,
        handleConfirmFocus,
        hasActiveCollab,
        hasCollabChip,
        effectiveCollabConfig,
        originatingCollabAgent,
        setCollabConfigDraft,
        clearCollabConfigDraft,
        backendLocked,
        selectedBackend,
        selectedModel,
        selectedEffort,
        availableEffortLevels,
        effortSupported,
        setSelectedEffort,
        handleBackendChange,
        handleModelChange,
        isRecording,
        isProcessing,
        voiceAvailable,
        elapsedTime,
        toggleRecording,
        stopAndSubmit,
        handleSendPrompt,
        handlePromptTextChange,
        canStop,
        handleStopPrompt,
        handleAnswerSubmit,
        handleDelete,
        handleConcurrentConfirm,
        cancelConcurrentSubmission,
        pendingConcurrentSubmission,
        debugToggleMutation,
      }}
    />
  );
}

function WorkspaceContent({
  args,
}: {
  args: Parameters<typeof useSessionPageViewProps>[0];
}): React.JSX.Element {
  const viewProps = useSessionPageViewProps(args);
  return <ConversationWorkspaceView {...viewProps} />;
}
