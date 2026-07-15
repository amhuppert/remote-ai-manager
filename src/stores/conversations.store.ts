import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConversationsState {
  showArchived: boolean;
}

interface ConversationsActions {
  toggleArchived: () => void;
}

type ConversationsStore = ConversationsState & ConversationsActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useConversationsStore = create<ConversationsStore>()(
  immer((set) => ({
    showArchived: false,

    toggleArchived: () =>
      set((state) => {
        state.showArchived = !state.showArchived;
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
