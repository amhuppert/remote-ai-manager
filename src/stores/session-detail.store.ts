import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  TranscriptMessage,
  MessageContentBlock,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type {
  DocumentRef,
  DocumentFeedbackTarget,
} from "@/lib/document-comments/schemas";
import type { LayoutMode } from "@/lib/sessions/schemas";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MobilePanel = "chat" | "diff" | "docs" | "specs" | "info";
type RightPaneTab = "diff" | "docs" | "specs" | "alignment" | "artifact";

/**
 * A one-shot "scroll the transcript to this message" request, set by surfaces
 * that live outside the conversation panel (e.g. the context-artifact panel's
 * source-ref chips) and consumed — then cleared — by the conversation nav hook
 * whose conversation matches.
 */
interface MessageNavRequest {
  conversationId: string;
  messageIndex: number;
}

interface SidebarSessionFilter {
  projectName: string;
  sessionName: string;
}

interface SpecBrowserSelection {
  /** "steering" or a feature name like "browser-notifications" */
  category: string;
  /** Selected filename like "design.md", or null if only category selected */
  file: string | null;
}

/**
 * The model/effort the in-flight turn runs with, stamped onto the optimistic
 * user + streaming assistant rows so MessageRow shows the same metadata while
 * the agent is still working as it does once the transcript rows land.
 */
export interface OptimisticAgentSettings {
  model?: string;
  effort?: string;
}

function agentSettingsStamp(
  settings: OptimisticAgentSettings | undefined,
): Pick<TranscriptMessage, "model" | "effort"> {
  return {
    ...(settings?.model !== undefined ? { model: settings.model } : {}),
    ...(settings?.effort !== undefined ? { effort: settings.effort } : {}),
  };
}

type OptimisticQueueStatus = "pending" | "accepted" | "failed";

interface OptimisticQueueEntry {
  /** Client-generated id, stable from optimistic add through rollback. */
  tempId: string;
  /** Server-assigned queue id, set once the enqueue is accepted. */
  queueId: string | null;
  content: MessageContentBlock[];
  status: OptimisticQueueStatus;
}

interface SessionDetailState {
  layout: LayoutMode;
  mobilePanel: MobilePanel;
  rightPaneTab: RightPaneTab;
  sending: boolean;
  isVoiceRecording: boolean;
  promptPlaceholder: string | null;
  promptError: string | null;
  promptCancelled: boolean;
  optimisticMessages: TranscriptMessage[];
  optimisticQueue: OptimisticQueueEntry[];
  messageCountBeforeSubmit: number;
  showDeleteConfirm: boolean;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  sidebarFilter: string;
  sidebarSessionFilter: SidebarSessionFilter | null;
  pendingQuestions: AskQuestionItem[] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  specBrowserSelection: SpecBrowserSelection | null;
  selectedDocId: string | null;
  composerFocused: boolean;
  // -- Document viewer (multi-doc shell) --
  /** Open documents shown as switchable tabs in the viewer (req 1.2). */
  openDocuments: DocumentRef[];
  /** The active document's normalized `docPath`, or null when none is open. */
  activeDocPath: string | null;
  /**
   * Monotonically increments on every open/activate so the viewer can flash the
   * body on activation (req 1.5) even when the same document is re-opened.
   */
  docActivationNonce: number;
  /** Whether the pending-comments tray's per-comment list is expanded (req 7). */
  pendingTrayExpanded: boolean;
  /** The chosen feedback send destination, retained across sends (req 9.4). */
  feedbackTarget: DocumentFeedbackTarget | null;
  /** Pending transcript-scroll request, or null when none is in flight. */
  messageNavRequest: MessageNavRequest | null;
}

