"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { useOverlayScope } from "@/hooks/useOverlayScope";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Hide the cancel button to render an acknowledge-only (info) dialog. */
  hideCancel?: boolean;
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
  hideCancel = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.JSX.Element | null {
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
    <div
      className="fixed inset-0 z-dropdown flex animate-[fadeIn_0.15s_ease] items-center justify-center bg-[var(--cc-overlay-scrim)] backdrop-blur-[8px] max-768:items-end"
      data-testid="modal-overlay"
    >
      <div className="w-full max-w-[400px] animate-[slideUp_0.2s_ease] rounded-lg border border-solid border-border-default bg-bg-surface p-xl max-768:max-w-full max-768:animate-[slideUpSheet_0.25s_ease] max-768:rounded-b-none max-768:px-md max-768:py-lg max-768:pb-[calc(var(--space-lg)+env(safe-area-inset-bottom,0))]">
        <h2 className="mb-lg font-display text-[1.2rem] font-bold">{title}</h2>
        <p className="mb-lg font-mono text-[0.82rem] leading-[1.55] text-text-secondary">
          {message}
        </p>
        <div className="flex justify-end gap-sm">
          {!hideCancel && (
            <Button variant="default" size="sm" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          <Button
            autoFocus
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
