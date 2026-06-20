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

interface InputNeededToastProps {
  sessionName?: string;
  contextLabel?: string;
  projectName: string;
  title?: string;
  variant?: "approval";
  contextTitle?: string;
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
  title,
  variant,
  contextTitle,
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
  const isApproval = variant === "approval";
  const detail = `${projectName} / ${detailContext}`;

  return (
    <div
      className={cn(
        mergeToastBaseClass,
        isApproval
          ? "border-[var(--cc-amber-a45)] shadow-[0_8px_32px_var(--cc-shadow-soft),0_0_18px_var(--amber-glow)]"
          : cn("border-[var(--cc-amber-a30)]", mergeToastShadowClass),
        exiting && mergeToastExitClass,
      )}
    >
      <div
        className={cn(
          toastIconClass,
          "text-amber",
          isApproval && "self-center",
        )}
      >
        {isApproval ? (
          <span
            className="block size-[7px] animate-pulse-dot rounded-full bg-amber shadow-[0_0_7px_var(--amber)]"
            aria-hidden="true"
          />
        ) : (
          <InputIcon />
        )}
      </div>
      <div className={toastContentClass}>
        <span className={toastTitleClass}>{title ?? "Needs input"}</span>
        <span className={toastDetailClass}>
          {contextTitle !== undefined ? `${contextTitle} · ${detail}` : detail}
        </span>
      </div>
      {onAction && (
        <button className={toastActionClass} onClick={onAction}>
          {isApproval ? "Review" : "View"}
        </button>
      )}
      <button className={toastCloseClass} onClick={handleDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}
