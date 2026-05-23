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
}

interface SessionsActions {
  openCreateModal: (parentSessionName?: string) => void;
  closeCreateModal: () => void;
  confirmDeleteSession: (target: DeleteTarget) => void;
  cancelDeleteSession: () => void;
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

/** @internal — exposed for direct state testing */
export { useSessionsStore as _useSessionsStore };
