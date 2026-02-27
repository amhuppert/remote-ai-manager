import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type {
  LayoutMode,
  TranscriptMessage,
  MessageContentBlock,
  AskQuestionItem,
} from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MobilePanel = "chat" | "diff" | "focus" | "specs";
type RightPaneTab = "diff" | "focus" | "specs";

interface SpecBrowserSelection {
  /** "steering" or a feature name like "browser-notifications" */
  category: string;
  /** Selected filename like "design.md", or null if only category selected */
  file: string | null;
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
  messageCountBeforeSubmit: number;
  currentMsgIndex: number;
  showDeleteConfirm: boolean;
  showCommitDialog: boolean;
  showMergeDialog: boolean;
  infoExpanded: boolean;
  sidebarCollapsed: boolean;
  pendingQuestions: AskQuestionItem[] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  editingIndex: number | null;
  pendingForkPrompt: { conversationId: string; text: string } | null;
  specBrowserSelection: SpecBrowserSelection | null;
}

interface SessionDetailActions {
  switchLayout: (mode: LayoutMode, storageKey: string) => void;
  hydrateLayout: (storageKey: string) => void;
  switchMobilePanel: (panel: MobilePanel) => void;
  switchRightPaneTab: (tab: RightPaneTab) => void;
  submitPrompt: (
    userContent: MessageContentBlock[],
    currentMessageCount: number,
  ) => void;
  receiveStreamContent: (
    userContent: MessageContentBlock[],
    allBlocks: MessageContentBlock[],
  ) => void;
  completePrompt: () => void;
  failPrompt: (error: string) => void;
  dismissError: () => void;
  markCancelled: () => void;
  dismissCancelled: () => void;
  reconcileMessages: (serverCount: number) => void;
  navigateToMessage: (index: number) => void;
  startRecording: () => void;
  stopRecording: () => void;
  showPlaceholder: (text: string) => void;
  clearPlaceholder: () => void;
  requestCommit: () => void;
  cancelCommit: () => void;
  requestMerge: () => void;
  cancelMerge: () => void;
  requestDeleteSession: () => void;
  cancelDeleteSession: () => void;
  toggleInfoStrip: () => void;
  toggleSidebar: () => void;
  hydrateSidebar: () => void;
  showQuestions: (questionId: string, questions: AskQuestionItem[]) => void;
  navigateQuestion: (index: number) => void;
  clearQuestions: () => void;
  startEditing: (messageIndex: number) => void;
  cancelEditing: () => void;
  setPendingForkPrompt: (pending: {
    conversationId: string;
    text: string;
  }) => void;
  consumePendingForkPrompt: () => {
    conversationId: string;
    text: string;
  } | null;
  selectSpecCategory: (category: string) => void;
  selectSpecFile: (category: string, file: string) => void;
  clearSpecSelection: () => void;
  clearConversationMessages: () => void;
  resetStore: () => void;
}

type SessionDetailStore = SessionDetailState & SessionDetailActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDEBAR_STORAGE_KEY = "cc-sidebar-collapsed";
let cancelledTimer: ReturnType<typeof setTimeout> | null = null;

