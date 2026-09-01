"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/ui/cn";

export interface CaptureConfirmationToastProps {
  notepadName: string;
  /** The first line of what landed; empty when there was nothing to quote. */
  preview: string;
  onOpen(): void;
  onUndo(): void;
  onDismiss(): void;
}

/** Long enough to read a destination and reach for Undo, short enough to leave. */
const DISMISS_AFTER_MS = 12_000;

const surfaceClass =
  "fixed bottom-lg left-1/2 z-toast flex max-w-[min(92vw,480px)] items-center gap-sm rounded-full border border-solid border-cyan-dim bg-bg-elevated px-md py-sm shadow-[0_8px_24px_var(--cc-black-a50)] [transform:translateX(-50%)]";

const actionClass =
  "inline-flex shrink-0 cursor-pointer items-center rounded-full border border-solid border-cyan-dim bg-transparent px-sm py-[2px] font-mono text-[0.72rem] font-semibold text-cyan hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

/**
 * The landed-capture confirmation: where the content went, what it says, and
 * the two things a user wants next — see it, or take it back.
 *
 * A surface of its own rather than the shared toast store, which carries a
 * single action; a capture needs both open and undo (R25.3). Portaled to
 * document.body for the same reason the recording pill is.
 */
export function CaptureConfirmationToast({
  notepadName,
  preview,
  onOpen,
  onUndo,
  onDismiss,
}: CaptureConfirmationToastProps): React.JSX.Element | null {
  useEffect(() => {
    const timer = setTimeout(onDismiss, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <section
      role="status"
      aria-label="Capture landed"
      aria-live="polite"
      className={surfaceClass}
    >
      <p className="m-0 min-w-0 truncate font-mono text-[0.74rem] text-text-primary">
        <span className="text-text-secondary">Captured to </span>
        {notepadName}
        {preview !== "" && (
          <span className="text-text-secondary"> — “{preview}”</span>
        )}
      </p>
      <button type="button" className={actionClass} onClick={onOpen}>
        Open
      </button>
      <button
        type="button"
        className={cn(actionClass, "border-border-default text-text-secondary")}
        onClick={onUndo}
      >
        Undo
      </button>
    </section>,
    document.body,
  );
}
