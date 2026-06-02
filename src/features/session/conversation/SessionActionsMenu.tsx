"use client";

import { useEffect, useRef, useState } from "react";
import { useOverlayScope } from "@/hooks/useOverlayScope";

export interface SessionActionsMenuProps {
  targetBranch: string;
  commitDisabled: boolean;
  onCommit: () => void;
  onMerge: () => void;
  onPush?: () => void;
  onRebase?: () => void;
  onDelete: () => void;
}

export default function SessionActionsMenu({
  targetBranch,
  commitDisabled,
  onCommit,
  onMerge,
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
    <div className="session-actions" ref={rootRef}>
      <button
        type="button"
        className={`session-actions-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="session-actions-label">Actions</span>
        <span className="session-actions-chevron" aria-hidden="true">
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>
      {open && (
        <div className="session-actions-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="session-actions-item"
            onClick={pick(onCommit)}
            disabled={commitDisabled}
          >
            <span className="sa-item-glyph" aria-hidden="true">
              {"\u23CE"}
            </span>
            <span className="sa-item-body">
              <span className="sa-item-label">Commit changes</span>
              <span className="sa-item-desc">
                Stage and commit working diff
              </span>
            </span>
            <span className="sa-item-shortcut">{"\u2318\u23CE"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-actions-item session-actions-item--primary"
            onClick={pick(onMerge)}
          >
            <span className="sa-item-glyph" aria-hidden="true">
              {"\u21E8"}
            </span>
            <span className="sa-item-body">
              <span className="sa-item-label">Merge into {targetBranch}</span>
              <span className="sa-item-desc">
                Squash &amp; merge this branch
              </span>
            </span>
            <span className="sa-item-shortcut">{"\u2318M"}</span>
          </button>
          <div className="session-actions-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="session-actions-item"
            onClick={pick(onPush)}
            disabled={!onPush}
            title={onPush ? undefined : "Push not available yet"}
          >
            <span className="sa-item-glyph" aria-hidden="true">
              {"\u2191"}
            </span>
            <span className="sa-item-body">
              <span className="sa-item-label">Push branch</span>
              <span className="sa-item-desc">Push to remote</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="session-actions-item"
            onClick={pick(onRebase)}
            disabled={!onRebase}
            title={onRebase ? undefined : "Rebase not available yet"}
          >
            <span className="sa-item-glyph" aria-hidden="true">
              {"\u2934"}
            </span>
            <span className="sa-item-body">
              <span className="sa-item-label">Rebase on {targetBranch}</span>
              <span className="sa-item-desc">Replay commits onto target</span>
            </span>
          </button>
          <div className="session-actions-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="session-actions-item session-actions-item--danger"
            onClick={pick(onDelete)}
          >
            <span className="sa-item-glyph" aria-hidden="true">
              {"\u2715"}
            </span>
            <span className="sa-item-body">
              <span className="sa-item-label">Delete session…</span>
              <span className="sa-item-desc">
                Delete worktree and session state
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
