"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { deriveSessionStatus } from "@/lib/sessions/derived";
import { isSessionNotFoundError } from "@/lib/sessions/queries";
import { useDebugModeToggleMutation } from "@/lib/debug-log/mutations";
import { useCollaborationStartMutation } from "@/lib/workflows/mutations";
import { usePendingPromptPersistence } from "@/hooks/use-pending-prompt-persistence";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { useTddToggleMutation } from "@/lib/sessions/mutations";
import { useSessionPageHandlers } from "@/features/session/hooks/use-session-page-handlers";
import { useSessionLifecycle } from "@/features/session/hooks/use-session-lifecycle";
import { canStopTurn } from "@/lib/conversations/turn-activity";
import { computeContextFillPercent } from "@/lib/conversations/context-fill";
import { hasCollabPrefix } from "@/lib/conversation-commands/parse";
import { isWorkflowLaneRole } from "@/lib/conversations/schemas";
import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useAbortPrompt } from "@/hooks/use-abort-prompt";
import ConversationWorkspaceView from "@/features/session/ConversationWorkspaceView";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import { useBackendModelSelection } from "@/features/session/hooks/use-backend-model-selection";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import { useImageIndexCountQuery } from "@/hooks/use-image-index-count";
import { useDevServers } from "@/hooks/use-dev-servers";
import { useClearInputHotkey } from "@/hooks/use-clear-input-hotkey";
import { useCollabContext } from "@/features/session/hooks/use-collab-context";
import { useSessionPageStoreBundle } from "@/features/session/hooks/use-session-page-store-bundle";
import { useSessionPageDisplay } from "@/features/session/hooks/use-session-page-display";
import { useSessionPageLocalState } from "@/features/session/hooks/use-session-page-local-state";
import { useSessionPageQueries } from "@/features/session/hooks/use-session-page-queries";
import { useSessionPageViewProps } from "@/features/session/hooks/use-session-page-view-props";
import type { SessionWorkspaceSlices } from "@/features/session/hooks/session-workspace-slices";
import { useApprovalGate } from "@/features/session/hooks/use-approval-gate";
import { useActivatePanelSession } from "@/stores/session-detail.store";
import { useEnqueuePromptErrorToast } from "@/stores/notification.store";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import { CONVERSATIONS_LAYOUT_STORAGE_KEY } from "@/features/session/conversations-page-state";
import { type OpenTabsApi } from "@/features/session/tabs/use-open-tabs";
import { useTabPaneKeyboard } from "@/features/session/tabs/use-tab-pane-keyboard";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { RightPaneTab } from "@/stores/session-detail/types";

export interface ConversationWorkspaceProps {
  projectName: string;
  sessionName: string;
  conversationId: string;
  backendDefaults: BackendSelectionDefaultsById;
  /** Part of the /conversations URL vocabulary (`autoFocus=true`); accepted here but not consumed. */
  autoFocus?: boolean;
  /**
   * When provided, conversation switches originating inside the workspace
   * (e.g. opening a fork) are routed through this callback instead of
   * `router.push`, so a host like /conversations can switch in place with the
   * history API (§1.2). When absent, behavior is the per-conversation route's
   * `router.push`.
   */
  onOpenConversation?: (target: { conversationId: string }) => void;
  /**
   * The page-level open-tabs working set + operations, hosted by
   * /conversations. Consumed by SessionContent to render the tab strip and
   * panes grid; absent on the per-conversation route, which has no working set.
   */
  openTabs?: OpenTabsApi;
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
  backendDefaults,
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

  const store = useSessionPageStoreBundle(conversationId);

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
  const isWorkflowManagedConversation = isWorkflowLaneRole(
    conversationRole ?? null,
  );

