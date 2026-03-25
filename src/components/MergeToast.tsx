"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

type MergeToastVariant = "success" | "conflicts" | "error";

interface MergeToastProps {
  variant: MergeToastVariant;
  branchName: string;
  /** Branch this session merges into */
  targetBranch?: string;
  /** Number of conflicts (for conflicts variant) */
  conflictCount?: number;
  /** Merge hash (for success variant) */
  mergeHash?: string;
  /** Error message (for error variant) */
  errorMessage?: string;
  /** Callback when clicking the action button */
  onAction?: () => void;
  /** Callback when dismissing */
  onDismiss?: () => void;
  /** Auto-dismiss after ms (0 = no auto-dismiss) */
  autoDismissMs?: number;
  /** Force visible for Storybook */
  visible?: boolean;
}

// ── Icons ──────────────────────────────────────────────────────

function CheckIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 7.5L6.5 9.5L9.5 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <path
        d="M7 1L13 12H1L7 1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <line
        x1="7"
        y1="5.5"
        x2="7"
        y2="8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10" r="0.6" fill="currentColor" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5 5L9 9M9 5L5 9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
      <path
        d="M2 2L8 8M8 2L2 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ── Component ──────────────────────────────────────────────────

export default function MergeToast({
  variant,
  branchName,
  targetBranch = "main",
  conflictCount,
  mergeHash,
  errorMessage,
  onAction,
  onDismiss,
  autoDismissMs = 0,
  visible: visibleProp,
}: MergeToastProps) {
  const [internalVisible, setInternalVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  const visible = visibleProp ?? internalVisible;

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setInternalVisible(false);
      onDismiss?.();
    }, 200);
  }, [onDismiss]);

  // Auto-dismiss timer
  useEffect(() => {
    if (!autoDismissMs || !visible) return;
    const timer = setTimeout(handleDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, visible, handleDismiss]);

  if (!visible) return null;

  const variantConfig = {
    success: {
      icon: <CheckIcon />,
      title: "Merge complete",
      detail: (
        <>
          <code>{branchName}</code> merged into <code>{targetBranch}</code>
          {mergeHash && (
            <>
              {" "}
              <span className="merge-toast-hash">{mergeHash}</span>
            </>
          )}
        </>
      ),
      actionLabel: "View",
    },
    conflicts: {
      icon: <WarningIcon />,
      title: `${conflictCount ?? 0} conflict${(conflictCount ?? 0) !== 1 ? "s" : ""} found`,
      detail: (
        <>
          <code>{branchName}</code> has conflicts with{" "}
          <code>{targetBranch}</code>
        </>
      ),
      actionLabel: "Review",
    },
    error: {
      icon: <ErrorIcon />,
      title: "Merge failed",
      detail: (
        <>
          {errorMessage ?? "An error occurred"} — <code>{branchName}</code>
        </>
      ),
      actionLabel: "Details",
    },
  };

  const config = variantConfig[variant];

  return (
    <div
      className={`merge-toast merge-toast-${variant} ${exiting ? "merge-toast-exit" : ""}`}
    >
      <div className="merge-toast-icon">{config.icon}</div>
      <div className="merge-toast-content">
        <span className="merge-toast-title">{config.title}</span>
        <span className="merge-toast-detail">{config.detail}</span>
      </div>
      {onAction && (
        <button className="merge-toast-action" onClick={onAction}>
          {config.actionLabel}
        </button>
      )}
      <button className="merge-toast-close" onClick={handleDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}
