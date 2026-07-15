import type { LayoutMode } from "@/lib/sessions/schemas";
import {
  type LayoutSlice,
  type SessionDetailSliceCreator,
  initialState,
  validLayouts,
} from "./types";

export const createLayoutSlice: SessionDetailSliceCreator<LayoutSlice> = (
  set,
) => ({
  layout: initialState.layout,
  mobilePanel: initialState.mobilePanel,
  rightPaneTab: initialState.rightPaneTab,

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
});
