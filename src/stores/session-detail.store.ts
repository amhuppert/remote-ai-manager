import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { LayoutMode, TranscriptMessage, MessageContentBlock } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MobilePanel = "chat" | "diff";

interface SessionDetailState {
  layout: LayoutMode;
  mobilePanel: MobilePanel;
  sending: boolean;
  isVoiceRecording: boolean;
  promptPlaceholder: string | null;
  promptError: string | null;
  optimisticMessages: TranscriptMessage[];
  messageCountBeforeSubmit: number;
  currentMsgIndex: number;
  showDeleteConfirm: boolean;
  showCommitDialog: boolean;
  showMergeDialog: boolean;
  infoExpanded: boolean;
  sidebarCollapsed: boolean;
}

interface SessionDetailActions {
  switchLayout: (mode: LayoutMode, storageKey: string) => void;
  hydrateLayout: (storageKey: string) => void;
  switchMobilePanel: (panel: MobilePanel) => void;
  submitPrompt: (text: string, currentMessageCount: number) => void;
  receiveStreamContent: (
    userText: string,
    allBlocks: MessageContentBlock[],
  ) => void;
  completePrompt: () => void;
  failPrompt: (error: string) => void;
  dismissError: () => void;
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
  resetStore: () => void;
}

type SessionDetailStore = SessionDetailState & SessionDetailActions;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIDEBAR_STORAGE_KEY = "csm-sidebar-collapsed";

const validLayouts: LayoutMode[] = ["conversation", "default", "split", "diff"];

const initialState: SessionDetailState = {
  layout: "default",
  mobilePanel: "chat",
  sending: false,
  isVoiceRecording: false,
  promptPlaceholder: null,
  promptError: null,
  optimisticMessages: [],
  messageCountBeforeSubmit: 0,
  currentMsgIndex: 0,
  showDeleteConfirm: false,
  showCommitDialog: false,
  showMergeDialog: false,
  infoExpanded: false,
  sidebarCollapsed: false,
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

    // -- Prompt streaming --

    submitPrompt: (text, currentMessageCount) =>
      set((state) => {
        state.sending = true;
        state.promptError = null;
        state.messageCountBeforeSubmit = currentMessageCount;
        state.optimisticMessages = [
          {
            role: "user",
            content: [{ type: "text" as const, text }],
            timestamp: new Date().toISOString(),
          },
        ];
      }),

    receiveStreamContent: (userText, allBlocks) =>
      set((state) => {
        state.optimisticMessages = [
          {
            role: "user",
            content: [{ type: "text" as const, text: userText }],
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

    reconcileMessages: (serverCount) => {
      const { sending, messageCountBeforeSubmit, optimisticMessages } =
        get();
      if (optimisticMessages.length === 0) return;
      if (serverCount <= messageCountBeforeSubmit) return;

      if (sending) {
        // Server has user message; keep only streaming assistant
        const assistantOnly = optimisticMessages.filter(
          (m) => m.role === "assistant",
        );
        if (assistantOnly.length !== optimisticMessages.length) {
          set((state) => {
            state.optimisticMessages = assistantOnly;
          });
        }
      } else {
        // Stream done — clear all optimistic
        set((state) => {
          state.optimisticMessages = [];
        });
      }
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

    // -- Reset --

    resetStore: () =>
      set(() => ({ ...initialState })),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useLayout = () =>
  useSessionDetailStore((s) => s.layout);
export const useMobilePanel = () =>
  useSessionDetailStore((s) => s.mobilePanel);
export const useSending = () =>
  useSessionDetailStore((s) => s.sending);
export const useIsVoiceRecording = () =>
  useSessionDetailStore((s) => s.isVoiceRecording);
export const usePromptPlaceholder = () =>
  useSessionDetailStore((s) => s.promptPlaceholder);
export const usePromptError = () =>
  useSessionDetailStore((s) => s.promptError);
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

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useSwitchLayout = () =>
  useSessionDetailStore((s) => s.switchLayout);
export const useHydrateLayout = () =>
  useSessionDetailStore((s) => s.hydrateLayout);
export const useSwitchMobilePanel = () =>
  useSessionDetailStore((s) => s.switchMobilePanel);
export const useSubmitPrompt = () =>
  useSessionDetailStore((s) => s.submitPrompt);
export const useReceiveStreamContent = () =>
  useSessionDetailStore((s) => s.receiveStreamContent);
export const useCompletePrompt = () =>
  useSessionDetailStore((s) => s.completePrompt);
export const useFailPrompt = () =>
  useSessionDetailStore((s) => s.failPrompt);
export const useDismissError = () =>
  useSessionDetailStore((s) => s.dismissError);
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
export const useCancelMerge = () =>
  useSessionDetailStore((s) => s.cancelMerge);
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
export const useResetSessionDetailStore = () =>
  useSessionDetailStore((s) => s.resetStore);