const validLayouts: LayoutMode[] = ["conversation", "default", "split", "diff"];

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
  messageCountBeforeSubmit: 0,
  currentMsgIndex: 0,
  showDeleteConfirm: false,
  showCommitDialog: false,
  showMergeDialog: false,
  infoExpanded: false,
  sidebarCollapsed: false,
  pendingQuestions: null,
  pendingQuestionId: null,
  currentQuestionIndex: 0,
  editingIndex: null,
  pendingForkPrompt: null,
  specBrowserSelection: null,
};

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useSessionDetailStore = create<SessionDetailStore>()(
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

    submitPrompt: (userContent, currentMessageCount) =>
      set((state) => {
        state.sending = true;
        state.promptError = null;
        state.messageCountBeforeSubmit = currentMessageCount;
        state.optimisticMessages = [
          {
            role: "user",
            content: userContent,
            timestamp: new Date().toISOString(),
          },
        ];
      }),

    receiveStreamContent: (userContent, allBlocks) =>
      set((state) => {
        state.optimisticMessages = [
          {
            role: "user",
            content: userContent,
            timestamp: new Date().toISOString(),
          },
          {
            role: "assistant",
            content: [...allBlocks],
            timestamp: new Date().toISOString(),
          },
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

    // -- Message navigation --

    navigateToMessage: (index) =>
      set((state) => {
        state.currentMsgIndex = index;
      }),

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

    requestCommit: () =>
      set((state) => {
        state.showCommitDialog = true;
      }),

    cancelCommit: () =>
      set((state) => {
        state.showCommitDialog = false;
      }),

    requestMerge: () =>
      set((state) => {
        state.showMergeDialog = true;
      }),

    cancelMerge: () =>
      set((state) => {
        state.showMergeDialog = false;
      }),

    requestDeleteSession: () =>
      set((state) => {
        state.showDeleteConfirm = true;
      }),

    cancelDeleteSession: () =>
      set((state) => {
        state.showDeleteConfirm = false;
      }),

    // -- UI toggles --

    toggleInfoStrip: () =>
      set((state) => {
        state.infoExpanded = !state.infoExpanded;
      }),

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

    // -- Fork / Edit --

    startEditing: (messageIndex) =>
      set((state) => {
        state.editingIndex = messageIndex;
      }),

    cancelEditing: () =>
      set((state) => {
        state.editingIndex = null;
      }),

    setPendingForkPrompt: (pending) =>
      set((state) => {
        state.pendingForkPrompt = pending;
      }),

    consumePendingForkPrompt: () => {
      const { pendingForkPrompt } = get();
      if (!pendingForkPrompt) return null;
      set((state) => {
        state.pendingForkPrompt = null;
      });
      return pendingForkPrompt;
    },

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

    // -- Reset --

    clearConversationMessages: () =>
      set((state) => {
        state.optimisticMessages = [];
        state.messageCountBeforeSubmit = 0;
        state.currentMsgIndex = 0;
        state.editingIndex = null;
      }),

    resetStore: () => set(() => ({ ...initialState })),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useLayout = () => useSessionDetailStore((s) => s.layout);
export const useMobilePanel = () => useSessionDetailStore((s) => s.mobilePanel);
export const useSending = () => useSessionDetailStore((s) => s.sending);
export const useIsVoiceRecording = () =>
  useSessionDetailStore((s) => s.isVoiceRecording);
export const usePromptPlaceholder = () =>
  useSessionDetailStore((s) => s.promptPlaceholder);
export const usePromptError = () => useSessionDetailStore((s) => s.promptError);
export const usePromptCancelled = () =>
  useSessionDetailStore((s) => s.promptCancelled);
export const useOptimisticMessages = () =>
  useSessionDetailStore((s) => s.optimisticMessages);
export const useMessageCountBeforeSubmit = () =>
  useSessionDetailStore((s) => s.messageCountBeforeSubmit);
export const useCurrentMsgIndex = () =>
  useSessionDetailStore((s) => s.currentMsgIndex);
export const useShowDeleteConfirm = () =>
  useSessionDetailStore((s) => s.showDeleteConfirm);
export const useShowCommitDialog = () =>
  useSessionDetailStore((s) => s.showCommitDialog);
export const useShowMergeDialog = () =>
  useSessionDetailStore((s) => s.showMergeDialog);
export const useInfoExpanded = () =>
  useSessionDetailStore((s) => s.infoExpanded);
export const useSidebarCollapsed = () =>
  useSessionDetailStore((s) => s.sidebarCollapsed);
export const useEditingIndex = () =>
  useSessionDetailStore((s) => s.editingIndex);
export const usePendingForkPrompt = () =>
  useSessionDetailStore((s) => s.pendingForkPrompt);
export const useRightPaneTab = () =>
  useSessionDetailStore((s) => s.rightPaneTab);
export const useSpecBrowserSelection = () =>
  useSessionDetailStore((s) => s.specBrowserSelection);

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
export const useSubmitPrompt = () =>
  useSessionDetailStore((s) => s.submitPrompt);
export const useReceiveStreamContent = () =>
  useSessionDetailStore((s) => s.receiveStreamContent);
export const useCompletePrompt = () =>
  useSessionDetailStore((s) => s.completePrompt);
export const useFailPrompt = () => useSessionDetailStore((s) => s.failPrompt);
export const useDismissError = () =>
  useSessionDetailStore((s) => s.dismissError);
export const useMarkCancelled = () =>
  useSessionDetailStore((s) => s.markCancelled);
export const useDismissCancelled = () =>
  useSessionDetailStore((s) => s.dismissCancelled);
export const useReconcileMessages = () =>
  useSessionDetailStore((s) => s.reconcileMessages);
export const useNavigateToMessage = () =>
  useSessionDetailStore((s) => s.navigateToMessage);
export const useStartRecording = () =>
  useSessionDetailStore((s) => s.startRecording);
export const useStopRecording = () =>
  useSessionDetailStore((s) => s.stopRecording);
export const useShowPlaceholderAction = () =>
  useSessionDetailStore((s) => s.showPlaceholder);
export const useClearPlaceholder = () =>
  useSessionDetailStore((s) => s.clearPlaceholder);
export const useRequestCommit = () =>
  useSessionDetailStore((s) => s.requestCommit);
export const useCancelCommit = () =>
  useSessionDetailStore((s) => s.cancelCommit);
export const useRequestMerge = () =>
  useSessionDetailStore((s) => s.requestMerge);
export const useCancelMerge = () => useSessionDetailStore((s) => s.cancelMerge);
export const useRequestDeleteSession = () =>
  useSessionDetailStore((s) => s.requestDeleteSession);
export const useCancelDeleteSessionDetail = () =>
  useSessionDetailStore((s) => s.cancelDeleteSession);
export const useToggleInfoStrip = () =>
  useSessionDetailStore((s) => s.toggleInfoStrip);
export const useToggleSidebar = () =>
  useSessionDetailStore((s) => s.toggleSidebar);
export const useHydrateSidebar = () =>
  useSessionDetailStore((s) => s.hydrateSidebar);
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
export const useStartEditing = () =>
  useSessionDetailStore((s) => s.startEditing);
export const useCancelEditing = () =>
  useSessionDetailStore((s) => s.cancelEditing);
export const useSetPendingForkPrompt = () =>
  useSessionDetailStore((s) => s.setPendingForkPrompt);
export const useConsumePendingForkPrompt = () =>
  useSessionDetailStore((s) => s.consumePendingForkPrompt);
export const useSelectSpecCategory = () =>
  useSessionDetailStore((s) => s.selectSpecCategory);
export const useSelectSpecFile = () =>
  useSessionDetailStore((s) => s.selectSpecFile);
export const useClearSpecSelection = () =>
  useSessionDetailStore((s) => s.clearSpecSelection);
export const useClearConversationMessages = () =>
  useSessionDetailStore((s) => s.clearConversationMessages);
export const useResetSessionDetailStore = () =>
  useSessionDetailStore((s) => s.resetStore);
