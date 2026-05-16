"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  lazy,
  Suspense,
} from "react";
import {
  computeCurrentMessageIndex,
  getNextMessageIndex,
  getPrevMessageIndex,
  type ScrollEdgePosition,
} from "@/lib/conversation-nav";
import { useRouter } from "next/navigation";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
  findBusyOtherConversations,
} from "@/lib/session-derived";
import { buildConversationContext } from "@/lib/copy-context";
import {
  useSessionQuery,
  useConversationMessagesQuery,
  useSessionDiffQuery,
  useCommitsQuery,
  useConversationsQuery,
  useCollaborationListQuery,
  useReferenceDocumentsQuery,
} from "@/lib/queries";
import {
  useCollaborationStartMutation,
  useCollaborationResumeMutation,
  useCollaborationStopMutation,
  useDebugModeToggleMutation,
  useDeleteSessionMutation,
  useFinalizeInitializationMutation,
  useForkConversationMutation,
  useTddToggleMutation,
  useUpdatePendingPromptTextMutation,
  sendPendingPromptBeacon,
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
  useShowDeleteConfirm,
  useShowCommitDialog,
  useShowMergeDialog,
  useInfoExpanded,
  useSwitchLayout,
  useHydrateLayout,
  useSwitchMobilePanel,
  useDismissError,
  useDismissCancelled,
  useReconcileMessages,
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
  useSwitchRightPaneTab,
  useSidebarCollapsed,
  useToggleSidebar,
  useOpenDocById,
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
import SyntheticForkBadge from "./SyntheticForkBadge";
import ConfirmDialog from "@/components/ConfirmDialog";
import MessageContent from "@/components/MessageContent";
import MessageActions from "@/components/MessageActions";
import ConversationNav from "@/components/ConversationNav";
import { VoiceRecordButton } from "@/components/VoiceRecordButton";
import type { PromptEditorHandle } from "./PromptEditor";

const PromptEditor = lazy(() =>
  import("./PromptEditor").then((m) => ({ default: m.PromptEditor })),
);
import ModelSelector from "@/components/ModelSelector";
import { getModelsForBackend } from "@/components/ModelSelector";
import ReasoningLevelSelector, {
  EFFORT_OPTIONS,
} from "@/components/ReasoningLevelSelector";
import MobilePromptToolbar from "./MobilePromptToolbar";
import BackendToggle from "@/components/BackendToggle";
import ConversationMcpConfig from "@/components/mcp/ConversationMcpConfig";
import SessionMcpChip from "@/components/mcp/SessionMcpChip";
import SessionMcpModal from "@/components/mcp/SessionMcpModal";
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
import { useImageIndexCountQuery } from "@/hooks/use-image-index-count";
import ImageAttachmentPreview from "./ImageAttachmentPreview";
import type { ImagePayload, TranscriptMessage } from "@/types";
import CopyableId from "@/components/CopyableId";
import InfoDetailsPopover from "./InfoDetailsPopover";
import MobileActionMenu from "@/components/MobileActionMenu";
import DevServerDrawer from "@/components/DevServerDrawer";
import { useDevServers } from "@/hooks/use-dev-servers";
import {
  useDevServerDrawerOpen,
  useToggleDevServerDrawer,
  useCloseDevServerDrawer,
} from "@/stores/dev-server-drawer.store";
import {
  useCollabConfigDraft,
  useSetCollabConfigDraft,
  useClearCollabConfigDraft,
  useUserAnswerDrafts,
  useSetUserAnswerDraft,
  useClearUserAnswerDrafts,
} from "@/stores/collaboration.store";
import CollabConfigRow from "./collab/CollabConfigRow";
import CollabPassage, { isCollabPassageTerminal } from "./collab/CollabPassage";
import { envelopeToCollabPassageProps } from "./collab/envelope-adapter";
import { resolveRefToDocumentId } from "./collab/ref-resolver";
import ConversationVirtuosoList, {
  type ConversationVirtuosoListProps,
  type VirtuosoHandle,
} from "./ConversationVirtuosoList";
import {
  buildConversationRows,
  isCollabTriggerMessage,
  topmostMessageIndexForRange,
} from "./conversation-rows";
import type {
  CollaborationArtifact,
  CollaborationReference,
} from "@/lib/workflows/collaboration/types";

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

/** Extract directory name after `.worktrees/` for compact display. */
function shortenWorktreePath(fullPath: string): string {
  const marker = ".worktrees/";
  const idx = fullPath.indexOf(marker);
  if (idx === -1) return fullPath;
  return fullPath.slice(idx + marker.length);
}

function hasCollabPrefix(text: string): boolean {
  return text === "/collab" || text.startsWith("/collab ");
}

function stripCollabPrefix(text: string): string {
  if (text === "/collab") return "";
  if (text.startsWith("/collab ")) return text.slice("/collab ".length);
  return text;
}

const COLLAB_RUNNING_TOOLTIP =
  "collaboration in progress \u00b7 stop the run to continue";

interface CollabEnvelopeLike {
  status: "running" | "paused" | "completed" | "failed";
  featureSnapshot: unknown;
}

function findActiveCollab<T extends CollabEnvelopeLike>(
  envelopes: readonly T[] | undefined,
  conversationId: string,
): T | undefined {
  if (!envelopes) return undefined;
  return envelopes.find((envelope) => {
    if (envelope.status !== "running" && envelope.status !== "paused") {
      return false;
    }
    const snapshot = envelope.featureSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return false;
    }
    return (
      (snapshot as Record<string, unknown>)["conversationId"] === conversationId
    );
  });
}

