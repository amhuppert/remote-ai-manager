import type { LayoutMode } from "@/lib/sessions/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  type LayoutSlice,
  type SessionDetailSliceCreator,
  initialState,
  validLayouts,
} from "./types";

const log = createClientLogger("session-detail.navigation");

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
      if (panel !== "chat" && panel !== "info") state.rightPaneTab = panel;
      log.debug("mobile_panel.selected", { panel });
    }),

  switchRightPaneTab: (tab) =>
    set((state) => {
      state.rightPaneTab = tab;
      state.mobilePanel = tab;
    }),

  // Route the right pane to the artifact tab. Mirrors openDocument's reveal
  // logic: panes and conversation-only give the right pane no column, so
  // opening switches to the split layout that shows it (without persisting
  // over the user's saved layout preference).
  openContextArtifactPanel: () =>
    set((state) => {
      state.rightPaneTab = "artifact";
      state.mobilePanel = "artifact";
      if (state.layout === "panes" || state.layout === "conversation") {
        state.layout = "split";
      }
    }),
});