interface SessionDetailActions {
  switchLayout: (mode: LayoutMode, storageKey: string) => void;
  hydrateLayout: (storageKey: string) => void;
  switchMobilePanel: (panel: MobilePanel) => void;
  switchRightPaneTab: (tab: RightPaneTab) => void;
  submitPrompt: (
    userContent: MessageContentBlock[],
    currentMessageCount: number,
    agentSettings?: OptimisticAgentSettings,
  ) => void;
  receiveStreamContent: (
    userContent: MessageContentBlock[],
    allBlocks: MessageContentBlock[],
    agentSettings?: OptimisticAgentSettings,
  ) => void;
  completePrompt: () => void;
  failPrompt: (error: string) => void;
  setQueueError: (error: string) => void;
  queueMessage: (userContent: MessageContentBlock[]) => void;
  addOptimisticQueueEntry(tempId: string, content: MessageContentBlock[]): void;
  acceptOptimisticQueueEntry(tempId: string, queueId: string): void;
  failOptimisticQueueEntry(tempId: string): void;
  cancelOptimisticQueueEntry(idOrTempId: string): void;
  rollbackOptimisticQueueEntry(tempId: string): void;
  dismissError: () => void;
  markCancelled: () => void;
  dismissCancelled: () => void;
  reconcileMessages: (serverCount: number) => void;
  startRecording: () => void;
  stopRecording: () => void;
  showPlaceholder: (text: string) => void;
  clearPlaceholder: () => void;
  requestDeleteSession: () => void;
  cancelDeleteSession: () => void;
  toggleSidebar: () => void;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
  hydrateSidebar: () => void;
  setSidebarFilter: (value: string) => void;
  setSidebarSessionFilter: (value: SidebarSessionFilter | null) => void;
  setComposerFocused: (focused: boolean) => void;
  showQuestions: (questionId: string, questions: AskQuestionItem[]) => void;
  navigateQuestion: (index: number) => void;
  clearQuestions: () => void;
  selectSpecCategory: (category: string) => void;
  selectSpecFile: (category: string, file: string) => void;
  clearSpecSelection: () => void;
  openDocById: (docId: string) => void;
  selectDocId: (docId: string | null) => void;
  openDocument: (ref: DocumentRef) => void;
  activateDocument: (docPath: string) => void;
  closeDocument: (docPath: string) => void;
  setPendingTrayExpanded: (expanded: boolean) => void;
  togglePendingTray: () => void;
  setFeedbackTarget: (target: DocumentFeedbackTarget) => void;
  openContextArtifactPanel: () => void;
  requestMessageNav: (conversationId: string, messageIndex: number) => void;
  clearMessageNavRequest: () => void;
  clearConversationMessages: () => void;
  resetConversationState: () => void;
  resetStore: () => void;
}

type SessionDetailStore = SessionDetailState & SessionDetailActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDEBAR_STORAGE_KEY = "cc-sidebar-collapsed";
let cancelledTimer: ReturnType<typeof setTimeout> | null = null;

const validLayouts: LayoutMode[] = [
  "conversation",
  "default",
  "split",
  "panes",
  "diff",
];

