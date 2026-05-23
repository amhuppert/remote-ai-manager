"use client";

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

export default function Toast({
  message,
  onDismiss,
}: ToastProps): React.JSX.Element {
  return (
    <div
      role="status"
      className="cc-toast"
      onClick={onDismiss}
      aria-live="polite"
    >
      {message}
    </div>
  );
}
