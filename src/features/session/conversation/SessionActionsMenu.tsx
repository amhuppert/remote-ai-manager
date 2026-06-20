"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/ui/cn";
import { useOverlayScope } from "@/hooks/useOverlayScope";

// Base box only — text color/bg are supplied per call site so the danger
// variant's color/bg never collide on the same property with a shared default
// (utility cascade is source-order dependent). The higher-specificity
// enabled:hover / group-hover variants reliably override the per-site base,
// matching the legacy specificity (generic :hover beats the --danger rules).
const ITEM_CLASS =
  "group flex w-full cursor-pointer items-center gap-[10px] rounded-sm border-none bg-transparent px-[10px] py-[8px] text-left enabled:hover:bg-bg-hover enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45";
const GLYPH_CLASS =
  "inline-flex size-[22px] shrink-0 items-center justify-center rounded-sm font-mono text-[0.8rem] group-hover:text-text-primary";
const BODY_CLASS = "flex min-w-0 flex-1 flex-col gap-px";
const LABEL_CLASS = "text-[0.82rem] font-medium";
const DESC_CLASS = "font-mono text-[0.64rem] text-text-tertiary";

export interface SessionActionsMenuProps {
  targetBranch: string;
  onPush?: () => void;
  onRebase?: () => void;
  onDelete: () => void;
}

export default function SessionActionsMenu({
  targetBranch,
  onPush,
  onRebase,
  onDelete,
}: SessionActionsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useOverlayScope(open);

  const pick = (fn: (() => void) | undefined) => () => {
    setOpen(false);
    fn?.();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-open={open}
        className={cn(
          "group inline-flex h-[26px] cursor-pointer items-center gap-[5px] rounded-sm border border-solid border-border-default bg-transparent px-[10px] font-mono text-[0.68rem] font-semibold tracking-[0.04em] text-text-secondary uppercase transition-all duration-150 ease-[ease]",
          "data-[open=false]:hover:border-cyan data-[open=false]:hover:text-text-primary",
          "data-[open=true]:border-cyan data-[open=true]:bg-bg-hover data-[open=true]:text-text-primary",
        )}
        onClick={() => setOpen((o) => !o)}
        title="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="leading-none">Actions</span>
        <span
          className="text-[8px] text-text-tertiary group-data-[open=true]:text-cyan"
          aria-hidden="true"
        >
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>
      {open && (
        <div
          className="absolute top-[calc(100%+6px)] right-0 z-panel min-w-[280px] animate-[info-details-pop-in_0.12s_ease-out] rounded-md border border-solid border-border-default bg-bg-elevated p-[4px] shadow-dropdown"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className={cn(ITEM_CLASS, "text-text-secondary")}
            onClick={pick(onPush)}
            disabled={!onPush}
            title={onPush ? undefined : "Push not available yet"}
          >
            <span
              className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
              aria-hidden="true"
            >
              {"\u2191"}
            </span>
            <span className={BODY_CLASS}>
              <span className={LABEL_CLASS}>Push branch</span>
              <span className={DESC_CLASS}>Push to remote</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={cn(ITEM_CLASS, "text-text-secondary")}
            onClick={pick(onRebase)}
            disabled={!onRebase}
            title={onRebase ? undefined : "Rebase not available yet"}
          >
            <span
              className={cn(GLYPH_CLASS, "bg-bg-hover text-text-tertiary")}
              aria-hidden="true"
            >
              {"\u2934"}
            </span>
            <span className={BODY_CLASS}>
              <span className={LABEL_CLASS}>Rebase on {targetBranch}</span>
              <span className={DESC_CLASS}>Replay commits onto target</span>
            </span>
          </button>
          <div
            className="mx-[6px] my-[4px] h-px bg-border-default"
            role="separator"
          />
          <button
            type="button"
            role="menuitem"
            className={cn(ITEM_CLASS, "text-red")}
            onClick={pick(onDelete)}
          >
            <span
              className={cn(
                GLYPH_CLASS,
                "bg-[var(--cc-red-soft-a08)] text-red",
              )}
              aria-hidden="true"
            >
              {"\u2715"}
            </span>
            <span className={BODY_CLASS}>
              <span className={LABEL_CLASS}>Delete session…</span>
              <span className={DESC_CLASS}>
                Delete worktree and session state
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
