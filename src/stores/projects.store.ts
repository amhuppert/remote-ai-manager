import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = "all" | "active" | "running" | "idle";

interface ProjectsState {
  statusFilter: StatusFilter;
  showArchived: boolean;
  openMenuId: string | null;
}

interface ProjectsActions {
  filterByStatus: (status: StatusFilter) => void;
  toggleArchived: () => void;
  openProjectMenu: (id: string) => void;
  closeProjectMenu: () => void;
  resetFilters: () => void;
}

type ProjectsStore = ProjectsState & ProjectsActions;

// ---------------------------------------------------------------------------
// Store (private — never exported)
// ---------------------------------------------------------------------------

const useProjectsStore = create<ProjectsStore>()(
  immer((set) => ({
    statusFilter: "all",
    showArchived: false,
    openMenuId: null,

    filterByStatus: (status) =>
      set((state) => {
        state.statusFilter = status;
      }),

    toggleArchived: () =>
      set((state) => {
        state.showArchived = !state.showArchived;
      }),

    openProjectMenu: (id) =>
      set((state) => {
        state.openMenuId = id;
      }),

    closeProjectMenu: () =>
      set((state) => {
        state.openMenuId = null;
      }),

    resetFilters: () =>
      set((state) => {
        state.statusFilter = "all";
        state.showArchived = false;
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useStatusFilter = () => useProjectsStore((s) => s.statusFilter);
export const useShowArchivedProjects = () =>
  useProjectsStore((s) => s.showArchived);
export const useOpenMenuId = () => useProjectsStore((s) => s.openMenuId);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useFilterByStatus = () =>
  useProjectsStore((s) => s.filterByStatus);
export const useToggleArchivedProjects = () =>
  useProjectsStore((s) => s.toggleArchived);
export const useOpenProjectMenu = () =>
  useProjectsStore((s) => s.openProjectMenu);
export const useCloseProjectMenu = () =>
  useProjectsStore((s) => s.closeProjectMenu);
export const useResetFilters = () => useProjectsStore((s) => s.resetFilters);