const initialState: SessionDetailState = {
  layout: "conversation",
  mobilePanel: "chat",
  rightPaneTab: "diff",
  sending: false,
  isVoiceRecording: false,
  promptPlaceholder: null,
  promptError: null,
  promptCancelled: false,
  optimisticMessages: [],
  optimisticQueue: [],
  messageCountBeforeSubmit: 0,
  showDeleteConfirm: false,
  sidebarCollapsed: false,
  mobileSidebarOpen: false,
  sidebarFilter: "",
  sidebarSessionFilter: null,
  pendingQuestions: null,
  pendingQuestionId: null,
  currentQuestionIndex: 0,
  specBrowserSelection: null,
  selectedDocId: null,
  composerFocused: false,
  openDocuments: [],
  activeDocPath: null,
  docActivationNonce: 0,
  pendingTrayExpanded: false,
  feedbackTarget: null,
  messageNavRequest: null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionDetailStore = create<SessionDetailStore>()(
  immer((set, get) => ({
    ...initialState,

    // -- Layout --

    switchLayout: (mode, storageKey) =>
      set((state) => {
        state.layout = mode;
        try {
          localStorage.setItem(storageKey, mode);
        } catch {
          // localStorage unavailable (SSR or quota)
        }
      }),

    hydrateLayout: (storageKey) => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved && validLayouts.includes(saved as LayoutMode)) {
          set((state) => {
            state.layout = saved as LayoutMode;
          });
        }
      } catch {
        // localStorage unavailable
      }
    },

    switchMobilePanel: (panel) =>
      set((state) => {
        state.mobilePanel = panel;
      }),

    switchRightPaneTab: (tab) =>
      set((state) => {
        state.rightPaneTab = tab;
      }),

    // -- Prompt streaming --

    submitPrompt: (userContent, currentMessageCount, agentSettings) =>
      set((state) => {
        state.sending = true;
        state.promptError = null;
        state.messageCountBeforeSubmit = currentMessageCount;
        state.optimisticMessages = [
          {
            role: "user",
            content: userContent,
            timestamp: new Date().toISOString(),
            ...agentSettingsStamp(agentSettings),
          },
        ];
      }),

    receiveStreamContent: (userContent, allBlocks, agentSettings) =>
      set((state) => {
        // Preserve any queued user messages appended after the initial pair
        const queued = state.optimisticMessages.slice(2);
        state.optimisticMessages = [
          {
            role: "user",
            content: userContent,
            timestamp: new Date().toISOString(),
            ...agentSettingsStamp(agentSettings),
          },
          {
            role: "assistant",
            content: [...allBlocks],
            timestamp: new Date().toISOString(),
            ...agentSettingsStamp(agentSettings),
          },
          ...queued,
        ];
      }),

    completePrompt: () =>
      set((state) => {
        state.sending = false;
      }),

    failPrompt: (error) =>
      set((state) => {
        state.promptError = error;
        state.sending = false;
      }),

    // Surface a queue failure to the user WITHOUT clearing `sending`: a queue
    // POST failing must leave the still-running turn shown as running (req 5.2)
    // while the error is visible (req 5.1). Distinct from `failPrompt`, which
    // also stops the running indicator.
    setQueueError: (error) =>
      set((state) => {
        state.promptError = error;
      }),

    queueMessage: (userContent) =>
      set((state) => {
        state.optimisticMessages.push({
          role: "user",
          content: userContent,
          timestamp: new Date().toISOString(),
        });
      }),

    // -- Optimistic queue --
    // Mutate ONLY optimisticQueue. The running/sending flag must never change
    // here: a queue failure must leave a still-running turn shown as running
    // (req 5.2) while removing the optimistic entry (req 5.3).

    addOptimisticQueueEntry: (tempId, content) =>
      set((state) => {
        state.optimisticQueue.push({
          tempId,
          queueId: null,
          content,
          status: "pending",
        });
      }),

    acceptOptimisticQueueEntry: (tempId, queueId) =>
      set((state) => {
        const entry = state.optimisticQueue.find((e) => e.tempId === tempId);
        if (!entry) return;
        entry.queueId = queueId;
        entry.status = "accepted";
      }),

    failOptimisticQueueEntry: (tempId) =>
      set((state) => {
        state.optimisticQueue = state.optimisticQueue.filter(
          (e) => e.tempId !== tempId,
        );
      }),

    cancelOptimisticQueueEntry: (idOrTempId) =>
      set((state) => {
        state.optimisticQueue = state.optimisticQueue.filter(
          (e) => e.tempId !== idOrTempId && e.queueId !== idOrTempId,
        );
      }),

    rollbackOptimisticQueueEntry: (tempId) =>
      set((state) => {
        state.optimisticQueue = state.optimisticQueue.filter(
          (e) => e.tempId !== tempId,
        );
      }),

    dismissError: () =>
      set((state) => {
        state.promptError = null;
      }),

    markCancelled: () => {
      if (cancelledTimer) clearTimeout(cancelledTimer);
      set((state) => {
        state.promptCancelled = true;
      });
      cancelledTimer = setTimeout(() => {
        cancelledTimer = null;
        set((state) => {
          state.promptCancelled = false;
        });
      }, 2500);
    },

    dismissCancelled: () =>
      set((state) => {
        state.promptCancelled = false;
      }),

    reconcileMessages: (serverCount) => {
      const { messageCountBeforeSubmit, optimisticMessages } = get();
      if (optimisticMessages.length === 0) return;
      if (serverCount <= messageCountBeforeSubmit) return;

      // Server has the prompt data — clear all optimistic messages.
      // (This is only called when sending=false, so the stream is done.)
      set((state) => {
        state.optimisticMessages = [];
      });
    },

    // -- Voice recording --

    startRecording: () =>
      set((state) => {
        state.isVoiceRecording = true;
      }),

    stopRecording: () =>
      set((state) => {
        state.isVoiceRecording = false;
      }),

    // -- Command placeholder --

    showPlaceholder: (text) =>
      set((state) => {
        state.promptPlaceholder = text;
      }),

    clearPlaceholder: () =>
      set((state) => {
        state.promptPlaceholder = null;
      }),

    // -- Dialogs --

    requestDeleteSession: () =>
      set((state) => {
        state.showDeleteConfirm = true;
      }),

    cancelDeleteSession: () =>
      set((state) => {
        state.showDeleteConfirm = false;
      }),

    // -- UI toggles --

    toggleSidebar: () =>
      set((state) => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        try {
          localStorage.setItem(
            SIDEBAR_STORAGE_KEY,
            String(state.sidebarCollapsed),
          );
        } catch {
          // localStorage unavailable
        }
      }),

    openMobileSidebar: () =>
      set((state) => {
        state.mobileSidebarOpen = true;
      }),

    closeMobileSidebar: () =>
      set((state) => {
        state.mobileSidebarOpen = false;
      }),

    hydrateSidebar: () => {
      try {
        const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY);
        if (saved === "true") {
          set((state) => {
            state.sidebarCollapsed = true;
          });
        }
      } catch {
        // localStorage unavailable
      }
    },

    setSidebarFilter: (value) =>
      set((state) => {
        state.sidebarFilter = value;
      }),

    setSidebarSessionFilter: (value) =>
      set((state) => {
        state.sidebarSessionFilter = value;
      }),

    setComposerFocused: (focused) =>
      set((state) => {
        state.composerFocused = focused;
      }),

    // -- AskUserQuestion --

    showQuestions: (questionId, questions) =>
      set((state) => {
        state.pendingQuestions = questions;
        state.pendingQuestionId = questionId;
        state.currentQuestionIndex = 0;
      }),

    navigateQuestion: (index) =>
      set((state) => {
        state.currentQuestionIndex = index;
      }),

    clearQuestions: () =>
      set((state) => {
        state.pendingQuestions = null;
        state.pendingQuestionId = null;
        state.currentQuestionIndex = 0;
      }),

    // -- Spec Browser --

    selectSpecCategory: (category) =>
      set((state) => {
        state.specBrowserSelection = { category, file: null };
      }),

    selectSpecFile: (category, file) =>
      set((state) => {
        state.specBrowserSelection = { category, file };
      }),

    clearSpecSelection: () =>
      set((state) => {
        state.specBrowserSelection = null;
      }),

    // -- Docs Panel --

    openDocById: (docId) =>
      set((state) => {
        state.selectedDocId = docId;
        state.rightPaneTab = "docs";
        state.mobilePanel = "docs";
      }),

    selectDocId: (docId) =>
      set((state) => {
        state.selectedDocId = docId;
      }),

    // -- Context-artifact panel --

    // Route the right pane to the artifact tab. Mirrors openDocument's reveal
    // logic: panes and conversation-only give the right pane no column, so
    // opening switches to a layout that shows it (without persisting over the
    // user's saved layout preference).
    openContextArtifactPanel: () =>
      set((state) => {
        state.rightPaneTab = "artifact";
        if (state.layout === "panes") {
          state.layout = "default";
        } else if (state.layout === "conversation") {
          state.layout = "split";
        }
      }),

    // -- Transcript message navigation --

    requestMessageNav: (conversationId, messageIndex) =>
      set((state) => {
        state.messageNavRequest = { conversationId, messageIndex };
      }),

    clearMessageNavRequest: () =>
      set((state) => {
        state.messageNavRequest = null;
      }),

    // -- Document viewer (multi-doc shell) --

    // Open a document by its canonical worktree-relative `docPath`: add a tab if
    // not already open (dedup by `docPath`, refreshing the title), make it the
    // active document, route the right pane / mobile panel to the docs surface,
    // and bump the activation nonce so the body flashes (reqs 1.1, 1.2, 1.5).
    openDocument: (ref) =>
      set((state) => {
        const existing = state.openDocuments.find(
          (d) => d.docPath === ref.docPath,
        );
        if (existing) {
          existing.title = ref.title;
        } else {
          state.openDocuments.push(ref);
        }
        state.activeDocPath = ref.docPath;
        state.docActivationNonce += 1;
        state.rightPaneTab = "docs";
        state.mobilePanel = "docs";
        // The viewer lives in the right pane, but two layouts give that pane no
        // column to occupy: panes replaces the content area with a full-width
        // conversation grid, and conversation-only is a single full-width column.
        // A markdown file card clicked in either would otherwise mutate this
        // state but never reveal the viewer, so opening switches to a layout that
        // shows it — panes drops to default, conversation-only opens the split
        // 50/50 view (req 4.3). This intentionally does not persist over the
        // user's saved layout preference (openDocuments is itself not persisted);
        // a reload restores it.
        if (state.layout === "panes") {
          state.layout = "default";
        } else if (state.layout === "conversation") {
          state.layout = "split";
        }
      }),

    // Activate an already-open tab (req 1.3). Bumps the nonce so the body flashes
    // (req 1.5); a no-op for an unknown path so a stale tab click cannot blank
    // the viewer.
    activateDocument: (docPath) =>
      set((state) => {
        if (!state.openDocuments.some((d) => d.docPath === docPath)) return;
        state.activeDocPath = docPath;
        state.docActivationNonce += 1;
      }),

    // Close a tab. When the active tab closes, fall through to the tab that takes
    // its slot (or the previous one when the last tab closed), or null when no
    // documents remain.
    closeDocument: (docPath) =>
      set((state) => {
        const idx = state.openDocuments.findIndex((d) => d.docPath === docPath);
        if (idx === -1) return;
        state.openDocuments.splice(idx, 1);
        if (state.activeDocPath !== docPath) return;
        const next =
          state.openDocuments[idx] ?? state.openDocuments[idx - 1] ?? null;
        state.activeDocPath = next?.docPath ?? null;
        if (next) state.docActivationNonce += 1;
      }),

    setPendingTrayExpanded: (expanded) =>
      set((state) => {
        state.pendingTrayExpanded = expanded;
      }),

    togglePendingTray: () =>
      set((state) => {
        state.pendingTrayExpanded = !state.pendingTrayExpanded;
      }),

    setFeedbackTarget: (target) =>
      set((state) => {
        state.feedbackTarget = target;
      }),

    // -- Reset --

    clearConversationMessages: () =>
      set((state) => {
        state.optimisticMessages = [];
        state.messageCountBeforeSubmit = 0;
      }),

    // Reset everything scoped to a single conversation workspace. Rail-owned
    // state (collapse, mobile drawer, filters) belongs to the host shell, which
    // stays mounted while workspaces swap, so it must survive this reset. The
    // page-level layout is host-shell state too — it is hydrated once at the
    // page and not re-read per conversation, so it must also survive the reset,
    // otherwise activating another conversation silently reverts the rendered
    // layout to the default (req 3.5, 5.2).
    resetConversationState: () =>
      set((state) => ({
        ...initialState,
        sidebarCollapsed: state.sidebarCollapsed,
        mobileSidebarOpen: state.mobileSidebarOpen,
        sidebarFilter: state.sidebarFilter,
        sidebarSessionFilter: state.sidebarSessionFilter,
        layout: state.layout,
      })),

    resetStore: () => set(() => ({ ...initialState })),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useLayout = () => useSessionDetailStore((s) => s.layout);
