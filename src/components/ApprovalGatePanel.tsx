"use client";

import { useState } from "react";
import { cn } from "@/lib/ui/cn";

// Local button recipe: the legacy `.btn.btn-sm.<variant>` plus the panel-only
// `.approval-gate-actions .btn` rules (whitespace + the 0.45-opacity disabled
// fade). The shared Button primitive cannot carry that disabled fade (it omits
// className and the fade is keyed on the button's own :disabled state, not the
// layout allowlist), so the recipe is authored here for parity.
const ACTION_BTN_BASE =
  "inline-flex items-center gap-sm rounded-md border border-solid px-[12px] py-[6px] " +
  "font-mono text-[0.72rem] whitespace-nowrap transition-all duration-150 ease-[ease] " +
  "disabled:cursor-not-allowed disabled:opacity-[0.45] disabled:pointer-events-none";
const ACTION_BTN_VARIANT = {
  primary:
    "bg-cyan border-cyan font-semibold text-text-inverse hover:bg-cyan-dim hover:border-cyan-dim hover:shadow-[0_0_20px_var(--color-cyan-glow)]",
  danger:
    "bg-transparent border-[var(--cc-red-border)] font-medium text-red hover:bg-red-glow hover:border-red-dim",
  ghost:
    "bg-transparent border-transparent font-medium text-text-secondary hover:bg-bg-hover hover:border-border-default hover:text-cyan",
} as const;

const HINT_BASE = "font-mono text-[0.7rem]";

interface ApprovalGatePanelProps {
  contextTitle: string | null;
  workflowName: string | null;
  /** ISO timestamp of when the gate parked; drives the wait-time readout. */
  requestedAt: string;
  isSubmitting: boolean;
  conversationBusy: boolean;
  executionSuspended: boolean;
  onApprove(): void;
  onReject(message: string): void;
}

function formatWaitTime(isoDate: string): string | null {
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "waiting <1m";
  if (minutes < 60) return `waiting ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `waiting ${hours}h`;
  const days = Math.floor(hours / 24);
  return `waiting ${days}d`;
}

export default function ApprovalGatePanel({
  contextTitle,
  workflowName,
  requestedAt,
  isSubmitting,
  conversationBusy,
  executionSuspended,
  onApprove,
  onReject,
}: ApprovalGatePanelProps) {
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState("");

  const actionsDisabled = isSubmitting || conversationBusy;
  const trimmedMessage = message.trim();
  const waitLabel = formatWaitTime(requestedAt);

  const busyHint = conversationBusy
    ? "Chat turn in progress — actions re-enable when it completes."
    : isSubmitting
      ? "Submitting decision…"
      : null;

  const cancelReject = () => {
    setRejecting(false);
    setMessage("");
  };

  const handleRejectKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (actionsDisabled || trimmedMessage === "") return;
      onReject(trimmedMessage);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (isSubmitting) return;
      cancelReject();
    }
  };

  return (
    <div
      className="relative flex shrink-0 flex-col gap-sm border-x-0 border-t border-b-0 border-solid border-t-border-subtle bg-bg-base px-lg py-md before:absolute before:inset-x-0 before:-top-px before:h-[2px] before:opacity-80 before:content-[''] before:[background:linear-gradient(90deg,var(--amber),transparent_65%)]"
      data-testid="approval-gate-panel"
    >
      <div className="flex items-center gap-md">
        <span
          className="size-[7px] shrink-0 animate-pulse-dot rounded-full bg-amber shadow-[0_0_8px_var(--amber)]"
          aria-hidden="true"
        />
        <div className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] whitespace-nowrap text-amber uppercase">
          Approval required
        </div>
        {(contextTitle || workflowName) && (
          <div className="flex min-w-0 flex-1 items-baseline gap-sm overflow-hidden font-mono text-[0.7rem] whitespace-nowrap">
            {contextTitle && (
              <span className="overflow-hidden text-ellipsis text-text-secondary">
                {contextTitle}
              </span>
            )}
            {contextTitle && workflowName && (
              <span className="text-text-tertiary" aria-hidden="true">
                /
              </span>
            )}
            {workflowName && (
              <span className="whitespace-nowrap text-text-tertiary">
                {workflowName}
              </span>
            )}
          </div>
        )}
        {waitLabel !== null && (
          <span className="ml-auto font-mono text-[0.66rem] whitespace-nowrap text-text-tertiary">
            {waitLabel}
          </span>
        )}
        {!rejecting && (
          <div className="flex shrink-0 items-center gap-sm">
            <button
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.primary)}
              disabled={actionsDisabled}
              onClick={onApprove}
            >
              Approve
            </button>
            <button
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.danger)}
              disabled={actionsDisabled}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </div>
        )}
      </div>

      {busyHint && (
        <div className={cn(HINT_BASE, "text-text-tertiary")}>{busyHint}</div>
      )}
      {executionSuspended && (
        <div className={cn(HINT_BASE, "text-amber-dim")}>
          Execution suspended — the decision applies when the workflow resumes.
        </div>
      )}

      {rejecting && (
        <div className="flex flex-col gap-sm">
          <textarea
            className="w-full resize-y rounded-md border border-solid border-border-default bg-bg-surface px-md py-sm font-mono text-[0.78rem] leading-[1.5] text-text-primary transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary focus:border-red-dim focus:shadow-[0_0_0_2px_var(--red-glow)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Rejection feedback"
            placeholder="Explain what needs to change..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleRejectKeyDown}
            disabled={isSubmitting}
            autoFocus
            rows={3}
          />
          <div className="flex shrink-0 items-center gap-sm">
            <button
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.danger)}
              disabled={actionsDisabled || trimmedMessage === ""}
              onClick={() => onReject(trimmedMessage)}
            >
              Submit rejection
            </button>
            <button
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.ghost)}
              disabled={isSubmitting}
              onClick={cancelReject}
            >
              Cancel
            </button>
            <span className="ml-auto font-mono text-[0.64rem] text-text-tertiary">
              ⌘↵ submit · esc cancel
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
