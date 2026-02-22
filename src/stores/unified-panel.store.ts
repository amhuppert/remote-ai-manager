import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnifiedPanelState {
  isOpen: boolean;
}

interface UnifiedPanelActions {
  toggle: () => void;
  close: () => void;
}

type UnifiedPanelStore = UnifiedPanelState & UnifiedPanelActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useUnifiedPanelStore = create<UnifiedPanelStore>()(
  immer((set) => ({
    isOpen: false,

    toggle: () =>
      set((state) => {
        state.isOpen = !state.isOpen;
      }),

    close: () =>
      set((state) => {
        state.isOpen = false;
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useUnifiedPanelOpen = () => useUnifiedPanelStore((s) => s.isOpen);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useToggleUnifiedPanel = () =>
  useUnifiedPanelStore((s) => s.toggle);
export const useCloseUnifiedPanel = () => useUnifiedPanelStore((s) => s.close);