export const useMobilePanel = () => useSessionDetailStore((s) => s.mobilePanel);
export const useSending = () => useSessionDetailStore((s) => s.sending);
export const usePromptPlaceholder = () =>
  useSessionDetailStore((s) => s.promptPlaceholder);
export const usePromptError = () => useSessionDetailStore((s) => s.promptError);
export const usePromptCancelled = () =>
  useSessionDetailStore((s) => s.promptCancelled);
export const useOptimisticMessages = () =>
  useSessionDetailStore((s) => s.optimisticMessages);
export const useOptimisticQueue = () =>
  useSessionDetailStore((s) => s.optimisticQueue);
export const useMessageCountBeforeSubmit = () =>
  useSessionDetailStore((s) => s.messageCountBeforeSubmit);
export const useShowDeleteConfirm = () =>
  useSessionDetailStore((s) => s.showDeleteConfirm);
export const useSidebarCollapsed = () =>
  useSessionDetailStore((s) => s.sidebarCollapsed);
export const useMobileSidebarOpen = () =>
  useSessionDetailStore((s) => s.mobileSidebarOpen);
export const useSidebarFilter = () =>
  useSessionDetailStore((s) => s.sidebarFilter);
export const useSidebarSessionFilter = () =>
  useSessionDetailStore((s) => s.sidebarSessionFilter);
