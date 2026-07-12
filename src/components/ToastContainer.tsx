"use client";

import { useToasts, useDismissToast } from "@/stores/toast.store";
import Toast from "./Toast";

export default function ToastContainer(): React.JSX.Element | null {
  const toasts = useToasts();
  const dismiss = useDismissToast();
  if (toasts.length === 0) return null;
  return (
    <>
      {toasts.map((t) => (
        <Toast
          key={t.id}
          message={t.message}
          action={t.action}
          onDismiss={() => dismiss(t.id)}
        />
      ))}
    </>
  );
}
