"use client";

import { useEffect, useRef, type ReactNode } from "react";
import "./styles/cockpit.css";

export interface DiffSlideoverProps {
  open: boolean;
  onClose: () => void;
  projectName?: string;
  /** The read-only diff surface to host (MainDiffSurface). */
  children: ReactNode;
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/**
 * Right-anchored read-only diff slide-over for the project cockpit. Opened from
 * the `main · worktree` review chip; hosts the reused `DiffPanel` (via
 * `MainDiffSurface`) with no git-mutation controls. Dismissed with the ✕, the
 * Escape key, or a scrim click. It animates in via CSS on mount; closing
 * unmounts it.
 */
export default function DiffSlideover({
  open,
  onClose,
  projectName,
  children,
}: DiffSlideoverProps): React.JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="plc-diff-overlay" onMouseDown={onClose}>
      <div
        className="plc-diff-slideover"
        role="dialog"
        aria-modal="true"
        aria-label="Main worktree diff"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="plc-diff-top">
          <span className="plc-diff-ctx">
            <span className="plc-diff-ctx-dot" aria-hidden />
            {projectName ? `${projectName} · ` : ""}main · worktree
          </span>
          <span className="plc-diff-sub">Read-only review</span>
          <button
            ref={closeRef}
            type="button"
            className="plc-diff-close"
            onClick={onClose}
            aria-label="Close diff"
            title="Close (Esc)"
          >
            <CloseGlyph />
          </button>
        </header>
        <div className="plc-diff-slideover-body">{children}</div>
      </div>
    </div>
  );
}
