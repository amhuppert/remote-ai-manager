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
  push: (message: string, options?: ToastOptions) => void;
  dismiss: (id: string) => void;
}

type ToastStore = ToastState & ToastActions;

const TOAST_TTL_MS = 2200;
/** Actionable toasts stay up long enough to reach and press the button. */
const ACTION_TOAST_TTL_MS = 6000;

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
      setTimeout(
        () => get().dismiss(id),
        action ? ACTION_TOAST_TTL_MS : TOAST_TTL_MS,
      );
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

export function pushToast(message: string, options?: ToastOptions): void {
  useToastStore.getState().push(message, options);
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

export const useToastStoreForTesting = useToastStore;
