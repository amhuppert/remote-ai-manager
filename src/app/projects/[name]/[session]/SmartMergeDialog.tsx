"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

interface SmartMergeDialogProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  sessionName: string;
  branchName: string;
  commitCount: number;
  hasUncommittedChanges: boolean;
  /** Override initial submitted state (for Storybook) */
  initialSubmitted?: boolean;
  /** Override initial auto-resolve state (for Storybook) */
  initialAutoResolve?: boolean;
}

// ── Icons ──────────────────────────────────────────────────────

function MergeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="12" cy="8" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4 5.5V10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M4 5.5C4 7.5 6 8 10.5 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Main component ─────────────────────────────────────────────

export default function SmartMergeDialog({
  open,
  onClose,
  projectName,
  sessionName,
  branchName,
  commitCount,
  hasUncommittedChanges,
  initialSubmitted,
  initialAutoResolve,
}: SmartMergeDialogProps): React.JSX.Element | null {
  const [autoResolve, setAutoResolve] = useState(initialAutoResolve ?? true);
  const [submitted, setSubmitted] = useState(initialSubmitted ?? false);
  const [error, setError] = useState<string | null>(null);
  const prevOpenRef = useRef(open);

  // Reset on open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on transition */
      setAutoResolve(initialAutoResolve ?? true);
      setSubmitted(initialSubmitted ?? false);
      setError(null);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, initialSubmitted, initialAutoResolve]);

  // Escape to close (always dismissible)
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const handleSubmit = useCallback(async () => {
    if (submitted) return;
    try {
      const url = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoResolve }),
      });
      if (res.status === 202) {
        setSubmitted(true);
      } else {
        const body = await res
          .json()
          .catch(() => ({ error: "Request failed" }));
        const apiBody = body as { error?: string; code?: string };
        if (
          apiBody.code === "SESSION_BUSY" ||
          apiBody.code === "JOB_ALREADY_RUNNING"
        ) {
          setError(
            "Session is busy — please wait for the current operation to finish.",
          );
        } else {
          setError(apiBody.error ?? "Failed to start merge");
        }
      }
    } catch {
      setError("Failed to start merge");
    }
  }, [submitted, projectName, sessionName, autoResolve]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal smart-merge-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="smart-merge-header">
          <MergeIcon size={18} />
          <h2 className="modal-title smart-merge-title">Smart Merge</h2>
        </div>

        {!submitted ? (
          <>
            {/* ── Configure form ── */}
            <div className="smart-merge-body">
              <p className="smart-merge-desc">
                Safely merge <code>{branchName}</code> into <code>main</code>{" "}
                using a three-step process: sync with main, commit any changes,
                then squash merge.
              </p>

              <div className="merge-info">
                <div className="merge-info-row">
                  <span className="merge-info-label">Branch</span>
                  <span className="merge-info-value">{branchName}</span>
                </div>
                <div className="merge-info-row">
                  <span className="merge-info-label">Commits</span>
                  <span className="merge-info-value">{commitCount}</span>
                </div>
                {hasUncommittedChanges && (
                  <div className="merge-info-row">
                    <span className="merge-info-label">Uncommitted</span>
                    <span className="merge-info-value smart-merge-warning-text">
                      Will be committed first
                    </span>
                  </div>
                )}
              </div>

              {/* ── Auto-resolve toggle ── */}
              <div className="smart-merge-toggle-row">
                <button
                  className={`smart-merge-toggle ${autoResolve ? "on" : ""}`}
                  onClick={() => setAutoResolve(!autoResolve)}
                  type="button"
                  aria-pressed={autoResolve}
                >
                  <span className="smart-merge-toggle-track">
                    <span className="smart-merge-toggle-thumb" />
                  </span>
                </button>
                <div className="smart-merge-toggle-info">
                  <span className="smart-merge-toggle-label">
                    Auto-resolve conflicts
                  </span>
                  <span className="smart-merge-toggle-hint">
                    {autoResolve
                      ? "Claude will analyze and resolve conflicts automatically"
                      : "You\u2019ll review each conflict before applying fixes"}
                  </span>
                </div>
              </div>

              {error && <p className="smart-merge-error">{error}</p>}
            </div>

            {/* ── Actions ── */}
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={submitted}
                onClick={handleSubmit}
              >
                Start Merge
              </button>
            </div>
          </>
        ) : (
          <>
            {/* ── Submitted confirmation ── */}
            <div className="smart-merge-body">
              <div className="smart-merge-submitted">
                <div className="smart-merge-submitted-icon">
                  <svg width={20} height={20} viewBox="0 0 20 20" fill="none">
                    <path
                      d="M10 2L18 18H2L10 2Z"
                      stroke="currentColor"
                      strokeWidth="0"
                      fill="currentColor"
                      opacity="0.15"
                    />
                    <path
                      d="M3 10L8 15L17 5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <span className="smart-merge-submitted-title">
                  Merge job started
                </span>
                <span className="smart-merge-submitted-detail">
                  Merging <code>{branchName}</code> into <code>main</code>
                  {autoResolve
                    ? " with auto-resolve enabled"
                    : " — you\u2019ll be notified if conflicts are found"}
                </span>
                <span className="smart-merge-submitted-hint">
                  You can close this dialog and continue working. You&apos;ll be
                  notified when the merge completes
                  {!autoResolve && " or if conflicts need your review"}.
                </span>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary btn-sm" onClick={onClose}>
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
