import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RoadmapItemsState {
  showArchived: boolean;
}

interface RoadmapItemsActions {
  toggleArchived: () => void;
}

type RoadmapItemsStore = RoadmapItemsState & RoadmapItemsActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useRoadmapItemsStore = create<RoadmapItemsStore>()(
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

export const useShowArchivedRoadmapItems = () =>
  useRoadmapItemsStore((s) => s.showArchived);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useToggleArchivedRoadmapItems = () =>
  useRoadmapItemsStore((s) => s.toggleArchived);
