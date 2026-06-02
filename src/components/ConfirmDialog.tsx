"use client";

import { useEffect, useRef } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onConfirm();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onConfirm, onCancel]);

  useOverlayScope(open);

  if (!open) return null;

  return (
    <div className="modal-overlay" data-testid="modal-overlay">
      <div className="modal confirm-modal">
        <h2 className="modal-title">{title}</h2>
        <p className="confirm-message">{message}</p>
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
