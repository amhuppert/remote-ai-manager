"use client";

import { useState, useEffect, useCallback } from "react";

import { cn } from "@/lib/ui/cn";

// ── Shared toast recipe (consumed by InputNeededToast / PromptErrorToast) ──

/** Layout/box/animation shared by every toast surface (no shadow, no border-color). */
export const mergeToastBaseClass =
  "fixed bottom-lg left-1/2 z-toast flex w-max max-w-[560px] -translate-x-1/2 items-start gap-sm rounded-md border border-solid bg-bg-surface px-md py-sm animate-[toastSlideIn_0.25s_ease] max-768:bottom-md max-768:left-md max-768:right-md max-768:w-auto max-768:max-w-none max-768:translate-x-0";

/** Default two-layer black drop shadow. */
export const mergeToastShadowClass =
  "shadow-[0_8px_32px_var(--cc-shadow-soft),0_2px_8px_var(--cc-black-a20)]";

/** Exit animation, important so it overrides the entry animation (legacy `!important`). */
export const mergeToastExitClass =
  "animate-[toastSlideOut_0.2s_ease_forwards]!";

export const toastIconClass = "flex shrink-0 items-center";
export const toastContentClass = "flex min-w-0 flex-1 flex-col gap-px";
export const toastTitleClass =
  "font-mono text-[0.75rem] font-semibold text-text-primary";
export const toastDetailClass =
  "font-mono text-[0.7rem] break-words whitespace-normal text-text-tertiary";
export const toastDetailCodeClass =
  "rounded-[2px] bg-bg-raised px-[4px] py-0 text-[0.7rem] text-cyan";
export const toastActionClass =
  "shrink-0 cursor-pointer rounded-sm border border-solid border-border-default bg-transparent px-[10px] py-[4px] font-mono text-[0.7rem] font-semibold text-cyan transition-all duration-150 ease-[ease] hover:border-cyan-glow-strong hover:bg-cyan-glow max-768:min-h-[36px] max-768:px-[12px] max-768:py-[6px]";
export const toastCloseClass =
  "flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent text-text-tertiary transition-all duration-150 ease-[ease] hover:bg-bg-hover hover:text-text-secondary max-768:h-[36px] max-768:w-[36px]";

// ── Types ──────────────────────────────────────────────────────

type MergeToastVariant = "success" | "conflicts" | "error" | "ready-to-land";

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
  /** Auto-dismiss after ms (0 = no auto-dismiss); ignored for ready-to-land */
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

  // Auto-dismiss timer — ready-to-land persists until user lands or discards
  useEffect(() => {
    if (variant === "ready-to-land") return;
    if (!autoDismissMs || !visible) return;
    const timer = setTimeout(handleDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [autoDismissMs, visible, handleDismiss, variant]);

  if (!visible) return null;

  const variantConfig = {
    success: {
      icon: <CheckIcon />,
      title: "Merge complete",
      detail: (
        <>
          <code className={toastDetailCodeClass}>{branchName}</code> merged into{" "}
          <code className={toastDetailCodeClass}>{targetBranch}</code>
          {mergeHash && (
            <>
              {" "}
              <span className="text-text-tertiary">{mergeHash}</span>
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
          <code className={toastDetailCodeClass}>{branchName}</code> has
          conflicts with{" "}
          <code className={toastDetailCodeClass}>{targetBranch}</code>
        </>
      ),
      actionLabel: "Review",
    },
    error: {
      icon: <ErrorIcon />,
      title: "Merge failed",
      detail: (
        <>
          {errorMessage ?? "An error occurred"} —{" "}
          <code className={toastDetailCodeClass}>{branchName}</code>
        </>
      ),
      actionLabel: "Details",
    },
    "ready-to-land": {
      icon: <WarningIcon />,
      title: (
        <>
          Merge ready to land — <code>{branchName}</code>
        </>
      ),
      detail: (
        <>
          Awaiting clean{" "}
          <code className={toastDetailCodeClass}>{targetBranch}</code> worktree
        </>
      ),
      actionLabel: "Land",
    },
  };

  const config = variantConfig[variant];

  return (
    <div
      className={cn(
        mergeToastBaseClass,
        mergeToastShadowClass,
        borderVariantClass[variant],
        exiting && mergeToastExitClass,
      )}
    >
      <div className={cn(toastIconClass, iconVariantClass[variant])}>
        {config.icon}
      </div>
      <div className={toastContentClass}>
        <span className={toastTitleClass}>{config.title}</span>
        <span className={toastDetailClass}>{config.detail}</span>
      </div>
      {onAction && (
        <button className={toastActionClass} onClick={onAction}>
          {config.actionLabel}
        </button>
      )}
      <button className={toastCloseClass} onClick={handleDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}

/** Variant border-color. */
const borderVariantClass: Record<MergeToastVariant, string> = {
  success: "border-[var(--cc-green-border)]",
  conflicts: "border-[var(--cc-amber-a30)]",
  error: "border-[var(--cc-red-border)]",
  "ready-to-land": "border-border-default",
};

const iconVariantClass: Record<MergeToastVariant, string> = {
  success: "text-green",
  conflicts: "text-amber",
  error: "text-red",
  "ready-to-land": "",
};
