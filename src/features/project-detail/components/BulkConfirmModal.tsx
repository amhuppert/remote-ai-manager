"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
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
    <div
      className="fixed inset-0 z-dropdown flex animate-[fadeIn_0.15s_ease] items-center justify-center bg-[var(--cc-overlay-scrim)] backdrop-blur-[8px] max-768:items-end"
      data-testid="bulk-confirm-overlay"
    >
      <div className="w-full max-w-[400px] animate-[slideUp_0.2s_ease] rounded-lg border border-solid border-border-default bg-bg-surface p-xl max-768:max-w-full max-768:animate-[slideUpSheet_0.25s_ease] max-768:rounded-b-none max-768:px-md max-768:py-lg max-768:pb-[calc(var(--space-lg)+env(safe-area-inset-bottom,0))]">
        <h2 className="mb-lg font-display text-[1.2rem] font-bold">
          {copy.title}
        </h2>
        <p className="mb-lg font-mono text-[0.82rem] leading-[1.55] text-text-secondary">
          {copy.body}
        </p>
        <div className="flex justify-end gap-sm">
          <Button
            variant="default"
            size="sm"
            touch
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            autoFocus
            variant={copy.danger ? "danger" : "primary"}
            size="sm"
            touch
            onClick={onConfirm}
            disabled={isPending}
          >
            {copy.primary}
          </Button>
        </div>
      </div>
    </div>
  );
}
