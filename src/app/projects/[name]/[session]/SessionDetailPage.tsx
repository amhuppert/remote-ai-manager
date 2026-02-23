"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import {
  useSessionQuery,
  useConversationMessagesQuery,
  useSessionDiffQuery,
  useCommitsQuery,
  useConversationsQuery,
} from "@/lib/queries";
import { useDeleteSessionMutation } from "@/lib/mutations";
import { useSendPrompt } from "@/hooks/use-send-prompt";
import {
  useLayout,
  useMobilePanel,
  useSending,
  usePromptPlaceholder,
  usePromptError,
  useOptimisticMessages,
  useMessageCountBeforeSubmit,
  useCurrentMsgIndex,
  useShowDeleteConfirm,
  useShowCommitDialog,
  useShowMergeDialog,
  useInfoExpanded,
  useSwitchLayout,
  useHydrateLayout,
  useSwitchMobilePanel,
  useDismissError,
  useReconcileMessages,
  useNavigateToMessage,
  useStartRecording,
  useStopRecording,
  useShowPlaceholderAction,
  useClearPlaceholder,
  useRequestCommit,
  useCancelCommit,
  useRequestMerge,
  useCancelMerge,
  useRequestDeleteSession,
  useCancelDeleteSessionDetail,
  useToggleInfoStrip,
  useResetSessionDetailStore,
  useClearConversationMessages,
  usePendingQuestions,
  usePendingQuestionId,
  useCurrentQuestionIndex,
  useNavigateQuestion,
  useClearQuestions,
} from "@/stores/session-detail.store";
import Topbar from "@/components/Topbar";
import LayoutSwitcher from "./LayoutSwitcher";
import DiffPanel from "./DiffPanel";
import CommitDialog from "./CommitDialog";
import MergeDialog from "./MergeDialog";
import ConversationSidebar from "./ConversationSidebar";
import ConfirmDialog from "@/components/ConfirmDialog";
import MessageContent from "@/components/MessageContent";
import ConversationNav from "@/components/ConversationNav";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
} from "@/components/CommandAutocomplete";
import ModelSelector, { type ModelId } from "@/components/ModelSelector";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";

interface Props {
  projectName: string;
  sessionName: string;
  conversationId: string;
  defaultModel: ModelId;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SessionDetailPage({
  projectName,
  sessionName,
  conversationId,
  defaultModel,
}: Props): React.JSX.Element {
  const router = useRouter();
  const storageKey = `csm-layout-${projectName}-${sessionName}`;

  // --- TanStack Query ---
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);

  // --- Zustand: state ---
  const layout = useLayout();
  const mobilePanel = useMobilePanel();
  const sending = useSending();
  const promptPlaceholder = usePromptPlaceholder();
  const promptError = usePromptError();
  const optimisticMessages = useOptimisticMessages();
  const messageCountBeforeSubmit = useMessageCountBeforeSubmit();
  const currentMsgIndex = useCurrentMsgIndex();
  const showDeleteConfirm = useShowDeleteConfirm();
  const showCommitDialog = useShowCommitDialog();
  const showMergeDialog = useShowMergeDialog();
  const infoExpanded = useInfoExpanded();

  // --- Zustand: actions ---
  const switchLayout = useSwitchLayout();
  const hydrateLayout = useHydrateLayout();
  const switchMobilePanel = useSwitchMobilePanel();
  const dismissError = useDismissError();
  const reconcileMessages = useReconcileMessages();
  const navigateToMessage = useNavigateToMessage();
  const startRecording = useStartRecording();
  const stopRecording = useStopRecording();
  const showPlaceholder = useShowPlaceholderAction();
  const clearPlaceholder = useClearPlaceholder();
  const requestCommit = useRequestCommit();
  const cancelCommit = useCancelCommit();
  const requestMerge = useRequestMerge();
  const cancelMerge = useCancelMerge();
  const requestDelete = useRequestDeleteSession();
  const cancelDelete = useCancelDeleteSessionDetail();
  const toggleInfoStrip = useToggleInfoStrip();
  const resetStore = useResetSessionDetailStore();
  const clearConversationMessages = useClearConversationMessages();
  const pendingQuestions = usePendingQuestions();
  const pendingQuestionId = usePendingQuestionId();
  const currentQuestionIndex = useCurrentQuestionIndex();
  const navigateQuestion = useNavigateQuestion();
  const clearQuestions = useClearQuestions();