  const activeConversation = useMemo(
    () => session?.conversations.find((c) => c.id === conversationId),
    [session?.conversations, conversationId],
  );
  // waiting_for_input is NOT busy: no turn is running while a question pends
  // (async ask, docs/design/cc-cli/03 §4.3) — the user may act freely.
  const isBusy = store.sending || sessionStatus === "running";
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
    backendDefaults,
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
    modelCatalog,
    modelCatalogs,
    modelSelection,
    modelSelectionBlockedReason,
    backendLocked,
    setModelSelection,
    handleBackendChange,
  } = useBackendModelSelection({
    projectName,
    conversationId,
    activeConversation,
    backendDefaults,
    lastUsedSelection: lastUserTurnAgentSettings.modelSelection,
  });

  // Stable identity required: the draft hook's flush and beacon effects key off
  // the target, so a fresh object each render would re-register them per render.
  const draftTarget = useMemo(
    () => sessionConversationTarget(projectName, sessionName, conversationId),
    [projectName, sessionName, conversationId],
  );

  const { handlePromptTextChange, suppressPendingPromptAutosaveAfterSubmit } =
    usePendingPromptPersistence({
      target: draftTarget,
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

  const activatePanelSession = useActivatePanelSession();
  useSessionLifecycle({
    resetConversationState: store.resetConversationState,
    clearDraftComposerState,
    clearConversationMessages: store.clearConversationMessages,
    activatePanelSession,
    projectName,
    sessionName,
    conversationId,
    session,
    pendingQuestionId: store.pendingQuestionId,
    showQuestions: store.showQuestions,
    clearQuestions: store.clearQuestions,
  });

  // Suppress Stop when the active turn is workflow-driven (e.g. smart-merge's
  // validation-fix task_run) so users can't abort background work from the
  // conversation header — that button only stops the panel's user turn.
  const canStop = canStopTurn({
    sending: store.sending,
    status: activeConversation?.status,
    drivenByWorkflow: activeConversation?.activeTurnSource === "workflow",
  });
  const handleStopPrompt = useCallback(() => {
    if (store.sending) abortClient();
    void abortPrompt();
  }, [store.sending, abortClient, abortPrompt]);
  useAppHotkey("stopTurn", handleStopPrompt, { enabled: canStop });
  useClearInputHotkey({
    editorRef: local.editorRef,
    setPromptText: local.setPromptText,
    clearPlaceholder: store.clearPlaceholder,
    clearImages: local.clearImages,
  });

  const handleLayoutChange = useCallback(
    (mode: Parameters<typeof store.switchLayout>[0]) => {
      store.switchLayout(mode, CONVERSATIONS_LAYOUT_STORAGE_KEY);
    },
    [store],
  );

  useAppHotkey("focusComposer", () => local.editorRef.current?.focus(), {
    enabled: !isReadOnly,
  });

  type SessionView = "conversation" | "split" | "panes" | RightPaneTab;
  const [previousView, setPreviousView] = useState<SessionView | null>(null);
  const currentView = (
    store.layout === "conversation" ||
    store.layout === "split" ||
    store.layout === "panes"
      ? store.layout
      : store.rightPaneTab
  ) satisfies SessionView;
  const applyView = useCallback(
    (view: SessionView) => {
      if (view === "conversation") {
        store.switchMobilePanel("chat");
        handleLayoutChange("conversation");
        return;
      }
      if (view === "split") {
        handleLayoutChange("split");
        return;
      }
      if (view === "panes") {
        store.switchMobilePanel("chat");
        handleLayoutChange("panes");
        return;
      }

      if (view === "docs") {
        store.switchMobilePanel("docs");
      } else if (view === "specs") {
        store.switchMobilePanel("specs");
      } else {
        store.switchMobilePanel("diff");
      }
      store.switchRightPaneTab(view);
      handleLayoutChange("diff");
    },
    [handleLayoutChange, store],
  );
  const selectView = useCallback(
    (view: SessionView) => {
      if (view === currentView) return;
      setPreviousView(currentView);
      applyView(view);
    },
    [applyView, currentView],
  );

  useAppHotkey("viewConversation", () => selectView("conversation"));
  useAppHotkey("viewDiff", () => selectView("diff"));
  useAppHotkey("viewDocuments", () => selectView("docs"));
  useAppHotkey("viewAlignment", () => selectView("alignment"));
  useAppHotkey("viewSpecs", () => selectView("specs"));
  useAppHotkey("viewArtifact", () => selectView("artifact"));
  useAppHotkey("viewSplit", () => selectView("split"));
  useAppHotkey(
    "viewPrevious",
    () => {
      if (!previousView) return;
      setPreviousView(currentView);
      applyView(previousView);
    },
    { enabled: previousView !== null },
  );

  // On the per-conversation route `openTabs` is undefined: the empty working
  // set keeps working-set navigation inert.
  useTabPaneKeyboard({
    workingSet: openTabs?.workingSet ?? [],
    activeId: openTabs?.activeId ?? null,
    activate: openTabs?.activate ?? (() => {}),
    closeTab: openTabs?.closeTab ?? (() => {}),
    layout: store.layout,
    onEnterPanes: () => handleLayoutChange("panes"),
    onExitPanes: () => handleLayoutChange("conversation"),
  });

  const {
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
    selectedModelSelection: modelSelection,
    selectedBackend,
    sendPrompt,
    queueMessage,
    collaborationStartMutation,
    effectiveCollabConfig,
    clearCollabConfigDraft,
    suppressPendingPromptAutosaveAfterSubmit,
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

  const slices: SessionWorkspaceSlices = {
    identity: {
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
      targetBranch,
      worktreePath: session.worktreePath,
      messages: rawMessages,
      messagesPending: messagesQuery.isPending,
      cumulativeImageCount,
    },
    prompt: {
      approvalGate,
      handleSendPrompt,
      handlePromptTextChange,
      canStop,
      handleStopPrompt,
      handleAnswerSubmit,
      handleDirectPrompt,
      handleFork,
      debugToggleMutation,
    },
    collaboration: {
      hasActiveCollab,
      hasCollabChip,
      effectiveCollabConfig,
      originatingCollabAgent,
      setCollabConfigDraft,
      clearCollabConfigDraft,
      backendDefaults,
    },
    backendModelSelection: {
      backendLocked,
      selectedBackend,
      handleBackendChange,
      modelCatalog,
      modelCatalogs,
      modelSelection,
      modelSelectionBlockedReason,
      setModelSelection,
    },
    voice: {
      isRecording,
      isProcessing,
      voiceAvailable,
      elapsedTime,
      toggleRecording,
      stopAndSubmit,
    },
    devServers: {
      dsServers,
      dsStartServer,
      dsStopServer,
      dsStartAll,
      dsStopAll,
      dsUnmanagedConflict,
      dsDismissUnmanagedConflict,
      dsStopUnmanagedAndRetry,
      dsIsStoppingUnmanaged,
    },
    layout: {
      tddEnabled: session.tddEnabled,
      onTddChange: (val) => tddMutation.mutate(val),
      tddDisabled: tddMutation.isPending,
      onLayoutChange: handleLayoutChange,
      openTabs,
    },
    dialogActions: {
      handleDelete,
      handleConcurrentConfirm,
      cancelConcurrentSubmission,
      pendingConcurrentSubmission,
    },
    store,
    local,
    collab,
  };

  return <WorkspaceContent slices={slices} />;
}

function WorkspaceContent({
  slices,
}: {
  slices: SessionWorkspaceSlices;
}): React.JSX.Element {
  const viewProps = useSessionPageViewProps(slices);
  return <ConversationWorkspaceView {...viewProps} />;
}
