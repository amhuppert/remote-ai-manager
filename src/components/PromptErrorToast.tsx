"use client";

import { useState, useEffect, useCallback } from "react";

interface PromptErrorToastProps {
  sessionName: string;
  error: string;
  onAction?: () => void;
  onDismiss?: () => void;
  autoDismissMs?: number;
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

export default function PromptErrorToast({
  sessionName,
  error,
  onAction,
  onDismiss,
  autoDismissMs = 12_000,
}: PromptErrorToastProps) {
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

  return (
    <div
      className={`merge-toast merge-toast-error${exiting ? " merge-toast-exit" : ""}`}
    >
      <div className="merge-toast-icon">
        <ErrorIcon />
      </div>
      <div className="merge-toast-content">
        <span className="merge-toast-title">Prompt failed</span>
        <span className="merge-toast-detail">
          {sessionName}: {error}
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
