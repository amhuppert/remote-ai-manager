"use client";

import { useState, useEffect, useCallback } from "react";

import { cn } from "@/lib/ui/cn";

import {
  mergeToastBaseClass,
  mergeToastShadowClass,
  mergeToastExitClass,
  toastIconClass,
  toastContentClass,
  toastTitleClass,
  toastDetailClass,
  toastActionClass,
  toastCloseClass,
} from "./MergeToast";

interface PromptErrorToastProps {
  sessionName?: string;
  projectName?: string;
  contextLabel?: string;
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
  projectName,
  contextLabel,
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

  const detailContext = contextLabel ?? sessionName ?? "";
  const detail = projectName
    ? `${projectName} / ${detailContext}: ${error}`
    : `${detailContext}: ${error}`;

  return (
    <div
      className={cn(
        mergeToastBaseClass,
        mergeToastShadowClass,
        "border-[var(--cc-red-border)]",
        exiting && mergeToastExitClass,
      )}
    >
      <div className={cn(toastIconClass, "text-red")}>
        <ErrorIcon />
      </div>
      <div className={toastContentClass}>
        <span className={toastTitleClass}>Prompt failed</span>
        <span className={toastDetailClass}>{detail}</span>
      </div>
      {onAction && (
        <button className={toastActionClass} onClick={onAction}>
          View
        </button>
      )}
      <button className={toastCloseClass} onClick={handleDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}
