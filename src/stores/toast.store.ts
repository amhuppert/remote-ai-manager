import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  message: string;
  createdAt: number;
  action?: ToastAction;
}

export interface ToastOptions {
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
}

interface ToastActions {
  push: (message: string, options?: ToastOptions) => string;
  replaceAction: (id: string, message: string, action: ToastAction) => void;
  dismiss: (id: string) => void;
}

type ToastStore = ToastState & ToastActions;

const TOAST_TTL_MS = 2200;

const useToastStore = create<ToastStore>()(
  immer((set, get) => ({
    toasts: [],

    push: (message: string, options?: ToastOptions) => {
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      const action = options?.action;
      set((state) => {
        state.toasts.push({ id, message, createdAt, action });
      });
      if (!action) setTimeout(() => get().dismiss(id), TOAST_TTL_MS);
      return id;
    },

    replaceAction: (id: string, message: string, action: ToastAction) => {
      const replacement = { id, message, createdAt: Date.now(), action };
      set((state) => {
        const index = state.toasts.findIndex((toast) => toast.id === id);
        if (index === -1) {
          state.toasts.push(replacement);
          return;
        }
        state.toasts[index] = replacement;
      });
    },

    dismiss: (id: string) =>
      set((state) => {
        state.toasts = state.toasts.filter((t) => t.id !== id);
      }),
  })),
);

export const useToasts = (): ToastItem[] => useToastStore((s) => s.toasts);
export const useDismissToast = (): ((id: string) => void) =>
  useToastStore((s) => s.dismiss);

export function pushToast(message: string, options?: ToastOptions): string {
  return useToastStore.getState().push(message, options);
}

export function replaceActionToast(
  id: string,
  message: string,
  action: ToastAction,
): void {
  useToastStore.getState().replaceAction(id, message, action);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

export const useToastStoreForTesting = useToastStore;
