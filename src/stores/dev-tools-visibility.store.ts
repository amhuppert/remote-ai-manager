import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DevToolsVisibilityState {
  enabled: boolean;
  hydrated: boolean;
}

interface DevToolsVisibilityActions {
  toggle: () => void;
  hydrate: () => void;
}

type DevToolsVisibilityStore = DevToolsVisibilityState &
  DevToolsVisibilityActions;

// ---------------------------------------------------------------------------
// localStorage key
// ---------------------------------------------------------------------------

const STORAGE_KEY = "cc-dev-tools-enabled";

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useDevToolsVisibilityStore = create<DevToolsVisibilityStore>()(
  immer((set) => ({
    enabled: false,
    hydrated: false,

    toggle: () =>
      set((state) => {
        state.enabled = !state.enabled;
        try {
          localStorage.setItem(STORAGE_KEY, String(state.enabled));
        } catch {
          // localStorage unavailable (SSR, private browsing)
        }
      }),

    hydrate: () =>
      set((state) => {
        if (state.hydrated) return;
        try {
          state.enabled = localStorage.getItem(STORAGE_KEY) === "true";
        } catch {
          state.enabled = false;
        }
        state.hydrated = true;
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useDevToolsEnabled = () =>
  useDevToolsVisibilityStore((s) => s.enabled);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useToggleDevTools = () =>
  useDevToolsVisibilityStore((s) => s.toggle);

export const useHydrateDevTools = () =>
  useDevToolsVisibilityStore((s) => s.hydrate);
