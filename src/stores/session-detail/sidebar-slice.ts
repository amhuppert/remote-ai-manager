import {
  type SessionDetailSliceCreator,
  type SidebarSlice,
  SIDEBAR_STORAGE_KEY,
  initialState,
} from "./types";

export const createSidebarSlice: SessionDetailSliceCreator<SidebarSlice> = (
  set,
) => ({
  sidebarCollapsed: initialState.sidebarCollapsed,
  mobileSidebarOpen: initialState.mobileSidebarOpen,
  sidebarFilter: initialState.sidebarFilter,
  sidebarSessionFilter: initialState.sidebarSessionFilter,
  composerFocused: initialState.composerFocused,

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

  openMobileSidebar: () =>
    set((state) => {
      state.mobileSidebarOpen = true;
    }),

  closeMobileSidebar: () =>
    set((state) => {
      state.mobileSidebarOpen = false;
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

  setSidebarFilter: (value) =>
    set((state) => {
      state.sidebarFilter = value;
    }),

  setSidebarSessionFilter: (value) =>
    set((state) => {
      state.sidebarSessionFilter = value;
    }),

  setComposerFocused: (focused) =>
    set((state) => {
      state.composerFocused = focused;
    }),
});
