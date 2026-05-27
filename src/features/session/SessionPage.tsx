"use client";

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { deriveSessionStatus } from "@/lib/sessions/derived";
import { useDebugModeToggleMutation } from "@/lib/debug-log/mutations";
import { useCollaborationStartMutation } from "@/lib/workflows/mutations";
import { usePendingPromptPersistence } from "@/features/session/hooks/use-pending-prompt-persistence";
import { useTddToggleMutation } from "@/lib/sessions/mutations";
import { useSessionPageHandlers } from "@/features/session/hooks/use-session-page-handlers";
import { useSessionLifecycle } from "@/features/session/hooks/use-session-lifecycle";
import { computeContextFillPercent } from "@/lib/conversations/context-fill";
import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useAbortPrompt } from "@/hooks/use-abort-prompt";
import LoadingSessionView from "@/features/session/conversation/LoadingSessionView";
import SessionPageView from "@/features/session/SessionPageView";
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

interface Props {
  projectName: string;
  sessionName: string;
  conversationId: string;
  defaultModel: string;
  defaultEffort?: EffortLevel;
  autoFocus?: boolean;
}

function hasCollabPrefix(text: string): boolean {
  return text === "/collab" || text.startsWith("/collab ");
}

export default function ConversationDetailPage({
  projectName,
  sessionName,
  conversationId,
  defaultModel,
  defaultEffort = "high",
  autoFocus,
}: Props): React.JSX.Element {
  const router = useRouter();
  const storageKey = `cc-layout-${projectName}-${sessionName}`;

  const {
    sessionQuery,
    conversationsQuery,
    collaborationListQuery,
    messagesQuery,
    rawMessages,
    diff,
    commits,
  } = useSessionPageQueries(projectName, sessionName, conversationId);

  const store = useSessionPageStoreBundle();

  const {
    servers: dsServers,
    startServer: dsStartServer,
    stopServer: dsStopServer,
    startAll: dsStartAll,
    stopAll: dsStopAll,
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
  const isReadOnly =
    isFinished || isWorkflowManagedConversation || hasActiveCollab;

  const {
    send: sendPrompt,
    queue: queueMessage,
    abortClient,
  } = useSendPrompt(projectName, sessionName, conversationId);
  const abortPrompt = useAbortPrompt(projectName, sessionName, conversationId);

  const local = useSessionPageLocalState();
  const hasCollabChip = hasCollabPrefix(local.promptText);
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

  useSessionLifecycle({
    storageKey,
    hydrateLayout: store.hydrateLayout,
    resetStore: store.resetStore,
    clearConversationMessages: store.clearConversationMessages,
    conversationId,
    session,
    pendingQuestionId: store.pendingQuestionId,
    showQuestions: store.showQuestions,
    clearQuestions: store.clearQuestions,
    autoFocus,
    router,
    projectName,
    sessionName,
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
  const canStop = store.sending || conversationRunning;
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
      store.switchLayout(mode, storageKey);
    },
    [store, storageKey],
  );

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
  });

  const hasUncommittedChanges = diff.files.length > 0;
  const {
    decodedProjectName,
    commitDisabled,
    mergeDisabled,
    displayStatus,
    statusDotClass,
  } = useSessionPageDisplay({
    projectName,
    isFinished,
    isReadOnly,
    isBusy,
    hasUncommittedChanges,
    pendingQuestions: store.pendingQuestions,
    sending: store.sending,
    sessionStatus,
  });

  if (sessionQuery.isPending || !session) {
    return (
      <LoadingSessionView
        projectName={projectName}
        sessionName={sessionName}
        decodedProjectName={decodedProjectName}
      />
    );
  }

  return (
    <SessionPageContent
      args={{
        projectName,
        sessionName,
        conversationId,
        session,
        activeConversation,
        conversations,
        decodedProjectName,
        statusDotClass,
        displayStatus,
        contextPercent,
        buildContext,
        isFinished,
        isReadOnly,
        isBusy,
        isWorkflowManagedConversation,
        isInitConversation,
        targetBranch,
        branchName: session.branchName,
        hasUncommittedChanges,
        commitDisabled,
        mergeDisabled,
        store,
        local,
        collab,
        dsServers,
        dsStartServer,
        dsStopServer,
        dsStartAll,
        dsStopAll,
        tddEnabled: session.tddEnabled,
        onTddChange: (val) => tddMutation.mutate(val),
        tddDisabled: tddMutation.isPending,
        onLayoutChange: handleLayoutChange,
        diff,
        commits,
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

function SessionPageContent({
  args,
}: {
  args: Parameters<typeof useSessionPageViewProps>[0];
}): React.JSX.Element {
  const viewProps = useSessionPageViewProps(args);
  return <SessionPageView {...viewProps} />;
}
