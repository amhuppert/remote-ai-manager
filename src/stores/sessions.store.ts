import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeleteTarget {
  sessionName: string;
  projectName: string;
}

interface SessionsState {
  showCreateModal: boolean;
  /** Pre-filled parent session name when branching from a session */
  branchFromParent: string | null;
  deleteTarget: DeleteTarget | null;
  showArchived: boolean;
}

interface SessionsActions {
  openCreateModal: (parentSessionName?: string) => void;
  closeCreateModal: () => void;
  confirmDeleteSession: (target: DeleteTarget) => void;
  cancelDeleteSession: () => void;
  toggleArchived: () => void;
}

type SessionsStore = SessionsState & SessionsActions;

// ---------------------------------------------------------------------------
// Store (private)
// ---------------------------------------------------------------------------

const useSessionsStore = create<SessionsStore>()(
  immer((set) => ({
    showCreateModal: false,
    branchFromParent: null,
    deleteTarget: null,
    showArchived: false,

    openCreateModal: (parentSessionName) =>
      set((state) => {
        state.showCreateModal = true;
        state.branchFromParent = parentSessionName ?? null;
      }),

    closeCreateModal: () =>
      set((state) => {
        state.showCreateModal = false;
        state.branchFromParent = null;
      }),

    confirmDeleteSession: (target) =>
      set((state) => {
        state.deleteTarget = target;
      }),

    cancelDeleteSession: () =>
      set((state) => {
        state.deleteTarget = null;
      }),

    toggleArchived: () =>
      set((state) => {
        state.showArchived = !state.showArchived;
      }),
  })),
);

// ---------------------------------------------------------------------------
// Selector hooks
// ---------------------------------------------------------------------------

export const useShowCreateModal = () =>
  useSessionsStore((s) => s.showCreateModal);
export const useBranchFromParent = () =>
  useSessionsStore((s) => s.branchFromParent);
export const useDeleteTarget = () => useSessionsStore((s) => s.deleteTarget);
export const useShowArchivedSessions = () =>
  useSessionsStore((s) => s.showArchived);

// ---------------------------------------------------------------------------
// Action hooks
// ---------------------------------------------------------------------------

export const useOpenCreateModal = () =>
  useSessionsStore((s) => s.openCreateModal);
export const useCloseCreateModal = () =>
  useSessionsStore((s) => s.closeCreateModal);
export const useConfirmDeleteSession = () =>
  useSessionsStore((s) => s.confirmDeleteSession);
export const useCancelDeleteSession = () =>
  useSessionsStore((s) => s.cancelDeleteSession);
export const useToggleArchivedSessions = () =>
  useSessionsStore((s) => s.toggleArchived);

/** @internal — exposed for direct state testing */
export { useSessionsStore as _useSessionsStore };
