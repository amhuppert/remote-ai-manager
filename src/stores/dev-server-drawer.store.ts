import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DevServerDrawerState {
  isOpen: boolean;
}

interface DevServerDrawerActions {
  toggle: () => void;
  open: () => void;
  close: () => void;
}

type DevServerDrawerStore = DevServerDrawerState & DevServerDrawerActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useDevServerDrawerStore = create<DevServerDrawerStore>()(
  immer((set) => ({
    isOpen: false,

    toggle: () =>
      set((state) => {
        state.isOpen = !state.isOpen;
      }),

    open: () =>
      set((state) => {
        state.isOpen = true;
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

export const useDevServerDrawerOpen = () =>
  useDevServerDrawerStore((s) => s.isOpen);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useToggleDevServerDrawer = () =>
  useDevServerDrawerStore((s) => s.toggle);
export const useCloseDevServerDrawer = () =>
  useDevServerDrawerStore((s) => s.close);