export const useComposerFocused = () =>
  useSessionDetailStore((s) => s.composerFocused);
export const useRightPaneTab = () =>
  useSessionDetailStore((s) => s.rightPaneTab);
export const useSpecBrowserSelection = () =>
  useSessionDetailStore((s) => s.specBrowserSelection);
export const useSelectedDocId = () =>
  useSessionDetailStore((s) => s.selectedDocId);
export const useOpenDocuments = () =>
  useSessionDetailStore((s) => s.openDocuments);
export const useActiveDocPath = () =>
  useSessionDetailStore((s) => s.activeDocPath);
export const useDocActivationNonce = () =>
  useSessionDetailStore((s) => s.docActivationNonce);
export const useMessageNavRequest = () =>
  useSessionDetailStore((s) => s.messageNavRequest);
export const usePendingTrayExpanded = () =>
  useSessionDetailStore((s) => s.pendingTrayExpanded);
export const useFeedbackTarget = () =>
  useSessionDetailStore((s) => s.feedbackTarget);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useSwitchLayout = () =>
  useSessionDetailStore((s) => s.switchLayout);
export const useHydrateLayout = () =>
  useSessionDetailStore((s) => s.hydrateLayout);
export const useSwitchMobilePanel = () =>
  useSessionDetailStore((s) => s.switchMobilePanel);
