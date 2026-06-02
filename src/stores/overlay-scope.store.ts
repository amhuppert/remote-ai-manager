import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OverlayScopeState {
  /**
   * Stack of open-overlay tokens (modals, drawers, menus, popovers). Ordered by
   * open time so the last entry is the topmost overlay. Page-level hotkeys are
   * suppressed whenever this is non-empty; only the topmost overlay handles
   * Escape.
   */
  openStack: string[];
}

interface OverlayScopeActions {
  pushOverlay: (token: string) => void;
  popOverlay: (token: string) => void;
}

type OverlayScopeStore = OverlayScopeState & OverlayScopeActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useOverlayScopeStore = create<OverlayScopeStore>()(
  immer((set) => ({
    openStack: [],

    pushOverlay: (token) =>
      set((state) => {
        state.openStack.push(token);
      }),

    popOverlay: (token) =>
      set((state) => {
        const idx = state.openStack.indexOf(token);
        if (idx !== -1) state.openStack.splice(idx, 1);
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector / action hooks
// ---------------------------------------------------------------------------

export const useIsOverlayOpen = () =>
  useOverlayScopeStore((s) => s.openStack.length > 0);
export const usePushOverlay = () => useOverlayScopeStore((s) => s.pushOverlay);
export const usePopOverlay = () => useOverlayScopeStore((s) => s.popOverlay);

// ---------------------------------------------------------------------------
// Imperative helpers (for use inside DOM event handlers, outside React)
// ---------------------------------------------------------------------------

export function isOverlayOpen(): boolean {
  return useOverlayScopeStore.getState().openStack.length > 0;
}

export function isTopOverlay(token: string): boolean {
  const stack = useOverlayScopeStore.getState().openStack;
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** @internal — exposed for direct state testing */
export { useOverlayScopeStore as _useOverlayScopeStore };