  // --- Derived from query data ---
  const session = sessionQuery.data;
  const conversations = conversationsQuery.data;
  const sessionStatus = session ? deriveSessionStatus(session) : "idle";
  const isFinished = session?.finished ?? false;
  const isBusy = sending || sessionStatus === "running" || !!pendingQuestions;

  // Conditional polling: refetch while session is active
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
    { refetchInterval: isBusy ? 3000 : false },
  );
  const diffQuery = useSessionDiffQuery(projectName, sessionName, {
    refetchInterval: isBusy ? 3000 : false,
  });
  const commitsQuery = useCommitsQuery(projectName, sessionName);

  const messages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );
  const diff = diffQuery.data ?? {
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  const commits = commitsQuery.data ?? [];

  // --- Mutations ---
  const deleteMutation = useDeleteSessionMutation(projectName);

  // --- Prompt streaming ---
  const sendPrompt = useSendPrompt(projectName, sessionName, conversationId);

  // --- Local state ---
  const [promptText, setPromptText] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelId>(defaultModel);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<CommandAutocompleteHandle>(null);
  const promptTextRef = useRef(promptText);
  promptTextRef.current = promptText;
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // --- Refs for message navigation ---
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const currentMsgIndexRef = useRef(currentMsgIndex);
  currentMsgIndexRef.current = currentMsgIndex;

  // --- Auto-resize textarea to fit content ---
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [promptText]);

  // Derive display messages: server messages + optimistic
  const displayMessages = useMemo(
    () => [...messages, ...optimisticMessages],
    [messages, optimisticMessages],
  );

  // --- Reconciliation effect ---
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    const serverCount = messages.length;
    if (serverCount > messageCountBeforeSubmit) {
      reconcileMessages(serverCount);
    }
  }, [
    messages.length,
    optimisticMessages.length,
    messageCountBeforeSubmit,
    reconcileMessages,
  ]);

  // --- Hydrate layout from localStorage on mount ---
  useEffect(() => {
    hydrateLayout(storageKey);
  }, [hydrateLayout, storageKey]);

  // --- Reset store on unmount ---
  useEffect(() => {
    return () => {
      resetStore();
    };
  }, [resetStore]);

  // --- Reset conversation-specific state when switching conversations ---
  useEffect(() => {
    initialScrollDone.current = false;
    clearConversationMessages();
  }, [conversationId, clearConversationMessages]);

  // --- Turn-based navigation ---
  // A "turn" = one user prompt + all subsequent Claude responses until the next prompt.
  // Navigation jumps between user messages, skipping intermediate assistant messages.
  const turnStartIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < displayMessages.length; i++) {
      if (displayMessages[i]!.role === "user") {
        indices.push(i);
      }
    }
    return indices;
  }, [displayMessages]);

  const currentTurnIndex = useMemo(() => {
    let turn = 0;
    for (let t = 0; t < turnStartIndices.length; t++) {
      if ((turnStartIndices[t] ?? 0) <= currentMsgIndex) {
        turn = t;
      } else {
        break;
      }
    }
    return turn;
  }, [turnStartIndices, currentMsgIndex]);

  // --- Virtualizer for conversation messages ---
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual API is intentionally used
  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => panelBodyRef.current,
    estimateSize: () => 120,
    overscan: 5,
    gap: 24,
  });

  // Track visible message from virtualizer for turn navigation counter
  const virtualItems = virtualizer.getVirtualItems();
  const visibleMidIndex =
    virtualItems.length > 0
      ? virtualItems[Math.floor(virtualItems.length / 2)]!.index
      : 0;

  // Scroll-based edge detection: check whether the first/last message is rendered.
  // This is more accurate than deriving it from the middle-visible message's turn index,
  // which incorrectly disables "Jump to End" when all messages fit on screen.
  const isScrolledToStart =
    displayMessages.length === 0 ||
    (virtualItems.length > 0 && virtualItems[0]!.index === 0);
  const isScrolledToEnd =
    displayMessages.length === 0 ||
    (virtualItems.length > 0 &&
      virtualItems[virtualItems.length - 1]!.index >=
        displayMessages.length - 1);

  useEffect(() => {
    if (
      displayMessages.length > 0 &&
      visibleMidIndex !== currentMsgIndexRef.current
    ) {
      navigateToMessage(visibleMidIndex);
    }
  }, [visibleMidIndex, displayMessages.length, navigateToMessage]);

  // Auto-scroll to bottom on initial load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && displayMessages.length > 0) {
      initialScrollDone.current = true;
      conversationEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [displayMessages.length]);

  // Auto-scroll to bottom when new messages arrive
  const prevMessageCountRef = useRef(displayMessages.length);
  useEffect(() => {
    if (displayMessages.length > prevMessageCountRef.current) {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCountRef.current = displayMessages.length;
  }, [displayMessages.length]);

  // Auto-scroll as streaming content blocks arrive
  const optimisticContentCount = useMemo(
    () => optimisticMessages.reduce((sum, m) => sum + m.content.length, 0),
    [optimisticMessages],
  );
  useEffect(() => {
    if (optimisticContentCount > 0) {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [optimisticContentCount]);

  const scrollToMessage = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, displayMessages.length - 1));
      virtualizer.scrollToIndex(clamped, {
        align: "start",
        behavior: "smooth",
      });
      navigateToMessage(clamped);
    },
    [displayMessages.length, navigateToMessage, virtualizer],
  );

  const scrollToEnd = useCallback(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
    if (displayMessages.length > 0) {
      navigateToMessage(displayMessages.length - 1);
    }
  }, [displayMessages.length, navigateToMessage]);

  const handlePrevMessage = useCallback(() => {
    const prevTurnStart = turnStartIndices[currentTurnIndex - 1];
    if (prevTurnStart !== undefined) {
      scrollToMessage(prevTurnStart);
    }
  }, [currentTurnIndex, turnStartIndices, scrollToMessage]);

  const handleNextMessage = useCallback(() => {
    const nextTurnStart = turnStartIndices[currentTurnIndex + 1];
    if (nextTurnStart !== undefined) {
      scrollToMessage(nextTurnStart);
    }
  }, [currentTurnIndex, turnStartIndices, scrollToMessage]);

  // Hotkey bindings — message navigation
  useAppHotkey("nextMessage", handleNextMessage);
  useAppHotkey("prevMessage", handlePrevMessage);
  useAppHotkey("firstMessage", () => scrollToMessage(0));
  useAppHotkey("lastMessage", scrollToEnd);

  // --- Handlers ---

  const handleLayoutChange = useCallback(
    (mode: Parameters<typeof switchLayout>[0]) => {
      switchLayout(mode, storageKey);
    },
    [switchLayout, storageKey],
  );

  const handleSendPrompt = useCallback(async () => {
    const currentText = promptTextRef.current;
    if (!currentText.trim() || sending) return;
    setPromptText("");
    await sendPrompt(currentText.trim(), messages.length, selectedModel);
  }, [sending, messages.length, sendPrompt, selectedModel]);

  const handleAnswerSubmit = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/answer`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, answers }),
        });
        if (res.ok) {
          clearQuestions();
        }
      } catch {
        // Best effort — the question panel remains visible for retry
      }
    },
    [projectName, sessionName, conversationId, clearQuestions],
  );

  const handleDelete = useCallback(() => {
    cancelDelete();
    deleteMutation.mutate(sessionName, {
      onSuccess: () => {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
    });
  }, [deleteMutation, sessionName, projectName, router, cancelDelete]);

  const handleVoiceResult = useCallback((text: string) => {
    setPromptText((prev) => (prev.trim() ? `${prev}\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const handleVoiceError = useCallback((error: string) => {
    void error;
  }, []);

  // Lifted voice recorder hook
  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    onResult: handleVoiceResult,
    onError: handleVoiceError,
  });

  // Sync voice recording state to Zustand store
  useEffect(() => {
    if (isRecording) startRecording();
    else stopRecording();
  }, [isRecording, startRecording, stopRecording]);

  // Voice toggle hotkey
  useAppHotkey("voiceToggle", () => void toggleRecording(), {
    enabled: voiceAvailable && !isProcessing,
  });

  // --- Derived display values ---
  const decodedProjectName = decodeURIComponent(projectName);
  const hasUncommittedChanges = diff.files.length > 0;
  const hasCommits = commits.length > 0;
  const commitDisabled = !hasUncommittedChanges || isBusy || isFinished;
  const mergeDisabled =
    !hasCommits || hasUncommittedChanges || isBusy || isFinished;

  const displayStatus = isFinished
    ? "merged"
    : pendingQuestions
      ? "waiting_for_input"
      : sending
        ? "running"
        : sessionStatus;
  const statusDotClass =
    displayStatus === "running"
      ? "cyan"
      : displayStatus === "merged"
        ? "green"
        : displayStatus === "waiting_for_input"
          ? "amber"
          : "";

  const isLoading = sessionQuery.isPending;

  if (isLoading || !session) {
    return (
      <div className="app" data-page="detail">
        <Topbar
          page="detail"
          breadcrumbs={[
            { label: "projects", href: "/projects" },
            {
              label: decodedProjectName,
              href: `/projects/${encodeURIComponent(projectName)}`,
            },
            {
              label: sessionName,
              href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
              isSession: true,
            },
          ]}
        />
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">Loading session...</div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app" data-page="detail" data-mobile-panel={mobilePanel}>
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: session.sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(session.sessionName)}`,
            isSession: true,
          },
        ]}
        sessionControls={
          <>
            <div className="status-indicator">
              <div className={`status-dot ${statusDotClass}`} />
              {displayStatus}
            </div>
            <div className="topbar-sep" />
            <LayoutSwitcher
              activeLayout={layout}
              onLayoutChange={handleLayoutChange}
            />
            <div className="topbar-sep" />
            <button
              className="btn btn-sm"
              data-tooltip="Commit changes"
              disabled={commitDisabled}
              onClick={requestCommit}
            >
              Commit
            </button>
            <button
              className="btn btn-sm btn-primary"
              data-tooltip="Merge into main"
              disabled={mergeDisabled}
              onClick={requestMerge}
            >
              Merge
            </button>
            <div className="topbar-sep" />
            <button
              className="btn-icon-only danger"
              data-tooltip="Delete session"
              onClick={requestDelete}
            >
              &#10005;
            </button>
          </>
        }
      />

      <main className="main">
        <div className="session-detail-layout stagger-in">
          {/* Info strip */}
          <div
            className={`session-info-strip${infoExpanded ? " expanded" : ""}`}
            onClick={toggleInfoStrip}
          >
            <div className="si-summary">
              <span
                className={`status-dot ${statusDotClass}`}
                style={{ width: 6, height: 6 }}
              />
              <span className="si-val">{session.branchName}</span>
              <span className="si-expand-hint">
                {infoExpanded ? "\u25B2" : "\u25BC"}
              </span>
            </div>
            <div className="si-details">
              <div className="si-item">
                <span className="si-label">Branch</span>
                <span className="si-val">{session.branchName}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Created</span>
                <span className="si-val">{formatDate(session.createdAt)}</span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Prompts</span>
                <span className="si-val">
                  {deriveSessionPromptCount(session)}
                </span>
              </div>
              <div className="si-sep" />
              <div className="si-item">
                <span className="si-label">Worktree</span>
                <span className="si-val" style={{ opacity: 0.6 }}>
                  {session.worktreePath}
                </span>
              </div>
            </div>
          </div>

          {/* Finished banner */}
          {isFinished && (
            <div className="finished-banner">
              This session has been merged into main and is read-only.
            </div>
          )}

          {/* Content area */}
          <div
            className={`session-content-area${conversations ? " with-sidebar" : ""}`}
            data-layout={layout}
          >
            {/* Conversation sidebar */}
            {conversations && (
              <ConversationSidebar
                projectName={projectName}
                sessionName={session.sessionName}
                conversations={conversations}
                activeConversationId={conversationId}
                isFinished={isFinished}
                mobileOpen={mobileSidebarOpen}
                onMobileClose={() => setMobileSidebarOpen(false)}
              />
            )}

            {/* Conversation panel */}
            <div className="prompt-panel">
              <div className="panel-header">
                {conversations && (
                  <button
                    className="convo-sidebar-mobile-toggle"
                    onClick={() => setMobileSidebarOpen(true)}
                    title="Show conversations"
                  >
                    &#9776; Conversations
                  </button>
                )}
                <span className="panel-title">Conversation</span>
                <ConversationNav
                  currentTurn={currentTurnIndex}
                  totalTurns={turnStartIndices.length}
                  isAtStart={isScrolledToStart}
                  isAtEnd={isScrolledToEnd}
                  onFirst={() => scrollToMessage(0)}
                  onPrevious={handlePrevMessage}
                  onNext={handleNextMessage}
                  onLast={scrollToEnd}
                />
              </div>
              <div className="panel-body" ref={panelBodyRef}>
                {promptError && (
                  <div className="prompt-error">
                    <span>{promptError}</span>
                    <button onClick={dismissError}>&times;</button>
                  </div>
                )}
                <div className="conversation">
                  {messagesQuery.isPending ? (
                    <div
                      className="empty-state"
                      style={{ padding: "var(--space-xl) 0" }}
                    >
                      <div className="empty-state-title">
                        Loading conversation...
                      </div>
                    </div>
                  ) : displayMessages.length > 0 ? (
                    <div
                      style={{
                        height: virtualizer.getTotalSize(),
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {virtualizer
                        .getVirtualItems()
                        .map((virtualRow: VirtualItem) => {
                          const msg = displayMessages[virtualRow.index]!;
                          return (
                            <div
                              key={virtualRow.index}
                              ref={virtualizer.measureElement}
                              data-index={virtualRow.index}
                              className={`message ${msg.role}`}
                              data-msg-index={virtualRow.index}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                              }}
                            >
                              <div className="message-role">
                                {msg.role === "user" ? "You" : "Claude"}
                              </div>
                              <div className="message-content">
                                <MessageContent content={msg.content} />
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    <div
                      className="empty-state"
                      style={{ padding: "var(--space-xl) 0" }}
                    >
                      <div className="empty-state-title">No messages yet</div>
                      <div className="empty-state-desc">
                        Send a prompt to start the conversation.
                      </div>
                    </div>
                  )}
                  {(sending || displayStatus === "running") &&
                    (optimisticMessages.some((m) => m.role === "assistant") ? (
                      <div className="streaming-indicator">
                        <div className="typing-dots">
                          <span />
                          <span />
                          <span />
                        </div>
                      </div>
                    ) : (
                      <div className="message assistant typing-indicator">
                        <div className="message-role">Claude</div>
                        <div className="message-content">
                          <div className="typing-dots">
                            <span />
                            <span />
                            <span />
                          </div>
                        </div>
                      </div>
                    ))}
                  <div ref={conversationEndRef} />
                </div>
              </div>

              {/* Prompt input OR question panel */}
              {pendingQuestions && pendingQuestionId ? (
                <AskQuestionPanel
                  questions={pendingQuestions}
                  questionId={pendingQuestionId}
                  currentIndex={currentQuestionIndex}
                  onNavigate={navigateQuestion}
                  onSubmit={handleAnswerSubmit}
                />
              ) : (
                <div className="prompt-input-area">
                  <div className="prompt-input-wrapper">
                    <CommandAutocomplete
                      ref={autocompleteRef}
                      promptText={promptText}
                      onPromptChange={(text) => {
                        setPromptText(text);
                        if (!text.startsWith("/")) {
                          clearPlaceholder();
                        }
                      }}
                      onPlaceholderChange={showPlaceholder}
                      projectName={projectName}
                      sessionName={session.sessionName}
                      disabled={isBusy || isFinished}
                    />
                    <textarea
                      ref={textareaRef}
                      className="prompt-textarea"
                      placeholder={
                        isFinished
                          ? "Session is merged and read-only"
                          : (promptPlaceholder ?? "Send a prompt to Claude...")
                      }
                      rows={1}
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      onKeyDown={(e) => {
                        if (autocompleteRef.current?.handleKeyDown(e)) {
                          return;
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          // Stop voice recording instead of submitting
                          if (isRecording) {
                            toggleRecording();
                            return;
                          }
                          void handleSendPrompt();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setPromptText("");
                          clearPlaceholder();
                        }
                      }}
                      disabled={isFinished}
                    />
                    <div className="prompt-input-actions">
                      <ModelSelector
                        value={selectedModel}
                        onChange={setSelectedModel}
                        disabled={sending || isFinished}
                      />
                      <VoiceRecordButton
                        isRecording={isRecording}
                        isProcessing={isProcessing}
                        elapsedTime={elapsedTime}
                        isAvailable={voiceAvailable}
                        toggleRecording={toggleRecording}
                        disabled={sending}
                      />
                      <button
                        className={`send-btn${sending ? " busy" : ""}`}
                        disabled={
                          !promptText.trim() ||
                          sending ||
                          isFinished ||
                          isRecording
                        }
                        onClick={() => void handleSendPrompt()}
                        title={
                          isFinished
                            ? "Session is read-only"
                            : sending
                              ? "Session is busy"
                              : "Send prompt"
                        }
                      >
                        {sending ? (
                          <div
                            className="spinner"
                            style={{
                              borderColor: "rgba(0, 229, 255, 0.3)",
                              borderTopColor: "var(--cyan)",
                              width: 18,
                              height: 18,
                            }}
                          />
                        ) : (
                          "\u25B6"
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Diff panel — mounted when layout shows it OR mobile panel is "diff" */}
            {(layout !== "conversation" || mobilePanel === "diff") && (
              <DiffPanel
                diff={diff}
                commits={commits}
                projectName={projectName}
                sessionName={session.sessionName}
              />
            )}
          </div>
        </div>
      </main>

      {/* Mobile bottom action bar */}
      <div className="mobile-bottom-bar">
        <div className="mobile-panel-tabs">
          <button
            className={`mobile-tab${mobilePanel === "chat" ? " active" : ""}`}
            onClick={() => switchMobilePanel("chat")}
          >
            Chat
          </button>
          <button
            className={`mobile-tab${mobilePanel === "diff" ? " active" : ""}`}
            onClick={() => switchMobilePanel("diff")}
          >
            Diff
          </button>
        </div>
        <div className="mobile-actions">
          <button
            className="btn btn-sm"
            disabled={commitDisabled}
            onClick={requestCommit}
          >
            Commit
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={mergeDisabled}
            onClick={requestMerge}
          >
            Merge
          </button>
          <button className="btn-icon-only danger" onClick={requestDelete}>
            &#10005;
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete Session"
        message={`This will remove the worktree and session state for "${session.sessionName}". The git branch and transcripts will be preserved. This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={cancelDelete}
      />

      <CommitDialog
        open={showCommitDialog}
        onClose={cancelCommit}
        onSuccess={cancelCommit}
        projectName={projectName}
        sessionName={session.sessionName}
      />

      <MergeDialog
        open={showMergeDialog}
        onClose={cancelMerge}
        projectName={projectName}
        sessionName={session.sessionName}
        branchName={session.branchName}
        commitCount={commits.length}
      />
    </div>
  );
}