export const useSwitchRightPaneTab = () =>
  useSessionDetailStore((s) => s.switchRightPaneTab);
export const useOpenContextArtifactPanel = () =>
  useSessionDetailStore((s) => s.openContextArtifactPanel);
export const useRequestMessageNav = () =>
  useSessionDetailStore((s) => s.requestMessageNav);
export const useClearMessageNavRequest = () =>
  useSessionDetailStore((s) => s.clearMessageNavRequest);
export const useSubmitPrompt = () =>
  useSessionDetailStore((s) => s.submitPrompt);
export const useReceiveStreamContent = () =>
  useSessionDetailStore((s) => s.receiveStreamContent);
export const useCompletePrompt = () =>
  useSessionDetailStore((s) => s.completePrompt);
export const useFailPrompt = () => useSessionDetailStore((s) => s.failPrompt);
export const useSetQueueError = () =>
  useSessionDetailStore((s) => s.setQueueError);
export const useQueueMessage = () =>
  useSessionDetailStore((s) => s.queueMessage);
export const useAddOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.addOptimisticQueueEntry);
export const useAcceptOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.acceptOptimisticQueueEntry);
export const useFailOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.failOptimisticQueueEntry);
export const useCancelOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.cancelOptimisticQueueEntry);
export const useRollbackOptimisticQueueEntry = () =>
  useSessionDetailStore((s) => s.rollbackOptimisticQueueEntry);
