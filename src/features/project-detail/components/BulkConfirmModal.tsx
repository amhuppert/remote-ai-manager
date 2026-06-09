"use client";

import { useEffect, useRef } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";

export type BulkConfirmKind = "archive" | "unarchive" | "delete";

interface BulkConfirmModalProps {
  open: boolean;
  kind: BulkConfirmKind;
  count: number;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

interface Copy {
  title: string;
  body: string;
  primary: string;
  danger: boolean;
}

function buildCopy(kind: BulkConfirmKind, count: number): Copy {
  const noun = count === 1 ? "session" : "sessions";
  if (kind === "archive") {
    return {
      title: "Archive sessions?",
      body: `Archive ${count} ${noun}. They stay accessible via "Include archived".`,
      primary: `Archive ${count}`,
      danger: false,
    };
  }
  if (kind === "unarchive") {
    return {
      title: "Unarchive sessions?",
      body: `Unarchive ${count} ${noun}.`,
      primary: `Unarchive ${count}`,
      danger: false,
    };
  }
  return {
    title: "Delete sessions?",
    body: `This permanently removes the worktree, history, and state for ${count} ${noun}. The git branch is preserved. This cannot be undone.`,
    primary: `Delete ${count}`,
    danger: true,
  };
}

export default function BulkConfirmModal({
  open,
  kind,
  count,
  isPending,
  onConfirm,
  onClose,
}: BulkConfirmModalProps): React.JSX.Element | null {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmButtonRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [open, onClose]);

  useOverlayScope(open);

  if (!open) return null;

  const copy = buildCopy(kind, count);

  return (
    <div className="modal-overlay" data-testid="bulk-confirm-overlay">
      <div className="modal confirm-modal">
        <h2 className="modal-title">{copy.title}</h2>
        <p className="confirm-message">{copy.body}</p>
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose} disabled={isPending}>
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            className={`btn btn-sm ${copy.danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={isPending}
          >
            {copy.primary}
          </button>
        </div>
      </div>
    </div>
  );
}
