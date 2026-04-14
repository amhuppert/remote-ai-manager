"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";
import { buildConversationContext } from "@/lib/copy-context";
import {
  useSessionQuery,
  useConversationMessagesQuery,
  useSessionDiffQuery,
  useCommitsQuery,
  useConversationsQuery,
} from "@/lib/queries";
import {
  useDeleteSessionMutation,
  useFinalizeInitializationMutation,
  useTddToggleMutation,
} from "@/lib/mutations";
import TddToggle from "@/components/TddToggle";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import { computeContextFillPercent } from "@/lib/context-fill";
import { useSendPrompt } from "@/hooks/use-send-prompt";
import { useAbortPrompt } from "@/hooks/use-abort-prompt";
import {
  useLayout,
  useMobilePanel,
  useSending,
  usePromptPlaceholder,
  usePromptError,
  usePromptCancelled,
  useOptimisticMessages,
  useMessageCountBeforeSubmit,
  useCurrentMsgIndex,
  useShowDeleteConfirm,
  useShowCommitDialog,
  useShowMergeDialog,
  useInfoExpanded,
  useEditingIndex,
  useSwitchLayout,
  useHydrateLayout,
  useSwitchMobilePanel,
  useDismissError,
  useDismissCancelled,
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
  useShowQuestions,
  useNavigateQuestion,
  useClearQuestions,
  useFailPrompt,
  useStartEditing,
  useCancelEditing,
  useSetPendingForkPrompt,
  useConsumePendingForkPrompt,
  useSwitchRightPaneTab,
  useSidebarCollapsed,
  useToggleSidebar,
} from "@/stores/session-detail.store";
import Topbar from "@/components/Topbar";
import LayoutSwitcher from "./LayoutSwitcher";
import DebugModeToggle from "./DebugModeToggle";
import DebugStatusStrip from "./DebugStatusStrip";
import DebugActionCard from "./DebugActionCard";
import RightPane from "./RightPane";
import CommitDialog from "./CommitDialog";
import SmartMergeDialog from "./SmartMergeDialog";
import ConversationSidebar from "./ConversationSidebar";
import ConfirmDialog from "@/components/ConfirmDialog";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import AssistantMessageActions from "@/components/AssistantMessageActions";
import MessageEditor from "@/components/MessageEditor";
import ConversationNav from "@/components/ConversationNav";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import {
  CommandAutocomplete,
  type CommandAutocompleteHandle,
} from "@/components/CommandAutocomplete";
import { FileAutocomplete } from "@/components/FileAutocomplete";
import { useFileAutocomplete } from "@/hooks/use-file-autocomplete";
import ModelSelector from "@/components/ModelSelector";
import { getModelsForBackend } from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import BackendToggle from "@/components/BackendToggle";
import {
  type AgentBackendId,
  type EffortLevel,
  getEffortLevelsForBackend,
} from "@/lib/schemas";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import FocusConfirmationBar from "@/components/FocusConfirmationBar";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useImageAttachments } from "@/hooks/use-image-attachments";
import ImageAttachmentPreview from "./ImageAttachmentPreview";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { ImagePayload } from "@/types";
import CopyableId from "@/components/CopyableId";
import { KiroCommandProvider } from "@/components/KiroCommandContext";
import MobileActionMenu from "@/components/MobileActionMenu";
import DevServerDrawer from "@/components/DevServerDrawer";
import { useDevServers } from "@/hooks/use-dev-servers";
import {
  useDevServerDrawerOpen,
  useToggleDevServerDrawer,
  useCloseDevServerDrawer,
} from "@/stores/dev-server-drawer.store";

interface Props {
  projectName: string;
  sessionName: string;
  conversationId: string;
  defaultModel: string;
  defaultEffort?: EffortLevel;
  autoFocus?: boolean;
}

function MobileInfoCopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="mobile-info-row mobile-info-copyable"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      role="button"
      tabIndex={0}
    >
      <span className="mobile-info-label">{label}</span>
      <span className="mobile-info-value">{value}</span>
      <span className="mobile-info-copy-icon">
        {copied ? "\u2713" : "\u2398"}
      </span>
    </div>
  );
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
  defaultEffort = "high",
  autoFocus,
}: Props): React.JSX.Element {
  const router = useRouter();
  const storageKey = `cc-layout-${projectName}-${sessionName}`;

  // --- TanStack Query ---
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);

  // --- Zustand: state ---
  const layout = useLayout();
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useToggleSidebar();
  const mobilePanel = useMobilePanel();
  const sending = useSending();
  const promptPlaceholder = usePromptPlaceholder();
  const promptError = usePromptError();
  const promptCancelled = usePromptCancelled();
  const optimisticMessages = useOptimisticMessages();
  const messageCountBeforeSubmit = useMessageCountBeforeSubmit();
  const currentMsgIndex = useCurrentMsgIndex();
  const showDeleteConfirm = useShowDeleteConfirm();
  const showCommitDialog = useShowCommitDialog();
  const showMergeDialog = useShowMergeDialog();
  const infoExpanded = useInfoExpanded();
  const editingIndex = useEditingIndex();

  // --- Zustand: actions ---
  const switchLayout = useSwitchLayout();
  const hydrateLayout = useHydrateLayout();
  const switchMobilePanelRaw = useSwitchMobilePanel();
  const switchRightPaneTab = useSwitchRightPaneTab();
  const switchMobilePanel = useCallback(
    (panel: "chat" | "diff" | "docs" | "specs" | "info") => {
      switchMobilePanelRaw(panel);
      // Sync right pane tab when switching to diff, docs, or specs via mobile tabs
      if (panel === "docs") switchRightPaneTab("docs");
      if (panel === "diff") switchRightPaneTab("diff");
      if (panel === "specs") switchRightPaneTab("specs");
    },
    [switchMobilePanelRaw, switchRightPaneTab],
  );
  const dismissError = useDismissError();
  const dismissCancelled = useDismissCancelled();
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
  const showQuestions = useShowQuestions();
  const navigateQuestion = useNavigateQuestion();
  const clearQuestions = useClearQuestions();
  const startEditing = useStartEditing();
  const cancelEditing = useCancelEditing();
  const setPendingForkPrompt = useSetPendingForkPrompt();
  const consumePendingForkPrompt = useConsumePendingForkPrompt();

  // --- Dev server ---
  const dsOpen = useDevServerDrawerOpen();
  const dsToggle = useToggleDevServerDrawer();
  const dsClose = useCloseDevServerDrawer();
  const {
    servers: dsServers,
    startServer: dsStartServer,
    stopServer: dsStopServer,
    startAll: dsStartAll,
    stopAll: dsStopAll,
  } = useDevServers(projectName, sessionName);

  // --- Derived from query data ---
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
  const isReadOnly = isFinished || isWorkflowManagedConversation;
  const isBusy =
    sending ||
    sessionStatus === "running" ||
    sessionStatus === "waiting_for_input" ||
    !!pendingQuestions;

  // Detect initialization conversation for focus confirmation bar
  const activeConversation = session?.conversations.find(
    (c) => c.id === conversationId,
  );
  const isInitConversation = activeConversation?.role === "initialization";
  const contextPercent = computeContextFillPercent(
    activeConversation?.contextTokens ?? null,
    activeConversation?.contextWindowMax ?? null,
  );
  const [focusConfirmLoading, setFocusConfirmLoading] = useState(false);
  // Flag: user clicked confirm, write-focus prompt was sent, waiting for it to finish
  const [awaitingFinalize, setAwaitingFinalize] = useState(false);

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
  const finalizeMutation = useFinalizeInitializationMutation(
    projectName,
    sessionName,
  );
  const tddMutation = useTddToggleMutation(projectName, sessionName);

  // --- Prompt streaming ---
  const {
    send: sendPrompt,
    queue: queueMessage,
    abortClient,
  } = useSendPrompt(projectName, sessionName, conversationId);
  const abortPrompt = useAbortPrompt(projectName, sessionName, conversationId);

  // --- Local state ---
  const [promptText, setPromptText] = useState("");
  const [selectedBackend, setSelectedBackend] = useState<AgentBackendId>(
    activeConversation?.agentBackend ?? "claude",
  );
  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  // Sync backend selection when conversation changes or data loads
  const activeBackend = activeConversation?.agentBackend;
  useEffect(() => {
    if (!activeConversation) return;
    const backend = activeConversation.agentBackend ?? "claude";
    // Only reset model/effort when the backend actually changes
    if (backend === selectedBackend) return;
    setSelectedBackend(backend);
    const models = getModelsForBackend(backend);
    setSelectedModel(models[0]!.id);
    const levels = getEffortLevelsForBackend(backend, models[0]!.id);
    setSelectedEffort(levels.includes("high") ? "high" : levels[0]!);
  }, [conversationId, activeBackend]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on conversation switch or backend change

  const [selectedModel, setSelectedModel] = useState<string>(defaultModel);
  const [selectedEffort, setSelectedEffort] =
    useState<EffortLevel>(defaultEffort);
  const availableEffortLevels = getEffortLevelsForBackend(
    selectedBackend,
    selectedModel,
  );
  const effortSupported = availableEffortLevels.length > 0;

  const handleBackendChange = useCallback((backend: AgentBackendId) => {
    setSelectedBackend(backend);
    const models = getModelsForBackend(backend);
    setSelectedModel(models[0]!.id);
    const levels = getEffortLevelsForBackend(backend, models[0]!.id);
    setSelectedEffort(levels.includes("high") ? "high" : levels[0]!);
  }, []);

  const handleModelChange = useCallback(
    (model: string) => {
      setSelectedModel(model);
      const levels = getEffortLevelsForBackend(selectedBackend, model);
      if (levels.length > 0 && !levels.includes(selectedEffort)) {
        setSelectedEffort(levels[levels.length - 1]!);
      }
    },
    [selectedBackend, selectedEffort],
  );

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autocompleteRef = useRef<CommandAutocompleteHandle>(null);
  const [cursorPosition, setCursorPosition] = useState(0);
  const promptTextRef = useRef(promptText);
  promptTextRef.current = promptText;

  const fileAutocomplete = useFileAutocomplete({
    projectName,
    text: promptText,
    cursorPosition,
    disabled: isBusy || isReadOnly,
    onTextChange: setPromptText,
  });
  const fireAndForgetRef = useRef(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Image attachments ---
  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();
  const failPrompt = useFailPrompt();

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

  // Derive display messages: server messages + optimistic (non-overlapping).
  // During streaming, the server transcript is written in real-time and polled
  // every 3s, so server `messages` may already contain the assistant response
  // that is also in `optimisticMessages`. To avoid duplicates, slice server
  // messages to just before the current prompt and append optimistic instead.
  const displayMessages = useMemo(() => {
    if (optimisticMessages.length === 0) return messages;
    return [
      ...messages.slice(0, messageCountBeforeSubmit),
      ...optimisticMessages,
    ];
  }, [messages, optimisticMessages, messageCountBeforeSubmit]);

  // --- Reconciliation effect ---
  // Clear optimistic messages once the stream is done and the server has the data.
  // While sending, optimistic messages are the authoritative source (displayMessages
  // slices server data to before the submit point), so no reconciliation is needed.
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    if (!sending && messages.length > messageCountBeforeSubmit) {
      reconcileMessages(messages.length);
    }
  }, [
    messages.length,
    optimisticMessages.length,
    messageCountBeforeSubmit,
    sending,
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

    // Reset any accidental scroll on ancestors (overflow:clip prevents new
    // occurrences; this cleans up any pre-existing scroll offset).
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [conversationId, clearConversationMessages]);

  // --- Recover persisted question state on page load / navigation ---
  useEffect(() => {
    if (!session) return;
    const activeConvo = session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!activeConvo) return;

    if (
      activeConvo.status === "waiting_for_input" &&
      activeConvo.pendingQuestionId &&
      activeConvo.pendingQuestions &&
      !pendingQuestionId
    ) {
      // Hydrate the store with persisted question data
      showQuestions(
        activeConvo.pendingQuestionId,
        activeConvo.pendingQuestions,
      );
    } else if (
      pendingQuestionId &&
      activeConvo.status !== "waiting_for_input"
    ) {
      // Another tab answered — clear stale question state
      clearQuestions();
    }
  }, [
    session,
    conversationId,
    pendingQuestionId,
    showQuestions,
    clearQuestions,
  ]);

  // --- Auto-send Focus mode prompt ---
  const autoFocusFired = useRef(false);
  useEffect(() => {
    if (!autoFocus || autoFocusFired.current || !session?.objective) return;
    autoFocusFired.current = true;

    // Clean the URL parameter
    router.replace(
      `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${encodeURIComponent(conversationId)}`,
      { scroll: false },
    );

    // Build and send the understand-objective prompt
    import("@/lib/prompt-templates").then(
      ({ getUnderstandObjectivePrompt }) => {
        const prompt = getUnderstandObjectivePrompt(session.objective!);
        void sendPrompt(
          prompt,
          messages.length,
          selectedModel,
          undefined,
          effortSupported ? selectedEffort : undefined,
          selectedBackend,
        );
      },
    );
  }, [
    autoFocus,
    session,
    sendPrompt,
    messages.length,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    router,
    projectName,
    sessionName,
    conversationId,
  ]);

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

  useEffect(() => {
    if (
      displayMessages.length > 0 &&
      visibleMidIndex !== currentMsgIndexRef.current
    ) {
      navigateToMessage(visibleMidIndex);
    }
  }, [visibleMidIndex, displayMessages.length, navigateToMessage]);

  // Scroll panel body to bottom — avoids scrollIntoView which propagates
  // through overflow:hidden ancestors and shifts the entire page up.
  const scrollPanelToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = panelBodyRef.current;
      if (el?.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior });
    },
    [],
  );

  // Auto-scroll to bottom on initial load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (!initialScrollDone.current && displayMessages.length > 0) {
      initialScrollDone.current = true;
      virtualizer.scrollToIndex(displayMessages.length - 1, {
        align: "end",
        behavior: "auto",
      });
    }
  }, [displayMessages.length, virtualizer]);

  // Auto-scroll to bottom when new messages arrive
  const prevMessageCountRef = useRef(displayMessages.length);
  useEffect(() => {
    if (displayMessages.length > prevMessageCountRef.current) {
      scrollPanelToBottom();
    }
    prevMessageCountRef.current = displayMessages.length;
  }, [displayMessages.length, scrollPanelToBottom]);

  // Auto-scroll as streaming content blocks arrive
  const optimisticContentCount = useMemo(
    () => optimisticMessages.reduce((sum, m) => sum + m.content.length, 0),
    [optimisticMessages],
  );
  useEffect(() => {
    if (optimisticContentCount > 0) {
      scrollPanelToBottom();
    }
  }, [optimisticContentCount, scrollPanelToBottom]);

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
    if (displayMessages.length > 0) {
      virtualizer.scrollToIndex(displayMessages.length - 1, {
        align: "end",
        behavior: "auto",
      });
      navigateToMessage(displayMessages.length - 1);
    }
  }, [displayMessages.length, navigateToMessage, virtualizer]);

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

  // Abort / clear input hotkey (Escape)
  // Check both the client-side SSE stream flag AND the server-side conversation
  // status so that abort works even after page refresh or connection drops.
  const conversationRunning =
    activeConversation?.status === "running" ||
    activeConversation?.status === "waiting_for_input";
  const handleAbortOrClear = useCallback(() => {
    if (sending || conversationRunning) {
      if (sending) abortClient();
      void abortPrompt();
    } else {
      setPromptText("");
      clearPlaceholder();
      clearImages();
    }
  }, [
    sending,
    conversationRunning,
    abortClient,
    abortPrompt,
    clearPlaceholder,
    clearImages,
  ]);
  useAppHotkey("abortPrompt", handleAbortOrClear);

  // --- Handlers ---

  const handleLayoutChange = useCallback(
    (mode: Parameters<typeof switchLayout>[0]) => {
      switchLayout(mode, storageKey);
    },
    [switchLayout, storageKey],
  );

  const handleSendPrompt = useCallback(async () => {
    const currentText = promptTextRef.current;
    const hasImages = pendingImages.length > 0;
    if (!currentText.trim() && !hasImages) return;

    // Queue into running conversation instead of starting a new prompt
    if (sending && conversationId) {
      setPromptText("");
      await queueMessage(currentText.trim());
      return;
    }

    if (sending) return;

    // Collect image payloads before clearing
    const imagePayloads: ImagePayload[] = hasImages
      ? pendingImages.map((img) => ({
          mediaType: img.mediaType as ImagePayload["mediaType"],
          base64Data: img.base64Data,
        }))
      : [];

    setPromptText("");
    clearImages();
    await sendPrompt(
      currentText.trim(),
      messages.length,
      selectedModel,
      imagePayloads.length > 0 ? imagePayloads : undefined,
      effortSupported ? selectedEffort : undefined,
      selectedBackend,
    );
  }, [
    sending,
    conversationId,
    messages.length,
    sendPrompt,
    queueMessage,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
    pendingImages,
    clearImages,
  ]);

  const handleDebugPrompt = useCallback(
    (text: string) => {
      void sendPrompt(
        text,
        messages.length,
        selectedModel,
        undefined,
        undefined,
        selectedBackend,
      );
    },
    [sendPrompt, messages.length, selectedModel, selectedBackend],
  );

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
        } else if (res.status === 410) {
          // Prompt is no longer running (server restarted)
          clearQuestions();
          const body = await res.json().catch(() => null);
          failPrompt(
            body?.error ??
              "The prompt that asked this question is no longer running.",
          );
          // Refresh session data to pick up updated status
          void sessionQuery.refetch();
        }
      } catch {
        // Best effort — the question panel remains visible for retry
      }
    },
    [
      projectName,
      sessionName,
      conversationId,
      clearQuestions,
      failPrompt,
      sessionQuery,
    ],
  );

  const handleDelete = useCallback(() => {
    cancelDelete();
    deleteMutation.mutate(sessionName, {
      onSuccess: () => {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
    });
  }, [deleteMutation, sessionName, projectName, router, cancelDelete]);

  // --- Focus initialization confirmation ---
  // Step 1: User clicks confirm → send write-focus-document prompt, set flag
  const handleConfirmFocus = useCallback(() => {
    setFocusConfirmLoading(true);
    setAwaitingFinalize(true);
    void import("@/lib/prompt-templates").then(
      ({ getWriteFocusDocumentPrompt }) => {
        void sendPrompt(
          getWriteFocusDocumentPrompt(),
          messages.length,
          selectedModel,
          undefined,
          effortSupported ? selectedEffort : undefined,
          selectedBackend,
        );
      },
    );
  }, [
    sendPrompt,
    messages.length,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
  ]);

  // Step 2: Once the prompt finishes (session no longer busy), finalize
  useEffect(() => {
    if (!awaitingFinalize || isBusy) return;
    setAwaitingFinalize(false);

    void (async () => {
      try {
        const result = await finalizeMutation.mutateAsync();
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${result.conversationId}`,
        );
      } catch {
        failPrompt("Failed to finalize initialization");
        setFocusConfirmLoading(false);
      }
    })();
  }, [
    awaitingFinalize,
    isBusy,
    finalizeMutation,
    router,
    projectName,
    sessionName,
    failPrompt,
  ]);

  // --- Fork / Edit handlers ---

  const [forkingIndex, setForkingIndex] = useState<number | null>(null);

  const handleFork = useCallback(
    async (messageIndex: number) => {
      setForkingIndex(messageIndex);
      try {
        const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/fork`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIndex }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Fork failed" }));
          failPrompt((data as { error?: string }).error ?? "Fork failed");
          return;
        }
        const result = (await res.json()) as {
          conversationId: string;
          name: string;
        };
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${result.conversationId}`,
        );
      } catch {
        failPrompt("Fork failed");
      } finally {
        setForkingIndex(null);
      }
    },
    [projectName, sessionName, conversationId, router, failPrompt],
  );

  const handleEditSave = useCallback(
    async (messageIndex: number, newText: string) => {
      setForkingIndex(messageIndex);
      try {
        // Extract original text to detect unchanged saves
        const msg = displayMessages[messageIndex];
        const originalText = msg?.content.find(
          (b) => b.type === "text" && "text" in b,
        )
          ? (
              msg.content.find((b) => b.type === "text" && "text" in b) as {
                text: string;
              }
            ).text
          : "";

        const isUnchanged = newText.trim() === originalText.trim();

        const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/fork`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageIndex,
            editedText: isUnchanged ? undefined : newText,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Fork failed" }));
          failPrompt((data as { error?: string }).error ?? "Fork failed");
          return;
        }
        const result = (await res.json()) as {
          conversationId: string;
          name: string;
        };

        cancelEditing();

        // If text was edited, set pending fork prompt for auto-send
        if (!isUnchanged) {
          setPendingForkPrompt({
            conversationId: result.conversationId,
            text: newText,
          });
        }

        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${result.conversationId}`,
        );
      } catch {
        failPrompt("Fork failed");
      } finally {
        setForkingIndex(null);
      }
    },
    [
      projectName,
      sessionName,
      conversationId,
      displayMessages,
      router,
      failPrompt,
      cancelEditing,
      setPendingForkPrompt,
    ],
  );

  // Auto-prompt delivery for edit-and-fork
  const autoPromptFired = useRef(false);
  useEffect(() => {
    if (autoPromptFired.current) return;
    const pending = consumePendingForkPrompt();
    if (!pending) return;
    if (pending.conversationId !== conversationId) return;
    autoPromptFired.current = true;
    void sendPrompt(
      pending.text,
      0,
      selectedModel,
      undefined,
      effortSupported ? selectedEffort : undefined,
      selectedBackend,
    );
  }, [
    conversationId,
    consumePendingForkPrompt,
    sendPrompt,
    selectedModel,
    selectedEffort,
    effortSupported,
    selectedBackend,
  ]);

  const handleVoiceResult = useCallback(
    (text: string) => {
      const newText = promptTextRef.current.trim()
        ? `${promptTextRef.current}\n${text}`
        : text;
      promptTextRef.current = newText;
      setPromptText(newText);
      requestAnimationFrame(() => textareaRef.current?.focus());

      if (fireAndForgetRef.current) {
        fireAndForgetRef.current = false;
        void handleSendPrompt();
      }
    },
    [handleSendPrompt],
  );

  const handleVoiceError = useCallback((error: string) => {
    void error;
    fireAndForgetRef.current = false;
  }, []);

  // --- Copy conversation context for debugging ---
  const [contextCopied, setContextCopied] = useState(false);
  const handleCopyContext = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!session) return;
      const text = buildConversationContext({
        projectName,
        sessionName,
        session,
        conversationId,
      });
      void navigator.clipboard.writeText(text).then(() => {
        setContextCopied(true);
        setTimeout(() => setContextCopied(false), 1500);
      });
    },
    [session, conversationId, projectName, sessionName],
  );

  // Lifted voice recorder hook
  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    getContext: useCallback(() => promptTextRef.current, []),
    onResult: handleVoiceResult,
    onError: handleVoiceError,
  });

  // Sync voice recording state to Zustand store
  useEffect(() => {
    if (isRecording) startRecording();
    else stopRecording();
  }, [isRecording, startRecording, stopRecording]);

  // Voice toggle hotkey
  useAppHotkey(
    "voiceToggle",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = false;
      }
      void toggleRecording();
    },
    {
      enabled: voiceAvailable && !isProcessing,
    },
  );

  // Voice fire-and-forget hotkey
  useAppHotkey(
    "voiceFireAndForget",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = true;
      }
      void toggleRecording();
    },
    {
      enabled: voiceAvailable && !isProcessing,
    },
  );

  // --- Derived display values ---
  const decodedProjectName = decodeURIComponent(projectName);
  const hasUncommittedChanges = diff.files.length > 0;
  const commitDisabled = !hasUncommittedChanges || isBusy || isReadOnly;
  const mergeDisabled = isBusy || isReadOnly;

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
            <TddToggle
              enabled={session.tddEnabled}
              onChange={(val) => tddMutation.mutate(val)}
              disabled={tddMutation.isPending}
              compact
            />
            <div className="topbar-sep" />
            <LayoutSwitcher
              activeLayout={layout}
              onLayoutChange={handleLayoutChange}
            />
            <DevServerDrawer
              open={dsOpen}
              servers={dsServers}
              onClose={dsClose}
              onToggle={dsToggle}
              onStart={dsStartServer}
              onStop={dsStopServer}
              onStartAll={dsStartAll}
              onStopAll={dsStopAll}
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
              data-tooltip={`Merge into ${targetBranch}`}
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
        <div
          className={`session-detail-layout stagger-in${isFinished ? " finished" : ""}`}
        >
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
              <CopyableId
                label="Branch"
                value={session.branchName}
                truncateAt={999}
              />
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
              <CopyableId
                label="Worktree"
                value={session.worktreePath}
                truncateAt={999}
              />
              <div className="si-sep" />
              <CopyableId label="Conv ID" value={conversationId} />
              {(() => {
                const conv = session.conversations.find(
                  (c) => c.id === conversationId,
                );
                if (!conv) return null;
                return (
                  <>
                    <div className="si-sep" />
                    <CopyableId label="Backend" value={conv.agentBackend} />
                    <div className="si-sep" />
                    <CopyableId
                      label="Session Ref"
                      value={JSON.stringify(conv.backendRef)}
                    />
                  </>
                );
              })()}
              <div className="si-sep" />
              <button
                className="si-copy-context-btn"
                onClick={handleCopyContext}
                data-tooltip={
                  contextCopied ? "Copied!" : "Copy context to clipboard"
                }
              >
                {contextCopied ? "\u2713" : "\u2398"} Context
              </button>
              {contextPercent != null && (
                <>
                  <div className="si-sep" />
                  <ContextFillIndicator percentage={contextPercent} />
                </>
              )}
            </div>
          </div>

          {/* Finished banner */}
          {isFinished && (
            <div className="finished-banner">
              This session has been merged into {targetBranch} and is read-only.
            </div>
          )}

          {/* Sidebar expand button — rendered outside session-content-area to avoid overflow:hidden clipping */}
          {conversations && sidebarCollapsed && (
            <button
              className="convo-sidebar-expand-float"
              onClick={toggleSidebar}
              data-tooltip="Expand sidebar"
            >
              {"\u25B6"}
            </button>
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
                isFinished={isReadOnly}
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
                  onFirst={() => scrollToMessage(0)}
                  onPrevious={handlePrevMessage}
                  onNext={handleNextMessage}
                  onLast={scrollToEnd}
                />
              </div>
              {contextPercent != null && (
                <div className="mobile-context-fill">
                  <ContextFillIndicator percentage={contextPercent} />
                </div>
              )}
              <div
                className="panel-body"
                ref={panelBodyRef}
                {...(activeConversation?.debugMode?.active
                  ? { "data-debug-mode": "" }
                  : {})}
              >
                {promptError && (
                  <div className="prompt-error">
                    <span>{promptError}</span>
                    <button onClick={dismissError}>&times;</button>
                  </div>
                )}
                {promptCancelled && (
                  <div className="prompt-cancelled">
                    <span>Prompt cancelled</span>
                    <button onClick={dismissCancelled}>&times;</button>
                  </div>
                )}
                <KiroCommandProvider
                  projectName={projectName}
                  sessionName={sessionName}
                  conversationId={conversationId}
                  sendPrompt={sendPrompt}
                  messageCount={messages.length}
                  isBusy={isBusy}
                  selectedModel={selectedModel}
                >
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
                            const isEditing = editingIndex === virtualRow.index;
                            const isUserMsg = msg.role === "user";
                            return (
                              <div
                                key={virtualRow.index}
                                ref={virtualizer.measureElement}
                                data-index={virtualRow.index}
                                className={`message ${msg.role}${isEditing ? " editing" : ""}`}
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
                                  {isUserMsg ? "You" : "Claude"}
                                  {!isUserMsg && (msg.model || msg.effort) && (
                                    <span className="message-meta">
                                      <span className="message-meta-sep">
                                        &middot;
                                      </span>
                                      {msg.model && (
                                        <span className="message-meta-model">
                                          {msg.model}
                                        </span>
                                      )}
                                      {msg.model && msg.effort && (
                                        <span className="message-meta-sep">
                                          &middot;
                                        </span>
                                      )}
                                      {msg.effort && (
                                        <span
                                          className={`message-meta-effort${msg.effort === "max" ? " rainbow-text" : ""}`}
                                        >
                                          {msg.effort}
                                        </span>
                                      )}
                                    </span>
                                  )}
                                </div>
                                {isEditing ? (
                                  <MessageEditor
                                    originalText={
                                      (
                                        msg.content.find(
                                          (b) =>
                                            b.type === "text" && "text" in b,
                                        ) as { text: string } | undefined
                                      )?.text ?? ""
                                    }
                                    messageIndex={virtualRow.index}
                                    onSave={handleEditSave}
                                    onCancel={cancelEditing}
                                    saving={forkingIndex === virtualRow.index}
                                  />
                                ) : (
                                  <div className="message-content">
                                    <MessageContent content={msg.content} />
                                  </div>
                                )}
                                {!isUserMsg &&
                                  virtualRow.index ===
                                    displayMessages.length - 1 &&
                                  activeConversation && (
                                    <DebugActionCard
                                      projectName={projectName}
                                      sessionName={sessionName}
                                      conversation={activeConversation}
                                      onSendPrompt={handleDebugPrompt}
                                      isBusy={isBusy}
                                    />
                                  )}
                                {isUserMsg && !isEditing && (
                                  <MessageActions
                                    messageIndex={virtualRow.index}
                                    onFork={handleFork}
                                    onEdit={startEditing}
                                    disabled={isBusy || isReadOnly}
                                  />
                                )}
                                {!isUserMsg && (
                                  <AssistantMessageActions
                                    content={msg.content}
                                  />
                                )}
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
                      (optimisticMessages.some(
                        (m) => m.role === "assistant",
                      ) ? (
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
                </KiroCommandProvider>
              </div>

              {/* Focus initialization confirmation bar */}
              {isInitConversation &&
                !pendingQuestions &&
                (!isBusy || focusConfirmLoading) &&
                (activeConversation?.promptCount ?? 0) > 0 && (
                  <FocusConfirmationBar
                    onConfirm={handleConfirmFocus}
                    disabled={isReadOnly}
                    loading={focusConfirmLoading}
                  />
                )}

              {/* Prompt input OR question panel OR read-only indicator */}
              {isWorkflowManagedConversation ? (
                <div className="iteration-readonly-banner">
                  {"\u27F3"} This conversation is managed by a workflow
                  execution and is read-only.
                </div>
              ) : pendingQuestions && pendingQuestionId ? (
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
                    {activeConversation && (
                      <DebugStatusStrip
                        projectName={projectName}
                        sessionName={sessionName}
                        conversation={activeConversation}
                      />
                    )}
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
                      disabled={isBusy || isReadOnly}
                    />
                    <FileAutocomplete
                      ref={fileAutocomplete.autocompleteRef}
                      items={fileAutocomplete.items}
                      visible={fileAutocomplete.visible}
                      loading={fileAutocomplete.loading}
                      error={fileAutocomplete.error}
                      totalCount={fileAutocomplete.totalCount}
                      onSelect={fileAutocomplete.onSelect}
                      onClose={fileAutocomplete.onClose}
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
                      onChange={(e) => {
                        setPromptText(e.target.value);
                        setCursorPosition(e.target.selectionStart);
                      }}
                      onSelect={(e) => {
                        setCursorPosition(
                          (e.target as HTMLTextAreaElement).selectionStart,
                        );
                      }}
                      onPaste={(e) => {
                        const items = e.clipboardData.items;
                        for (const item of items) {
                          if (item.type.startsWith("image/")) {
                            e.preventDefault();
                            const file = item.getAsFile();
                            if (file) {
                              void addImage(file).then((err) => {
                                if (err) failPrompt(err);
                              });
                            }
                            return;
                          }
                        }
                        // Text paste — let default behavior proceed
                      }}
                      onKeyDown={(e) => {
                        if (
                          fileAutocomplete.autocompleteRef.current?.handleKeyDown(
                            e,
                          )
                        ) {
                          return;
                        }
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
                      }}
                      disabled={isReadOnly}
                    />
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      multiple
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const files = e.target.files;
                        if (!files) return;
                        for (const file of files) {
                          void addImage(file).then((err) => {
                            if (err) failPrompt(err);
                          });
                        }
                        // Reset so re-selecting the same file works
                        e.target.value = "";
                      }}
                    />
                    <ImageAttachmentPreview
                      images={pendingImages}
                      onRemove={removeImage}
                    />
                    <div className="prompt-toolbar">
                      <div className="prompt-toolbar-start">
                        <button
                          className="attachment-btn"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isAtLimit || sending || isReadOnly}
                          title="Attach image"
                          type="button"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                          </svg>
                        </button>
                        <BackendToggle
                          value={selectedBackend}
                          onChange={handleBackendChange}
                          disabled={sending || isReadOnly}
                          readOnly={backendLocked}
                        />
                        <ModelSelector
                          value={selectedModel}
                          onChange={handleModelChange}
                          disabled={sending || isReadOnly}
                          backend={selectedBackend}
                        />
                        <ReasoningLevelSelector
                          value={selectedEffort}
                          onChange={setSelectedEffort}
                          disabled={sending || isReadOnly || !effortSupported}
                          availableLevels={availableEffortLevels}
                          disabledTooltip={
                            !effortSupported
                              ? "Reasoning level is only available for Opus and Sonnet models"
                              : undefined
                          }
                        />
                        <DebugModeToggle
                          projectName={projectName}
                          sessionName={sessionName}
                          conversation={activeConversation}
                          disabled={sending || isReadOnly}
                        />
                      </div>
                      <div className="prompt-toolbar-end">
                        <VoiceRecordButton
                          isRecording={isRecording}
                          isProcessing={isProcessing}
                          elapsedTime={elapsedTime}
                          isAvailable={voiceAvailable}
                          toggleRecording={toggleRecording}
                          disabled={sending}
                        />
                        <button
                          className={`send-btn${sending && !conversationId ? " busy" : ""}`}
                          disabled={
                            (!promptText.trim() &&
                              pendingImages.length === 0) ||
                            (sending && !conversationId) ||
                            isReadOnly ||
                            isRecording
                          }
                          onClick={() => void handleSendPrompt()}
                          title={
                            isReadOnly
                              ? "Session is read-only"
                              : sending && !conversationId
                                ? "Session is busy"
                                : sending
                                  ? "Queue message"
                                  : "Send prompt"
                          }
                        >
                          {sending && !conversationId ? (
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
                </div>
              )}
            </div>

            {/* Right pane (diff + docs + specs) — mounted when layout shows it OR mobile panel is "diff"/"docs"/"specs" */}
            {(layout !== "conversation" ||
              mobilePanel === "diff" ||
              mobilePanel === "docs" ||
              mobilePanel === "specs") && (
              <RightPane
                diff={diff}
                commits={commits}
                projectName={projectName}
                sessionName={session.sessionName}
                targetBranch={targetBranch}
              />
            )}

            {/* Mobile info panel */}
            {mobilePanel === "info" && (
              <div className="mobile-info-panel">
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Status</span>
                  <span className="mobile-info-value">
                    <span
                      className={`status-dot ${statusDotClass}`}
                      style={{
                        width: 6,
                        height: 6,
                        display: "inline-block",
                        marginRight: 6,
                      }}
                    />
                    {displayStatus}
                  </span>
                </div>
                <MobileInfoCopyRow label="Branch" value={session.branchName} />
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Created</span>
                  <span className="mobile-info-value">
                    {formatDate(session.createdAt)}
                  </span>
                </div>
                <div className="mobile-info-row">
                  <span className="mobile-info-label">Prompts</span>
                  <span className="mobile-info-value">
                    {deriveSessionPromptCount(session)}
                  </span>
                </div>
                <MobileInfoCopyRow
                  label="Worktree"
                  value={session.worktreePath}
                />
                <MobileInfoCopyRow label="Conv ID" value={conversationId} />
                {(() => {
                  const conv = session.conversations.find(
                    (c) => c.id === conversationId,
                  );
                  if (!conv) return null;
                  return (
                    <>
                      <MobileInfoCopyRow
                        label="Backend"
                        value={conv.agentBackend}
                      />
                      <MobileInfoCopyRow
                        label="Session Ref"
                        value={JSON.stringify(conv.backendRef)}
                      />
                    </>
                  );
                })()}
                {contextPercent != null && (
                  <div className="mobile-info-row">
                    <span className="mobile-info-label">Context</span>
                    <span className="mobile-info-value">
                      <ContextFillIndicator percentage={contextPercent} />
                    </span>
                  </div>
                )}
                <div className="mobile-info-actions">
                  <button className="btn btn-sm" onClick={handleCopyContext}>
                    {contextCopied ? "\u2713 Copied" : "\u2398 Copy Context"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Mobile bottom action bar */}
      <div className="mobile-bottom-bar">
        <div className="cc-tabs">
          <button
            className={`cc-tab${mobilePanel === "chat" ? " active" : ""}`}
            onClick={() => switchMobilePanel("chat")}
          >
            Chat
          </button>
          <button
            className={`cc-tab${mobilePanel === "diff" ? " active" : ""}`}
            onClick={() => switchMobilePanel("diff")}
          >
            Diff
          </button>
          <button
            className={`cc-tab${mobilePanel === "docs" ? " active" : ""}`}
            onClick={() => switchMobilePanel("docs")}
          >
            Docs
          </button>
          <button
            className={`cc-tab${mobilePanel === "specs" ? " active" : ""}`}
            onClick={() => switchMobilePanel("specs")}
          >
            Specs
          </button>
          <button
            className={`cc-tab${mobilePanel === "info" ? " active" : ""}`}
            onClick={() => switchMobilePanel("info")}
          >
            Info
          </button>
        </div>
        <MobileActionMenu
          tddEnabled={session.tddEnabled}
          onTddToggle={(val) => tddMutation.mutate(val)}
          tddDisabled={tddMutation.isPending}
          commitDisabled={commitDisabled}
          mergeDisabled={mergeDisabled}
          targetBranch={targetBranch}
          onCommit={requestCommit}
          onMerge={requestMerge}
          onDelete={requestDelete}
          devServerCounts={{
            running: dsServers.filter((s) => s.status === "running").length,
            total: dsServers.length,
          }}
          onDevServers={dsToggle}
        />
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

      <SmartMergeDialog
        open={showMergeDialog}
        onClose={cancelMerge}
        projectName={projectName}
        sessionName={session.sessionName}
        branchName={session.branchName}
        targetBranch={targetBranch}
        commitCount={commits.length}
        hasUncommittedChanges={hasUncommittedChanges}
      />
    </div>
  );
}
