"use client";

import { useState, useEffect, useCallback } from "react";

interface InputNeededToastProps {
  sessionName?: string;
  contextLabel?: string;
  projectName: string;
  onAction?: () => void;
  onDismiss?: () => void;
  autoDismissMs?: number;
}

function InputIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
      <line
        x1="7"
        y1="4"
        x2="7"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10" r="0.7" fill="currentColor" />
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

export default function InputNeededToast({
  sessionName,
  contextLabel,
  projectName,
  onAction,
  onDismiss,
  autoDismissMs = 10_000,
}: InputNeededToastProps) {
  const [visible, setVisible] = useState(true);
  const [exiting, setExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      onDismiss?.();
    }, 200);
  }, [onDismiss]);

  useEffect(() => {
    if (!autoDismissMs || !visible) return;
    const timer = setTimeout(handleDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, visible, handleDismiss]);

  if (!visible) return null;

  const detailContext = contextLabel ?? sessionName ?? "";

  return (
    <div
      className={`merge-toast merge-toast-conflicts${exiting ? " merge-toast-exit" : ""}`}
    >
      <div className="merge-toast-icon">
        <InputIcon />
      </div>
      <div className="merge-toast-content">
        <span className="merge-toast-title">Needs input</span>
        <span className="merge-toast-detail">
          {projectName} / {detailContext}
        </span>
      </div>
      {onAction && (
        <button className="merge-toast-action" onClick={onAction}>
          View
        </button>
      )}
      <button className="merge-toast-close" onClick={handleDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}
