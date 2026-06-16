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

const HEADER_CLASS =
  "flex items-center gap-md px-lg py-sm border-x-0 border-t-0 border-b border-solid border-border-default bg-bg-base shrink-0";

const CONTEXT_CLASS =
  "inline-flex items-center gap-xs font-mono font-semibold text-[0.76rem] text-text-primary";

const CONTEXT_DOT_CLASS = "w-[6px] h-[6px] rounded-full bg-green";

const SUBTITLE_CLASS = "font-mono text-[0.66rem] text-text-tertiary";

const CLOSE_CLASS =
  "ml-auto inline-flex items-center justify-center w-[28px] h-[28px] rounded-sm " +
  "border border-solid border-border-subtle bg-bg-surface text-text-secondary cursor-pointer " +
  "transition-[border-color,color] duration-150 ease-[ease] hover:border-red hover:text-red";

const BODY_CLASS = "flex flex-1 min-h-0 flex-col";

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
        <header className={HEADER_CLASS}>
          <span className={CONTEXT_CLASS}>
            <span className={CONTEXT_DOT_CLASS} aria-hidden />
            {projectName ? `${projectName} · ` : ""}main · worktree
          </span>
          <span className={SUBTITLE_CLASS}>Read-only review</span>
          <button
            ref={closeRef}
            type="button"
            className={CLOSE_CLASS}
            onClick={onClose}
            aria-label="Close diff"
            title="Close (Esc)"
          >
            <CloseGlyph />
          </button>
        </header>
        <div className={BODY_CLASS}>{children}</div>
      </div>
    </div>
  );
}