function findCollabEnvelopeForConversation<T extends CollabEnvelopeLike>(
  envelopes: readonly T[] | undefined,
  conversationId: string,
): T | undefined {
  if (!envelopes) return undefined;
  const matching = envelopes.filter((envelope) => {
    const snapshot = envelope.featureSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return false;
    }
    return (
      (snapshot as Record<string, unknown>)["conversationId"] === conversationId
    );
  });
  if (matching.length === 0) return undefined;
  const active = matching.find(
    (envelope) => envelope.status === "running" || envelope.status === "paused",
  );
  return active ?? matching.at(-1);
}

function transcriptText(message: TranscriptMessage): string | null {
  return (
    message.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )?.text ?? null
  );
}

function latestFinalAnswerText(
  artifacts: readonly CollaborationArtifact[],
): string | null {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const artifact = artifacts[i];
    if (artifact?.kind === "final_answer") return artifact.answer;
  }
  return null;
}

function dedupeCollabFinalTranscriptMessage(
  messages: readonly TranscriptMessage[],
  finalAnswerText: string | null,
): TranscriptMessage[] {
  if (!finalAnswerText) return [...messages];
  const normalizedFinal = finalAnswerText.trim();
  if (normalizedFinal.length === 0) return [...messages];

  let latestCollabUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (isCollabTriggerMessage(message)) {
      latestCollabUserIndex = i;
      break;
    }
  }
  if (latestCollabUserIndex === -1) return [...messages];

  const duplicateIndex = messages.findIndex((message, index) => {
    if (index <= latestCollabUserIndex || message.role !== "assistant") {
      return false;
    }
    return transcriptText(message)?.trim() === normalizedFinal;
  });
  if (duplicateIndex === -1) return [...messages];
  return messages.filter((_, index) => index !== duplicateIndex);
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

  // --- TanStack Query ---
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);
  const collaborationListQuery = useCollaborationListQuery(
    projectName,
    sessionName,
    { includeAll: true },
  );

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
  const showDeleteConfirm = useShowDeleteConfirm();
  const showCommitDialog = useShowCommitDialog();
  const showMergeDialog = useShowMergeDialog();
  const infoExpanded = useInfoExpanded();

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
  const openDocById = useOpenDocById();

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
  const activeCollabEnvelope = findActiveCollab(
    collaborationListQuery.data,
    conversationId,
  );
  const collabEnvelopeForConversation = findCollabEnvelopeForConversation(
    collaborationListQuery.data,
    conversationId,
  );
  const hasActiveCollab = activeCollabEnvelope !== undefined;
  const isReadOnly =
    isFinished || isWorkflowManagedConversation || hasActiveCollab;
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
  const [sessionMcpModalOpen, setSessionMcpModalOpen] = useState(false);

  // Conditional polling: refetch while session is active
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
    { refetchInterval: isBusy ? 3000 : false },
  );
  const diffQuery = useSessionDiffQuery(projectName, sessionName);
  const commitsQuery = useCommitsQuery(projectName, sessionName);

  const rawMessages = useMemo(
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
  const collaborationStartMutation = useCollaborationStartMutation(
    projectName,
    sessionName,
  );
  const collabResumeMutation = useCollaborationResumeMutation(
    projectName,
    sessionName,
    collabEnvelopeForConversation?.workflowId ?? "",
  );
  const collabStopMutation = useCollaborationStopMutation(
    projectName,
    sessionName,
    collabEnvelopeForConversation?.workflowId ?? "",
  );
  const handleCollabStop = useCallback(() => {
    if (!collabEnvelopeForConversation) return;
    collabStopMutation.mutate({ conversationId });
  }, [collabEnvelopeForConversation, collabStopMutation, conversationId]);
  const collabUserAnswerDrafts = useUserAnswerDrafts(
    projectName,
    sessionName,
    collabEnvelopeForConversation?.workflowId ?? "",
  );
  const setCollabUserAnswerDraft = useSetUserAnswerDraft();
  const clearCollabUserAnswerDrafts = useClearUserAnswerDrafts();
  const collabPassageProps = useMemo(
    () =>
      collabEnvelopeForConversation
        ? envelopeToCollabPassageProps({
            workflowId: collabEnvelopeForConversation.workflowId,
            status: collabEnvelopeForConversation.status,
            phase: collabEnvelopeForConversation.phase,
            featureSnapshot: collabEnvelopeForConversation.featureSnapshot,
            ...(collabEnvelopeForConversation.errorSummary !== undefined
              ? { errorSummary: collabEnvelopeForConversation.errorSummary }
              : {}),
          })
        : null,
    [collabEnvelopeForConversation],
  );
  const collabPassageStatus = collabPassageProps?.status ?? null;
  const isCollabRunning =
    collabPassageStatus !== null &&
    !isCollabPassageTerminal(collabPassageStatus);
  const collabFinalAnswerText =
    collabPassageProps && isCollabPassageTerminal(collabPassageProps.status)
      ? latestFinalAnswerText(collabPassageProps.artifacts)
      : null;
  const messages = useMemo(
    () =>
      dedupeCollabFinalTranscriptMessage(rawMessages, collabFinalAnswerText),
    [rawMessages, collabFinalAnswerText],
  );
  const referenceDocumentsQuery = useReferenceDocumentsQuery(
    projectName,
    sessionName,
  );
  const referenceDocuments = useMemo(
    () => referenceDocumentsQuery.data ?? [],
    [referenceDocumentsQuery.data],
  );

  const handleCollabRefClick = useCallback(
    (ref: CollaborationReference) => {
      const docId = resolveRefToDocumentId(ref.artifact, referenceDocuments);
      if (docId) {
        openDocById(docId);
      }
    },
    [referenceDocuments, openDocById],
  );

  // --- Prompt streaming ---
  const {
    send: sendPrompt,
    queue: queueMessage,
    abortClient,
  } = useSendPrompt(projectName, sessionName, conversationId);
  const abortPrompt = useAbortPrompt(projectName, sessionName, conversationId);

  // --- Local state ---
  const [promptText, setPromptText] = useState("");
  const collabConfigDraft = useCollabConfigDraft(
    projectName,
    sessionName,
    conversationId,
  );
  const setCollabConfigDraft = useSetCollabConfigDraft();
  const clearCollabConfigDraft = useClearCollabConfigDraft();
  const hasCollabChip = hasCollabPrefix(promptText);
  const originatingCollabAgent: "claude" | "codex" =
    activeConversation?.agentBackend === "codex" ? "codex" : "claude";
  const effectiveCollabConfig = useMemo(
    () =>
      collabConfigDraft.secondAgent === originatingCollabAgent
        ? {
            ...collabConfigDraft,
            secondAgent:
              originatingCollabAgent === "claude"
                ? ("codex" as const)
                : ("claude" as const),
          }
        : collabConfigDraft,
    [collabConfigDraft, originatingCollabAgent],
  );
  // When the user submits a prompt while another conversation in this session
  // is actively running, we surface a confirmation dialog rather than blocking.
  // The pending submission is captured here while the user decides; on
  // confirm we replay it, on cancel we drop it (the input keeps its text).
  const [pendingConcurrentSubmission, setPendingConcurrentSubmission] =
    useState<{
      text: string;
      images: ImagePayload[];
      busyNames: string[];
    } | null>(null);
  // Initialize backend/model/effort consistently from the active conversation's
  // stored backend. The Claude `defaultModel` from server config must not leak
  // into a Codex conversation — picking the first backend-appropriate model
  // keeps these in sync from the very first render.
  const [selectedBackend, setSelectedBackend] = useState<AgentBackendId>(
    () => activeConversation?.agentBackend ?? "claude",
  );
  const backendLocked = (activeConversation?.promptCount ?? 0) > 0;

  // Sync backend/model/effort when switching conversations or when the
  // server backend changes on a locked conversation (promptCount > 0).
  // When the backend isn't locked yet, the user's local toggle is
  // authoritative — server refetches must not overwrite it.
  const activeBackend = activeConversation?.agentBackend;
  const prevConversationIdRef = useRef(conversationId);
  useEffect(() => {
    if (!activeConversation) return;
    const backend = activeConversation.agentBackend ?? "claude";
    const isConversationSwitch =
      prevConversationIdRef.current !== conversationId;
    prevConversationIdRef.current = conversationId;

    if (backend === selectedBackend) return;
    // On a conversation switch, always adopt the stored backend.
    // On a server refetch within the same conversation, only sync
    // when the backend is locked (at least one prompt sent).
    if (!isConversationSwitch && (activeConversation.promptCount ?? 0) === 0) {
      return;
    }
    setSelectedBackend(backend);
    const models = getModelsForBackend(backend);
    setSelectedModel(models[0]!.id);
    const levels = getEffortLevelsForBackend(backend, models[0]!.id);
    setSelectedEffort(levels.includes("high") ? "high" : levels[0]!);
  }, [conversationId, activeBackend]); // eslint-disable-line react-hooks/exhaustive-deps -- reset on conversation switch or backend change

  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const backend = activeConversation?.agentBackend ?? "claude";
    const models = getModelsForBackend(backend);
    return models.some((m) => m.id === defaultModel)
      ? defaultModel
      : models[0]!.id;
  });
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(() => {
    const backend = activeConversation?.agentBackend ?? "claude";
    const models = getModelsForBackend(backend);
    const initialModel = models.some((m) => m.id === defaultModel)
      ? defaultModel
      : models[0]!.id;
    const levels = getEffortLevelsForBackend(backend, initialModel);
    if (levels.length === 0) return defaultEffort;
    if (levels.includes(defaultEffort)) return defaultEffort;
    return levels.includes("high") ? "high" : levels[0]!;
  });
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

  const editorRef = useRef<PromptEditorHandle>(null);
  const promptTextRef = useRef(promptText);
  promptTextRef.current = promptText;
  const fireAndForgetRef = useRef(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Persistent pending prompt text ---
  // Restore typed-but-unsent prompt text from `conversation.pendingPromptText`
  // when the conversation mounts (or the user switches into it), and debounce
  // typing back to the server. Submit clears both local state and the server
  // value before the agent is invoked.
  const updatePendingPromptMutation = useUpdatePendingPromptTextMutation(
    projectName,
    sessionName,
  );
  const updatePendingPromptMutate = updatePendingPromptMutation.mutate;
  const hydratedConversationIdRef = useRef<string | null>(null);
  const lastPersistedPendingPromptRef = useRef<string | null>(null);
  const pendingPromptSaveTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const persistPendingPromptText = useCallback(
    (text: string | null) => {
      if (lastPersistedPendingPromptRef.current === text) return;
      lastPersistedPendingPromptRef.current = text;
      updatePendingPromptMutate({ conversationId, text });
    },
    [updatePendingPromptMutate, conversationId],
  );

  const cancelPendingPromptDebounce = useCallback(() => {
    if (pendingPromptSaveTimerRef.current !== null) {
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
    }
  }, []);

  // Fire the pending debounced save immediately for the given conversationId.
  // Used on conversation switch and unmount so drafts survive fast navigation
  // before the 500ms debounce fires.
  const flushPendingPromptText = useCallback(
    (capturedConversationId: string) => {
      if (pendingPromptSaveTimerRef.current === null) return;
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      lastPersistedPendingPromptRef.current = normalized;
      updatePendingPromptMutate({
        conversationId: capturedConversationId,
        text: normalized,
      });
    },
    [updatePendingPromptMutate],
  );

  const clearPersistedPendingPromptOnSubmit = useCallback(() => {
    cancelPendingPromptDebounce();
    persistPendingPromptText(null);
  }, [cancelPendingPromptDebounce, persistPendingPromptText]);

  // --- Image attachments ---
  const { pendingImages, addImage, removeImage, clearImages, isAtLimit } =
    useImageAttachments();
  const [inlineMarkerIds, setInlineMarkerIds] = useState<string[]>([]);
  const cumulativeImageCountQuery = useImageIndexCountQuery(
    projectName,
    sessionName,
    conversationId,
  );
  const cumulativeImageCount = cumulativeImageCountQuery.data ?? 0;
  const failPrompt = useFailPrompt();

  const debugToggleMutation = useDebugModeToggleMutation(
    projectName,
    sessionName,
    conversationId,
  );

  // --- Refs for message navigation ---
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  const [collabPinnedTopTarget, setCollabPinnedTopTarget] =
    useState<HTMLDivElement | null>(null);
  const [collabRowEl, setCollabRowEl] = useState<HTMLDivElement | null>(null);
  const [isCollabPassageInView, setIsCollabPassageInView] =
    useState<boolean>(false);

  useEffect(() => {
    if (!collabRowEl) {
      setIsCollabPassageInView(false);
      return;
    }
    const root = panelBodyRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setIsCollabPassageInView(entry.isIntersecting);
      },
      { root, threshold: 0 },
    );
    observer.observe(collabRowEl);
    return () => observer.disconnect();
  }, [collabRowEl]);

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
    clearConversationMessages();
    // Reset the persistent-prompt hydration gate so the input is re-prefilled
    // from the new conversation's pendingPromptText on the next data fetch.
    hydratedConversationIdRef.current = null;
    lastPersistedPendingPromptRef.current = null;
    cancelPendingPromptDebounce();

    // Reset any accidental scroll on ancestors (overflow:clip prevents new
    // occurrences; this cleans up any pre-existing scroll offset).
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [conversationId, clearConversationMessages, cancelPendingPromptDebounce]);

  // --- Hydrate prompt input from conversation.pendingPromptText (once per
  // conversation switch) ---
  // The Tiptap editor inside <PromptEditor> only consumes `value` as its
  // initial content, so we also push into the editor instance imperatively
  // for the case where the editor mounts before the conversation data
  // arrives.
  useEffect(() => {
    if (!activeConversation) return;
    if (hydratedConversationIdRef.current === conversationId) return;

    const initial = activeConversation.pendingPromptText ?? "";
    hydratedConversationIdRef.current = conversationId;
    lastPersistedPendingPromptRef.current =
      activeConversation.pendingPromptText;
    setPromptText(initial);
    // Always reset the editor — when switching from a conversation with a
    // draft to one with no pending text, the Tiptap instance must be cleared
    // because <PromptEditor> consumes `value` only as initial content and is
    // not keyed on conversationId.
    const editorInstance = editorRef.current?.editor;
    if (editorInstance) {
      if (initial.length > 0) {
        editorInstance.commands.setContent(initial);
      } else {
        editorInstance.commands.clearContent(true);
      }
    }
  }, [conversationId, activeConversation]);

  // If the user starts typing before activeConversation has loaded, mark
  // hydration as complete so the hydration effect above doesn't later
  // overwrite their input when data arrives. The user's text is the source
  // of truth; whatever was persisted will be overwritten by the next
  // debounced save.
  const handlePromptTextChange = useCallback(
    (next: string) => {
      if (hydratedConversationIdRef.current !== conversationId) {
        hydratedConversationIdRef.current = conversationId;
      }
      setPromptText(next);
    },
    [conversationId],
  );

  // --- Flush pending debounced save on conversation switch / unmount ---
  // The cleanup function captures the previous conversationId, so when the
  // user navigates away or switches conversations before the 500ms debounce
  // timer fires, the in-flight draft is still POSTed to the server and will
  // be restored on next mount.
  useEffect(() => {
    const capturedConversationId = conversationId;
    return () => {
      flushPendingPromptText(capturedConversationId);
    };
  }, [conversationId, flushPendingPromptText]);

  // --- Flush pending debounced save on full page reload via sendBeacon ---
  // The regular fetch from useMutation may be aborted when the page unloads,
  // so we use navigator.sendBeacon (which is delivery-guaranteed on unload)
  // to flush any pending draft. The URL and payload format are shared with
  // the mutation hook via `sendPendingPromptBeacon`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleBeforeUnload = () => {
      if (pendingPromptSaveTimerRef.current === null) return;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      const queued = sendPendingPromptBeacon(
        projectName,
        sessionName,
        conversationId,
        normalized,
      );
      if (queued) {
        lastPersistedPendingPromptRef.current = normalized;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [projectName, sessionName, conversationId]);

  // --- Debounced save of typed prompt text ---
  useEffect(() => {
    if (hydratedConversationIdRef.current !== conversationId) return;

    const normalized = promptText === "" ? null : promptText;
    if (normalized === lastPersistedPendingPromptRef.current) return;

    cancelPendingPromptDebounce();
    pendingPromptSaveTimerRef.current = setTimeout(() => {
      pendingPromptSaveTimerRef.current = null;
      persistPendingPromptText(normalized);
    }, 500);

    return cancelPendingPromptDebounce;
  }, [
    promptText,
    conversationId,
    persistPendingPromptText,
    cancelPendingPromptDebounce,
  ]);

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

  // --- Virtuoso conversation rows ---

  const rows = useMemo(
    () => buildConversationRows(displayMessages, collabEnvelopeForConversation),
    [displayMessages, collabEnvelopeForConversation],
  );
  const programmaticNavTargetRef = useRef<number | null>(null);
  const clearProgrammaticNavTargetRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  useEffect(() => {
    return () => {
      if (clearProgrammaticNavTargetRef.current) {
        clearTimeout(clearProgrammaticNavTargetRef.current);
      }
    };
  }, []);

  const holdProgrammaticNavTarget = useCallback((messageIndex: number) => {
    programmaticNavTargetRef.current = messageIndex;
    if (clearProgrammaticNavTargetRef.current) {
      clearTimeout(clearProgrammaticNavTargetRef.current);
    }
    clearProgrammaticNavTargetRef.current = setTimeout(() => {
      programmaticNavTargetRef.current = null;
      clearProgrammaticNavTargetRef.current = null;
    }, 1500);
  }, []);

  // --- Scroll-derived navigation state ---
  // `currentMessageIndex` is computed from the actual scroll position so the
  // counter always reflects what the user sees. Virtuoso reports row ranges
  // and edge transitions, while message navigation remains message-index based.
  const [navState, setNavState] = useState<{
    topmostMessageIndex: number;
    edgePosition: ScrollEdgePosition;
    atBottom: boolean;
    atTop: boolean;
  }>({
    topmostMessageIndex: 0,
    edgePosition: "top",
    atBottom: false,
    atTop: true,
  });

  const handleRangeChanged = useCallback(
    ({ startIndex }: { startIndex: number; endIndex: number }) => {
      const topmostMessageIndex =
        programmaticNavTargetRef.current ??
        topmostMessageIndexForRange(rows, startIndex);
      setNavState((prev) =>
        prev.topmostMessageIndex === topmostMessageIndex
          ? prev
          : { ...prev, topmostMessageIndex },
      );
    },
    [rows],
  );

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setNavState((prev) =>
      prev.atBottom === atBottom
        ? prev
        : {
            ...prev,
            atBottom,
            edgePosition: atBottom ? "bottom" : prev.atTop ? "top" : "middle",
          },
    );
  }, []);

  const handleAtTopStateChange = useCallback((atTop: boolean) => {
    setNavState((prev) =>
      prev.atTop === atTop
        ? prev
        : {
            ...prev,
            atTop,
            edgePosition: prev.atBottom ? "bottom" : atTop ? "top" : "middle",
          },
    );
  }, []);

  const currentMessageIndex = useMemo(
    () =>
      computeCurrentMessageIndex({
        topmostMessageIndex: navState.topmostMessageIndex,
        edgePosition: navState.edgePosition,
        totalMessages: displayMessages.length,
      }),
    [navState, displayMessages.length],
  );

  const scrollToMessage = useCallback(
    (messageIdx: number) => {
      const clamped = Math.max(
        0,
        Math.min(messageIdx, displayMessages.length - 1),
      );
      const rowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.messageIndex === clamped,
      );
      if (rowIndex === -1) return;
      holdProgrammaticNavTarget(clamped);
      setNavState((prev) => ({
        ...prev,
        topmostMessageIndex: clamped,
        edgePosition: clamped === 0 ? "top" : "middle",
        atTop: clamped === 0,
        atBottom: false,
      }));
      virtuosoRef.current?.scrollToIndex({
        index: rowIndex,
        align: "start",
        behavior: "smooth",
      });
    },
    [displayMessages.length, holdProgrammaticNavTarget, rows],
  );

  const scrollToTop = useCallback(() => {
    holdProgrammaticNavTarget(0);
    virtuosoRef.current?.scrollToIndex({
      index: 0,
      align: "start",
      behavior: "smooth",
    });
  }, [holdProgrammaticNavTarget]);

  const scrollToBottom = useCallback(
    (behavior: "auto" | "smooth" = "smooth") => {
      holdProgrammaticNavTarget(Math.max(0, displayMessages.length - 1));
      virtuosoRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior,
      });
    },
    [displayMessages.length, holdProgrammaticNavTarget],
  );

  const handleFirstMessage = useCallback(() => {
    if (displayMessages.length === 0) return;
    scrollToTop();
  }, [displayMessages.length, scrollToTop]);

  const handleLastMessage = useCallback(() => {
    if (displayMessages.length === 0) return;
    scrollToBottom();
  }, [displayMessages.length, scrollToBottom]);

  const handlePrevMessage = useCallback(() => {
    const target = getPrevMessageIndex({ currentIndex: currentMessageIndex });
    if (target === null) return;
    if (target === 0) {
      scrollToTop();
    } else {
      scrollToMessage(target);
    }
  }, [currentMessageIndex, scrollToMessage, scrollToTop]);

  const handleNextMessage = useCallback(() => {
    const target = getNextMessageIndex({
      currentIndex: currentMessageIndex,
      totalMessages: displayMessages.length,
    });
    if (target === null) return;
    if (target === displayMessages.length - 1) {
      scrollToBottom();
    } else {
      scrollToMessage(target);
    }
  }, [
    currentMessageIndex,
    displayMessages.length,
    scrollToMessage,
    scrollToBottom,
  ]);

  // Hotkey bindings — message navigation
  useAppHotkey("nextMessage", handleNextMessage);
  useAppHotkey("prevMessage", handlePrevMessage);
  useAppHotkey("firstMessage", handleFirstMessage);
  useAppHotkey("lastMessage", handleLastMessage);

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
      editorRef.current?.clear();
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

  const dispatchPrompt = useCallback(
    async (text: string, images: ImagePayload[]) => {
      // Clear the persisted pendingPromptText BEFORE invoking the agent so a
      // slow agent response can't resurrect stale input on reload.
      clearPersistedPendingPromptOnSubmit();
      editorRef.current?.clear();
      setPromptText("");
      clearImages();
      await sendPrompt(
        text,
        messages.length,
        selectedModel,
        images.length > 0 ? images : undefined,
        effortSupported ? selectedEffort : undefined,
        selectedBackend,
      );
    },
    [
      sendPrompt,
      messages.length,
      selectedModel,
      effortSupported,
      selectedEffort,
      selectedBackend,
      clearImages,
      clearPersistedPendingPromptOnSubmit,
    ],
  );

  const handleSendPrompt = useCallback(async () => {
    const serialized = editorRef.current?.serialize(pendingImages) ?? {
      prompt: promptTextRef.current,
      images: [],
    };
    const trimmedPrompt = serialized.prompt.trim();
    const hasImages = serialized.images.length > 0;
    if (!trimmedPrompt && !hasImages) return;

    if (hasCollabPrefix(trimmedPrompt)) {
      const brief = stripCollabPrefix(trimmedPrompt).trim();
      if (!brief) return;
      clearPersistedPendingPromptOnSubmit();
      editorRef.current?.clear();
      setPromptText("");
      collaborationStartMutation.mutate({
        brief,
        negotiationRounds: effectiveCollabConfig.negotiationRounds,
        autonomousResolutionThreshold:
          effectiveCollabConfig.autonomousResolutionThreshold,
        conversationId,
      });
      clearCollabConfigDraft(projectName, sessionName, conversationId);
      return;
    }

    // Queue into running conversation instead of starting a new prompt
    if (sending && conversationId) {
      clearPersistedPendingPromptOnSubmit();
      editorRef.current?.clear();
      setPromptText("");
      await queueMessage(trimmedPrompt);
      return;
    }

    if (sending) return;

    const imagePayloads: ImagePayload[] = hasImages ? serialized.images : [];

    // Warn — but do not block — when other conversations in this session are
    // actively running. Trust the user; concurrent edits in the same worktree
    // can step on each other but read-only / review prompts are fine.
    const busyOthers = findBusyOtherConversations(
      conversations,
      conversationId,
    );
    if (busyOthers.length > 0) {
      setPendingConcurrentSubmission({
        text: trimmedPrompt,
        images: imagePayloads,
        busyNames: busyOthers.map((c, i) => c.name ?? `Conversation ${i + 1}`),
      });
      return;
    }

    await dispatchPrompt(trimmedPrompt, imagePayloads);
  }, [
    sending,
    conversationId,
    queueMessage,
    pendingImages,
    collaborationStartMutation,
    effectiveCollabConfig.negotiationRounds,
    effectiveCollabConfig.autonomousResolutionThreshold,
    clearCollabConfigDraft,
    projectName,
    sessionName,
    conversations,
    dispatchPrompt,
    clearPersistedPendingPromptOnSubmit,
  ]);

  const confirmConcurrentSubmission = useCallback(async () => {
    if (!pendingConcurrentSubmission) return;
    const { text, images } = pendingConcurrentSubmission;
    setPendingConcurrentSubmission(null);
    await dispatchPrompt(text, images);
  }, [pendingConcurrentSubmission, dispatchPrompt]);

  const cancelConcurrentSubmission = useCallback(() => {
    setPendingConcurrentSubmission(null);
  }, []);

  const handleDebugPrompt = useCallback(
    (text: string): Promise<void> =>
      sendPrompt(
        text,
        messages.length,
        selectedModel,
        undefined,
        undefined,
        selectedBackend,
      ),
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

  // --- Fork handler ---

  const forkConversationMutation = useForkConversationMutation(
    projectName,
    sessionName,
  );
  const forkMutateAsync = forkConversationMutation.mutateAsync;

  const handleFork = useCallback(
    async (messageIndex: number) => {
      try {
        const result = await forkMutateAsync({ conversationId, messageIndex });
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${result.conversationId}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Fork failed";
        failPrompt(message);
      }
    },
    [
      forkMutateAsync,
      projectName,
      sessionName,
      conversationId,
      router,
      failPrompt,
    ],
  );

  const handleVoiceResult = useCallback(
    (text: string) => {
      const insertion = promptTextRef.current.trim() ? `\n${text}` : text;
      editorRef.current?.insertText(insertion);
      requestAnimationFrame(() => editorRef.current?.focus());

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

  const renderMessageRow = useCallback<
    ConversationVirtuosoListProps["renderMessage"]
  >(
    ({ row }) => {
      const { messageIndex, msg } = row;
      const isUserMsg = msg.role === "user";
      return (
        <div className={`message ${msg.role}`} data-msg-index={messageIndex}>
          <div className="message-role">
            {isUserMsg
              ? "You"
              : selectedBackend === "codex"
                ? "Codex"
                : "Claude"}
            {!isUserMsg && (msg.model || msg.effort) && (
              <span className="message-meta">
                <span className="message-meta-sep">&middot;</span>
                {msg.model && (
                  <span className="message-meta-model">{msg.model}</span>
                )}
                {msg.model && msg.effort && (
                  <span className="message-meta-sep">&middot;</span>
                )}
                {msg.effort && (
                  <span
                    className={`message-meta-effort${msg.effort === "max" || msg.effort === "xhigh" ? " rainbow-text" : ""}`}
                  >
                    {msg.effort}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="message-content">
            <MessageContent
              content={msg.content}
              worktreePath={session?.worktreePath}
            />
          </div>
          {!isUserMsg &&
            messageIndex === displayMessages.length - 1 &&
            activeConversation && (
              <DebugActionCard
                projectName={projectName}
                sessionName={sessionName}
                conversation={activeConversation}
                onSendPrompt={handleDebugPrompt}
                isBusy={isBusy}
              />
            )}
          <MessageActions
            messageIndex={messageIndex}
            content={msg.content}
            onFork={handleFork}
          />
        </div>
      );
    },
    [
      activeConversation,
      displayMessages.length,
      handleDebugPrompt,
      handleFork,
      isBusy,
      projectName,
      selectedBackend,
      session?.worktreePath,
      sessionName,
    ],
  );

  const renderCollabRow = useCallback<
    ConversationVirtuosoListProps["renderCollab"]
  >(() => {
    if (!collabPassageProps || !collabEnvelopeForConversation) return null;
    return (
      <div ref={setCollabRowEl} data-collab-row="true">
        <CollabPassage
          {...collabPassageProps}
          onStop={handleCollabStop}
          hideInlinePhaseStrip={isCollabRunning}
          pinnedTopTarget={collabPinnedTopTarget}
          pauseHandlers={
            collabEnvelopeForConversation.status === "paused" &&
            collabEnvelopeForConversation.pause?.resumeToken
              ? {
                  drafts: collabUserAnswerDrafts,
                  onDraftChange: (q, value) =>
                    setCollabUserAnswerDraft(
                      projectName,
                      sessionName,
                      collabEnvelopeForConversation.workflowId,
                      q,
                      value,
                    ),
                  onSubmit: () => {
                    const resumeToken =
                      collabEnvelopeForConversation.pause!.resumeToken;
                    const userAnswers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(
                      collabUserAnswerDrafts,
                    )) {
                      if (typeof v === "string" && v.trim().length > 0) {
                        userAnswers[k] = v.trim();
                      }
                    }
                    collabResumeMutation.mutate(
                      {
                        resumeToken,
                        conversationId,
                        userAnswers,
                      },
                      {
                        onSuccess: () => {
                          clearCollabUserAnswerDrafts(
                            projectName,
                            sessionName,
                            collabEnvelopeForConversation.workflowId,
                          );
                        },
                      },
                    );
                  },
                  isSubmitting: collabResumeMutation.isPending,
                }
              : undefined
          }
          onRefClick={handleCollabRefClick}
        />
      </div>
    );
  }, [
    clearCollabUserAnswerDrafts,
    collabEnvelopeForConversation,
    collabPassageProps,
    collabPinnedTopTarget,
    collabResumeMutation,
    collabUserAnswerDrafts,
    conversationId,
    handleCollabRefClick,
    handleCollabStop,
    isCollabRunning,
    projectName,
    sessionName,
    setCollabUserAnswerDraft,
  ]);

  const renderTypingIndicator = useCallback(() => {
    if (hasActiveCollab) return null;
    if (!sending && displayStatus !== "running") return null;
    return optimisticMessages.some((m) => m.role === "assistant") ? (
      <div className="streaming-indicator" data-backend={selectedBackend}>
        <div className="typing-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    ) : (
      <div
        className="message assistant typing-indicator"
        data-backend={selectedBackend}
      >
        <div className="message-role">
          {selectedBackend === "codex" ? "Codex" : "Claude"}
        </div>
        <div className="message-content">
          <div className="typing-dots">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    );
  }, [
    displayStatus,
    hasActiveCollab,
    optimisticMessages,
    selectedBackend,
    sending,
  ]);

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
              {/* Branch — primary identifier */}
              <CopyableId
                label="Branch"
                value={session.branchName}
                truncateAt={999}
              />
              {/* Backend badge */}
              {(() => {
                const conv = session.conversations.find(
                  (c) => c.id === conversationId,
                );
                if (!conv) return null;
                return (
                  <span className="cc-badge" data-backend={conv.agentBackend}>
                    {conv.agentBackend}
                  </span>
                );
              })()}
              {/* Prompt count */}
              <div className="si-item">
                <span className="si-label">Prompts</span>
                <span className="si-val si-val--bright">
                  {deriveSessionPromptCount(session)}
                </span>
              </div>
              {/* Worktree — shortened, click copies full path */}
              <CopyableId
                label="Worktree"
                value={session.worktreePath}
                displayValue={shortenWorktreePath(session.worktreePath)}
              />
              {/* Context fill indicator */}
              {contextPercent != null && (
                <ContextFillIndicator percentage={contextPercent} />
              )}
              {/* Copy context button */}
              <button
                className="si-copy-context-btn"
                onClick={handleCopyContext}
                data-tooltip={
                  contextCopied ? "Copied!" : "Copy context to clipboard"
                }
              >
                {contextCopied ? "\u2713" : "\u2398"} Context
              </button>
              {/* MCP servers summary chip */}
              <SessionMcpChip
                projectName={projectName}
                sessionName={sessionName}
                onClick={() => setSessionMcpModalOpen(true)}
              />
              {/* Details popover — Conv ID, Session Ref, Created, full Worktree */}
              <InfoDetailsPopover
                conversationId={conversationId}
                backendRef={
                  session.conversations.find((c) => c.id === conversationId)
                    ?.backendRef ?? null
                }
                createdAt={session.createdAt}
                worktreePath={session.worktreePath}
                onOpenMcpServers={() => setSessionMcpModalOpen(true)}
              />
            </div>
          </div>

          <SessionMcpModal
            projectName={projectName}
            sessionName={sessionName}
            open={sessionMcpModalOpen}
            onClose={() => setSessionMcpModalOpen(false)}
          />

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
                {activeConversation?.forkedFrom?.forkMode === "synthetic" && (
                  <SyntheticForkBadge />
                )}
                <ConversationNav
                  currentIndex={currentMessageIndex}
                  totalCount={displayMessages.length}
                  onFirst={handleFirstMessage}
                  onPrevious={handlePrevMessage}
                  onNext={handleNextMessage}
                  onLast={handleLastMessage}
                />
              </div>
              {contextPercent != null && (
                <div className="mobile-context-fill">
                  <ContextFillIndicator percentage={contextPercent} />
                </div>
              )}
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
              <div
                className="panel-body"
                ref={panelBodyRef}
                {...(activeConversation?.debugMode?.active
                  ? { "data-debug-mode": "" }
                  : {})}
              >
                <div className="conversation" data-backend={selectedBackend}>
                  <div
                    ref={setCollabPinnedTopTarget}
                    className="collab-pinned-top-target"
                    data-visible={isCollabPassageInView ? "true" : "false"}
                  />
                  {messagesQuery.isPending ? (
                    <div
                      className="empty-state"
                      style={{ padding: "var(--space-xl) 0" }}
                    >
                      <div className="empty-state-title">
                        Loading conversation...
                      </div>
                    </div>
                  ) : rows.length > 0 ? (
                    <ConversationVirtuosoList
                      rows={rows}
                      virtuosoRef={virtuosoRef}
                      conversationId={conversationId}
                      renderMessage={renderMessageRow}
                      renderCollab={renderCollabRow}
                      renderFooter={renderTypingIndicator}
                      onRangeChanged={handleRangeChanged}
                      onAtBottomStateChange={handleAtBottomStateChange}
                      onAtTopStateChange={handleAtTopStateChange}
                    />
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
                </div>
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
                    <Suspense fallback={null}>
                      <PromptEditor
                        ref={editorRef}
                        conversationId={conversationId}
                        value={promptText}
                        onChange={handlePromptTextChange}
                        onSubmit={() => {
                          if (isRecording) {
                            toggleRecording();
                            return;
                          }
                          void handleSendPrompt();
                        }}
                        pendingImages={pendingImages}
                        onAddImage={async (file) => {
                          const result = await addImage(file);
                          if (result.error) {
                            failPrompt(result.error);
                            return null;
                          }
                          return result.attachment;
                        }}
                        onRemoveImage={removeImage}
                        cumulativeImageCount={cumulativeImageCount}
                        onInlineMarkersChange={setInlineMarkerIds}
                        projectName={projectName}
                        sessionName={session.sessionName}
                        backend={selectedBackend}
                        onShowPlaceholder={showPlaceholder}
                        disabled={isReadOnly}
                        readOnly={hasActiveCollab}
                        title={
                          hasActiveCollab ? COLLAB_RUNNING_TOOLTIP : undefined
                        }
                        placeholder={
                          isFinished
                            ? "Session is merged and read-only"
                            : (promptPlaceholder ??
                              "Send a prompt to Claude...")
                        }
                      />
                    </Suspense>
                    {hasCollabChip ? (
                      <CollabConfigRow
                        config={effectiveCollabConfig}
                        originatingAgent={originatingCollabAgent}
                        onChange={(next) =>
                          setCollabConfigDraft(
                            projectName,
                            sessionName,
                            conversationId,
                            next,
                          )
                        }
                        onDismiss={() => {
                          setPromptText(stripCollabPrefix(promptText));
                          clearCollabConfigDraft(
                            projectName,
                            sessionName,
                            conversationId,
                          );
                        }}
                      />
                    ) : null}
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
                          void addImage(file).then((result) => {
                            if (result.error) failPrompt(result.error);
                          });
                        }
                        // Reset so re-selecting the same file works
                        e.target.value = "";
                      }}
                    />
                    <ImageAttachmentPreview
                      images={pendingImages.filter(
                        (img) => !inlineMarkerIds.includes(img.id),
                      )}
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
                        <ConversationMcpConfig
                          projectName={projectName}
                          sessionName={sessionName}
                          conversationId={conversationId}
                          turnRunning={conversationRunning}
                          disabled={isReadOnly}
                          disabledTooltip={
                            isReadOnly ? "Session is read-only" : undefined
                          }
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
                    <MobilePromptToolbar
                      modelOptions={getModelsForBackend(selectedBackend)}
                      effortOptions={EFFORT_OPTIONS.filter((o) =>
                        availableEffortLevels.includes(o.id),
                      )}
                      selectedModel={selectedModel}
                      selectedEffort={selectedEffort}
                      effortSupported={effortSupported}
                      effortDisabledReason={
                        !effortSupported
                          ? "Reasoning level is only available for Opus and Sonnet models"
                          : undefined
                      }
                      onSelectModel={handleModelChange}
                      onSelectEffort={setSelectedEffort}
                      backend={selectedBackend}
                      backendLocked={backendLocked}
                      onSelectBackend={handleBackendChange}
                      onAttach={() => fileInputRef.current?.click()}
                      attachDisabled={isAtLimit || sending}
                      debugActive={
                        activeConversation?.debugMode?.active ?? false
                      }
                      debugSupported={!!activeConversation}
                      onToggleDebug={() =>
                        debugToggleMutation.mutate(
                          activeConversation?.debugMode?.active
                            ? "exit"
                            : "enter",
                        )
                      }
                      debugDisabled={sending || debugToggleMutation.isPending}
                      mcpRow={
                        <div className="mobile-prompt-row mobile-prompt-row--mcp">
                          <ConversationMcpConfig
                            projectName={projectName}
                            sessionName={sessionName}
                            conversationId={conversationId}
                            turnRunning={conversationRunning}
                            disabled={isReadOnly}
                            disabledTooltip={
                              isReadOnly ? "Session is read-only" : undefined
                            }
                          />
                        </div>
                      }
                      isReadOnly={isReadOnly}
                      isBusy={sending && !conversationId}
                      voiceButton={
                        <VoiceRecordButton
                          isRecording={isRecording}
                          isProcessing={isProcessing}
                          elapsedTime={elapsedTime}
                          isAvailable={voiceAvailable}
                          toggleRecording={toggleRecording}
                          disabled={sending}
                        />
                      }
                      sendButton={
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
                      }
                    />
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
                  const refDisplay = conv.backendRef
                    ? conv.backendRef.backend === "claude"
                      ? conv.backendRef.sessionId
                      : conv.backendRef.backend === "codex"
                        ? conv.backendRef.threadId
                        : "\u2014"
                    : "\u2014";
                  return (
                    <>
                      <MobileInfoCopyRow
                        label="Backend"
                        value={conv.agentBackend}
                      />
                      <MobileInfoCopyRow
                        label="Session Ref"
                        value={refDisplay}
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

      <ConfirmDialog
        open={pendingConcurrentSubmission !== null}
        title="Another agent is working"
        message={
          pendingConcurrentSubmission
            ? `${
                pendingConcurrentSubmission.busyNames.length === 1
                  ? `${pendingConcurrentSubmission.busyNames[0]} is currently running`
                  : `${pendingConcurrentSubmission.busyNames.length} other conversations are currently running`
              } in this session. If this new agent edits files, its changes can conflict with the other agent's work in the same worktree. Continue anyway?`
            : ""
        }
        confirmLabel="Send anyway"
        onConfirm={() => {
          void confirmConcurrentSubmission();
        }}
        onCancel={cancelConcurrentSubmission}
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