export const useDismissError = () =>
  useSessionDetailStore((s) => s.dismissError);
export const useMarkCancelled = () =>
  useSessionDetailStore((s) => s.markCancelled);
export const useDismissCancelled = () =>
  useSessionDetailStore((s) => s.dismissCancelled);
export const useReconcileMessages = () =>
  useSessionDetailStore((s) => s.reconcileMessages);
export const useStartRecording = () =>
  useSessionDetailStore((s) => s.startRecording);
export const useStopRecording = () =>
  useSessionDetailStore((s) => s.stopRecording);
export const useShowPlaceholderAction = () =>
  useSessionDetailStore((s) => s.showPlaceholder);
export const useClearPlaceholder = () =>
  useSessionDetailStore((s) => s.clearPlaceholder);
export const useRequestDeleteSession = () =>
  useSessionDetailStore((s) => s.requestDeleteSession);
export const useCancelDeleteSessionDetail = () =>
  useSessionDetailStore((s) => s.cancelDeleteSession);
export const useToggleSidebar = () =>
  useSessionDetailStore((s) => s.toggleSidebar);
export const useOpenMobileSidebar = () =>
  useSessionDetailStore((s) => s.openMobileSidebar);
export const useCloseMobileSidebar = () =>
  useSessionDetailStore((s) => s.closeMobileSidebar);
export const useHydrateSidebar = () =>
  useSessionDetailStore((s) => s.hydrateSidebar);
export const useSetSidebarFilter = () =>
  useSessionDetailStore((s) => s.setSidebarFilter);
export const useSetSidebarSessionFilter = () =>
  useSessionDetailStore((s) => s.setSidebarSessionFilter);
export const useSetComposerFocused = () =>
  useSessionDetailStore((s) => s.setComposerFocused);
export const useShowQuestions = () =>
  useSessionDetailStore((s) => s.showQuestions);
export const useNavigateQuestion = () =>
  useSessionDetailStore((s) => s.navigateQuestion);
export const useClearQuestions = () =>
  useSessionDetailStore((s) => s.clearQuestions);
export const usePendingQuestions = () =>
  useSessionDetailStore((s) => s.pendingQuestions);
export const usePendingQuestionId = () =>
  useSessionDetailStore((s) => s.pendingQuestionId);
export const useCurrentQuestionIndex = () =>
  useSessionDetailStore((s) => s.currentQuestionIndex);
export const useSelectSpecCategory = () =>
  useSessionDetailStore((s) => s.selectSpecCategory);
export const useSelectSpecFile = () =>
  useSessionDetailStore((s) => s.selectSpecFile);
export const useOpenDocById = () => useSessionDetailStore((s) => s.openDocById);
export const useSelectDocId = () => useSessionDetailStore((s) => s.selectDocId);
export const useOpenDocument = () =>
  useSessionDetailStore((s) => s.openDocument);
export const useActivateDocument = () =>
  useSessionDetailStore((s) => s.activateDocument);
export const useCloseDocument = () =>
  useSessionDetailStore((s) => s.closeDocument);
export const useSetPendingTrayExpanded = () =>
  useSessionDetailStore((s) => s.setPendingTrayExpanded);
export const useTogglePendingTray = () =>
  useSessionDetailStore((s) => s.togglePendingTray);
export const useSetFeedbackTarget = () =>
  useSessionDetailStore((s) => s.setFeedbackTarget);
export const useClearConversationMessages = () =>
  useSessionDetailStore((s) => s.clearConversationMessages);
export const useResetConversationState = () =>
  useSessionDetailStore((s) => s.resetConversationState);
export const useResetSessionDetailStore = () =>
  useSessionDetailStore((s) => s.resetStore);
