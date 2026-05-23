import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationsState {
  showArchived: boolean;
  deleteTargetId: string | null;
}

interface ConversationsActions {
  toggleArchived: () => void;
  requestDeleteConversation: (id: string) => void;
  cancelDeleteConversation: () => void;
}

type ConversationsStore = ConversationsState & ConversationsActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useConversationsStore = create<ConversationsStore>()(
  immer((set) => ({
    showArchived: false,
    deleteTargetId: null,

    toggleArchived: () =>
      set((state) => {
        state.showArchived = !state.showArchived;
      }),

    requestDeleteConversation: (id) =>
      set((state) => {
        state.deleteTargetId = id;
      }),

    cancelDeleteConversation: () =>
      set((state) => {
        state.deleteTargetId = null;
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useShowArchivedConversations = () =>
  useConversationsStore((s) => s.showArchived);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useToggleArchivedConversations = () =>
  useConversationsStore((s) => s.toggleArchived);

/** @internal — exposed for direct state testing */
export { useConversationsStore as _useConversationsStore };
