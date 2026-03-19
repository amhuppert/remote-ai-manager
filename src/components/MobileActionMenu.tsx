"use client";

import { useState, useCallback, useEffect } from "react";
import TddToggle from "@/components/TddToggle";

interface MobileActionMenuProps {
  /** Whether TDD mode is enabled */
  tddEnabled: boolean;
  /** Callback for TDD toggle */
  onTddToggle: (enabled: boolean) => void;
  /** Whether TDD toggle is disabled */
  tddDisabled?: boolean;
  /** Whether commit is disabled */
  commitDisabled: boolean;
  /** Whether merge is disabled */
  mergeDisabled: boolean;
  /** Commit handler */
  onCommit: () => void;
  /** Merge handler */
  onMerge: () => void;
  /** Delete handler */
  onDelete: () => void;
  /** Dev servers: count of running / total */
  devServerCounts?: { running: number; total: number };
  /** Handler to open dev server drawer */
  onDevServers?: () => void;
}

export default function MobileActionMenu({
  tddEnabled,
  onTddToggle,
  tddDisabled = false,
  commitDisabled,
  mergeDisabled,
  onCommit,
  onMerge,
  onDelete,
  devServerCounts,
  onDevServers,
}: MobileActionMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleAction = useCallback((action: () => void) => {
    setOpen(false);
    action();
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      <button
        className="mobile-action-menu-trigger"
        onClick={() => setOpen(true)}
        aria-label="Session actions"
        type="button"
      >
        &#8943;
      </button>

      {/* Backdrop */}
      <div
        className={`mobile-action-backdrop${open ? " visible" : ""}`}
        onClick={handleClose}
      />

      {/* Action sheet */}
      <div className={`mobile-action-sheet${open ? " visible" : ""}`}>
        <div className="mobile-action-sheet-handle" />

        {/* Settings section */}
        <div className="mobile-action-sheet-section">
          <div className="mobile-action-sheet-label">Settings</div>
          <div className="mobile-action-tdd-row">
            <TddToggle
              enabled={tddEnabled}
              onChange={onTddToggle}
              disabled={tddDisabled}
            />
          </div>
          {onDevServers && (
            <button
              className="mobile-action-ds-row"
              onClick={() => handleAction(onDevServers)}
              type="button"
            >
              <span className="mobile-action-icon">{"\u2630"}</span>
              <span className="mobile-action-label">Dev Servers</span>
              {devServerCounts && devServerCounts.total > 0 && (
                <span className="mobile-action-meta">
                  {devServerCounts.running}/{devServerCounts.total}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="mobile-action-sheet-divider" />

        {/* Actions section */}
        <div className="mobile-action-sheet-section">
          <div className="mobile-action-sheet-label">Actions</div>
          <button
            className="mobile-action-btn-commit"
            onClick={() => handleAction(onCommit)}
            disabled={commitDisabled}
            type="button"
          >
            <span>{"\u2714"}</span>
            <span>Commit</span>
          </button>
          <button
            className="mobile-action-btn-merge"
            onClick={() => handleAction(onMerge)}
            disabled={mergeDisabled}
            type="button"
          >
            <span>{"\u2192"}</span>
            <span>Merge into Main</span>
          </button>
        </div>

        <div className="mobile-action-sheet-divider" />

        {/* Danger zone */}
        <div className="mobile-action-sheet-section">
          <button
            className="mobile-action-item danger"
            onClick={() => handleAction(onDelete)}
            type="button"
          >
            <span className="mobile-action-icon">{"\u2715"}</span>
            <span className="mobile-action-label">Delete session</span>
          </button>
        </div>
      </div>
    </>
  );
}
