"use client";

import { useState } from "react";

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
    <div className="approval-gate-panel" data-testid="approval-gate-panel">
      <div className="approval-gate-row">
        <span className="approval-gate-dot" aria-hidden="true" />
        <div className="approval-gate-badge">Approval required</div>
        {(contextTitle || workflowName) && (
          <div className="approval-gate-meta">
            {contextTitle && (
              <span className="approval-gate-context">{contextTitle}</span>
            )}
            {contextTitle && workflowName && (
              <span className="approval-gate-sep" aria-hidden="true">
                /
              </span>
            )}
            {workflowName && (
              <span className="approval-gate-workflow">{workflowName}</span>
            )}
          </div>
        )}
        {waitLabel !== null && (
          <span className="approval-gate-wait">{waitLabel}</span>
        )}
        {!rejecting && (
          <div className="approval-gate-actions">
            <button
              className="btn btn-sm btn-primary"
              disabled={actionsDisabled}
              onClick={onApprove}
            >
              Approve
            </button>
            <button
              className="btn btn-sm btn-danger"
              disabled={actionsDisabled}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </div>
        )}
      </div>

      {busyHint && <div className="approval-gate-hint">{busyHint}</div>}
      {executionSuspended && (
        <div className="approval-gate-hint approval-gate-hint--suspended">
          Execution suspended — the decision applies when the workflow resumes.
        </div>
      )}

      {rejecting && (
        <div className="approval-gate-reject">
          <textarea
            className="approval-gate-reject-input"
            aria-label="Rejection feedback"
            placeholder="Explain what needs to change..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleRejectKeyDown}
            disabled={isSubmitting}
            autoFocus
            rows={3}
          />
          <div className="approval-gate-actions">
            <button
              className="btn btn-sm btn-danger"
              disabled={actionsDisabled || trimmedMessage === ""}
              onClick={() => onReject(trimmedMessage)}
            >
              Submit rejection
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={isSubmitting}
              onClick={cancelReject}
            >
              Cancel
            </button>
            <span className="approval-gate-kbd">⌘↵ submit · esc cancel</span>
          </div>
        </div>
      )}
    </div>
  );
}
