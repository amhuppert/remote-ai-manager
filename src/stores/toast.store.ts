import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export interface ToastItem {
  id: string;
  message: string;
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
}

interface ToastActions {
  push: (message: string) => void;
  dismiss: (id: string) => void;
}

type ToastStore = ToastState & ToastActions;

const TOAST_TTL_MS = 2200;

const useToastStore = create<ToastStore>()(
  immer((set, get) => ({
    toasts: [],

    push: (message: string) => {
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      set((state) => {
        state.toasts.push({ id, message, createdAt });
      });
      setTimeout(() => get().dismiss(id), TOAST_TTL_MS);
    },

    dismiss: (id: string) =>
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id);
      }),
  })),
);

export const useToasts = (): ToastItem[] => useToastStore((s) => s.toasts);
export const usePushToast = (): ((message: string) => void) =>
  useToastStore((s) => s.push);
export const useDismissToast = (): ((id: string) => void) =>
  useToastStore((s) => s.dismiss);

export function pushToast(message: string): void {
  useToastStore.getState().push(message);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

export const useToastStoreForTesting = useToastStore;
