import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { closeTabSelection } from "@/lib/shared/close-tab-selection";
import { reconcileOpenTabs } from "./reconcile-open-tabs";

export type CockpitWorkspaceView = "sessions" | "conversations";

/**
 * Client-only view-state for the project cockpit. The foundation's server state
 * is authoritative for *which* conversations are open; this store layers the
 * client's ordering, active selection, primary workspace view, rail-collapse,
 * and the transient entry-animation flag on top. It is reconciled against the
 * server open list via `reconcileTabs` on every list change.
 *
 * Selectors are exposed individually so consumers subscribe to a single slice
 * (no whole-store reads on hot paths, per PERFORMANCE.md).
 */
interface CockpitViewState {
  openTabIds: string[];
  activeTabId: string | null;
  workspaceView: CockpitWorkspaceView;
  railCollapsed: boolean;
  /** Transient flag driving the first-run→cockpit entry animation. */
  entering: boolean;
}

export interface CockpitCloseSnapshot {
  openTabIds: string[];
  activeTabId: string | null;
  workspaceView: CockpitWorkspaceView;
  entering: boolean;
}

interface CockpitViewActions {
  /** Reconcile tab view-state against the server's open-conversation ids. */
  reconcileTabs(serverOpenIds: readonly string[]): void;
  setActiveTab(id: string): void;
  /** Focus a tab, appending it optimistically if not already tracked. */
  focusTab(id: string): void;
  setWorkspaceView(view: CockpitWorkspaceView): void;
  beginCloseTab(id: string): CockpitCloseSnapshot | null;
  restoreCloseSnapshot(snapshot: CockpitCloseSnapshot): void;
  toggleRail(): void;
  setRailCollapsed(collapsed: boolean): void;
  clearEntering(): void;
  /** @internal test helper */
  _reset(): void;
}

type CockpitViewStore = CockpitViewState & CockpitViewActions;

const initialState: CockpitViewState = {
  openTabIds: [],
  activeTabId: null,
  workspaceView: "sessions",
  railCollapsed: false,
  entering: false,
};

const useCockpitViewStore = create<CockpitViewStore>()(
  immer((set, get) => ({
    ...initialState,

    reconcileTabs: (serverOpenIds) =>
      set((state) => {
        const hadOpen = state.openTabIds.length > 0;
        const result = reconcileOpenTabs(serverOpenIds, {
          openTabIds: state.openTabIds,
          activeTabId: state.activeTabId,
        });
        state.openTabIds = result.openTabIds;
        state.activeTabId = result.activeTabId;
        // Crossing from zero → at least one open conversation triggers the
        // cockpit entry animation.
        if (!hadOpen && result.openTabIds.length > 0) {
          state.entering = true;
        }
        if (result.firstRun) {
          state.entering = false;
        }
      }),

    setActiveTab: (id) =>
      set((state) => {
        state.activeTabId = id;
        state.workspaceView = "conversations";
      }),

    focusTab: (id) =>
      set((state) => {
        if (!state.openTabIds.includes(id)) {
          state.openTabIds.push(id);
        }
        state.activeTabId = id;
        state.workspaceView = "conversations";
      }),

    setWorkspaceView: (view) =>
      set((state) => {
        state.workspaceView = view;
      }),

    beginCloseTab: (id) => {
      const current = get();
      if (!current.openTabIds.includes(id)) return null;
      const snapshot: CockpitCloseSnapshot = {
        openTabIds: [...current.openTabIds],
        activeTabId: current.activeTabId,
        workspaceView: current.workspaceView,
        entering: current.entering,
      };
      set((state) => {
        if (state.activeTabId === id) {
          state.activeTabId = closeTabSelection(state.openTabIds, id);
        }
        state.openTabIds = state.openTabIds.filter((tabId) => tabId !== id);
        if (state.openTabIds.length === 0) {
          state.activeTabId = null;
          state.entering = false;
        }
      });
      return snapshot;
    },

    restoreCloseSnapshot: (snapshot) =>
      set((state) => {
        state.openTabIds = [...snapshot.openTabIds];
        state.activeTabId = snapshot.activeTabId;
        state.workspaceView = snapshot.workspaceView;
        state.entering = snapshot.entering;
      }),

    toggleRail: () =>
      set((state) => {
        state.railCollapsed = !state.railCollapsed;
      }),

    setRailCollapsed: (collapsed) =>
      set((state) => {
        state.railCollapsed = collapsed;
      }),

    clearEntering: () =>
      set((state) => {
        state.entering = false;
      }),

    _reset: () =>
      set((state) => {
        state.openTabIds = [];
        state.activeTabId = null;
        state.workspaceView = "sessions";
        state.railCollapsed = false;
        state.entering = false;
      }),
  })),
);

// --- Focused selector hooks ---------------------------------------------------

export const useOpenTabIds = () => useCockpitViewStore((s) => s.openTabIds);
export const useActiveTabId = () => useCockpitViewStore((s) => s.activeTabId);
export const useWorkspaceView = () =>
  useCockpitViewStore((s) => s.workspaceView);
export const useRailCollapsed = () =>
  useCockpitViewStore((s) => s.railCollapsed);
export const useEntering = () => useCockpitViewStore((s) => s.entering);

// --- Action hooks -------------------------------------------------------------

export const useReconcileTabs = () =>
  useCockpitViewStore((s) => s.reconcileTabs);
export const useSetActiveTab = () => useCockpitViewStore((s) => s.setActiveTab);
export const useFocusTab = () => useCockpitViewStore((s) => s.focusTab);
export const useSetWorkspaceView = () =>
  useCockpitViewStore((s) => s.setWorkspaceView);
export const useBeginCloseTab = () =>
  useCockpitViewStore((s) => s.beginCloseTab);
export const useRestoreCloseSnapshot = () =>
  useCockpitViewStore((s) => s.restoreCloseSnapshot);
export const useToggleRail = () => useCockpitViewStore((s) => s.toggleRail);
export const useSetRailCollapsed = () =>
  useCockpitViewStore((s) => s.setRailCollapsed);

/** @internal — exposed for direct state testing. */
export { useCockpitViewStore as _useCockpitViewStore };
