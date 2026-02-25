"use client";

import { useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

export interface ConflictEntry {
  file: string;
  description: string;
  resolution: string;
  rationale: string;
}

type ConflictDecision = "pending" | "approved" | "rejected";

interface ConflictState {
  decision: ConflictDecision;
  feedback: string;
}

interface MergeConflictsPageProps {
  projectName: string;
  sessionName: string;
  branchName: string;
  conflicts: ConflictEntry[];
  /** Callback when user clicks "Accept All and Fix" — fires async job */
  onAcceptAll?: () => void;
  /** Callback when user clicks "Fix with Claude" — fires async job with decisions */
  onFixApproved?: (
    decisions: Array<{
      file: string;
      decision: ConflictDecision;
      feedback: string;
    }>,
  ) => void;
  /** Callback to go back to the session */
  onBack?: () => void;
}

// ── Icons ──────────────────────────────────────────────────────

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path
        d="M2.5 6.5L5 9L9.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path
        d="M3 3L9 9M9 3L3 9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WarningIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
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

function ArrowLeftIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path
        d="M8.5 3L4.5 7L8.5 11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Conflict card with approve/reject ──────────────────────────

function ConflictReviewCard({
  conflict,
  index,
  state,
  onApprove,
  onReject,
  onFeedbackChange,
}: {
  conflict: ConflictEntry;
  index: number;
  state: ConflictState;
  onApprove: () => void;
  onReject: () => void;
  onFeedbackChange: (feedback: string) => void;
}) {
  const [expanded, setExpanded] = useState(state.decision !== "approved");

  const handleApprove = useCallback(() => {
    onApprove();
    if (state.decision !== "approved") {
      setExpanded(false);
    }
  }, [onApprove, state.decision]);

  const handleReject = useCallback(() => {
    onReject();
    if (state.decision !== "rejected") {
      setExpanded(true);
    }
  }, [onReject, state.decision]);

  return (
    <div
      className={`cr-card ${state.decision !== "pending" ? `cr-card-${state.decision}` : ""}`}
    >
      <div className="cr-card-header">
        <button
          className="cr-card-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`cr-card-chevron ${expanded ? "expanded" : ""}`}>
            ▸
          </span>
          <span className="cr-card-number">{index + 1}</span>
          <span className="cr-card-file">{conflict.file}</span>
        </button>
        <div className="cr-card-actions">
          <button
            className={`cr-action-btn cr-approve ${state.decision === "approved" ? "active" : ""}`}
            onClick={handleApprove}
            title="Approve this resolution"
          >
            <CheckIcon size={11} />
          </button>
          <button
            className={`cr-action-btn cr-reject ${state.decision === "rejected" ? "active" : ""}`}
            onClick={handleReject}
            title="Reject this resolution"
          >
            <XIcon size={11} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="cr-card-body">
          <div className="cr-section">
            <span className="cr-section-label">Conflict</span>
            <p className="cr-section-text">{conflict.description}</p>
          </div>
          <div className="cr-section">
            <span className="cr-section-label">Proposed Resolution</span>
            <p className="cr-section-text">{conflict.resolution}</p>
          </div>
          <div className="cr-section">
            <span className="cr-section-label">Rationale</span>
            <p className="cr-section-text">{conflict.rationale}</p>
          </div>

          {state.decision === "rejected" && (
            <div className="cr-feedback">
              <label className="cr-feedback-label">Guidance for Claude</label>
              <textarea
                className="form-input cr-feedback-input"
                rows={2}
                placeholder="Explain how this conflict should be resolved instead..."
                value={state.feedback}
                onChange={(e) => onFeedbackChange(e.target.value)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page component ────────────────────────────────────────

export default function MergeConflictsPage({
  projectName,
  sessionName,
  branchName,
  conflicts,
  onAcceptAll,
  onFixApproved,
  onBack,
}: MergeConflictsPageProps) {
  const [decisions, setDecisions] = useState<ConflictState[]>(
    conflicts.map(() => ({ decision: "pending" as const, feedback: "" })),
  );

  const handleApprove = useCallback((index: number) => {
    setDecisions((prev) =>
      prev.map((d, i) =>
        i === index
          ? {
              decision:
                d.decision === "approved"
                  ? ("pending" as const)
                  : ("approved" as const),
              feedback: "",
            }
          : d,
      ),
    );
  }, []);

  const handleReject = useCallback((index: number) => {
    setDecisions((prev) =>
      prev.map((d, i) =>
        i === index
          ? {
              decision:
                d.decision === "rejected"
                  ? ("pending" as const)
                  : ("rejected" as const),
              feedback: d.feedback,
            }
          : d,
      ),
    );
  }, []);

  const handleFeedbackChange = useCallback(
    (index: number, feedback: string) => {
      setDecisions((prev) =>
        prev.map((d, i) => (i === index ? { ...d, feedback } : d)),
      );
    },
    [],
  );

  const handleAcceptAll = useCallback(() => {
    setDecisions((prev) =>
      prev.map((d) => ({ ...d, decision: "approved" as const })),
    );
    onAcceptAll?.();
  }, [onAcceptAll]);

  const handleFixApproved = useCallback(() => {
    onFixApproved?.(
      conflicts.map((c, i) => ({
        file: c.file,
        decision: decisions[i]?.decision ?? "pending",
        feedback: decisions[i]?.feedback ?? "",
      })),
    );
  }, [onFixApproved, conflicts, decisions]);

  const approvedCount = decisions.filter(
    (d) => d.decision === "approved",
  ).length;
  const rejectedCount = decisions.filter(
    (d) => d.decision === "rejected",
  ).length;
  const pendingCount = decisions.filter((d) => d.decision === "pending").length;
  const hasAnyDecision = approvedCount > 0 || rejectedCount > 0;

  return (
    <div className="cr-page">
      {/* ── Page header ── */}
      <div className="cr-page-header">
        <div className="cr-page-header-left">
          <button
            className="btn-icon-only cr-back-btn"
            onClick={onBack}
            data-tooltip="Back"
          >
            <ArrowLeftIcon size={14} />
          </button>
          <div className="cr-page-header-text">
            <h1 className="cr-page-title">Merge Conflicts</h1>
            <span className="cr-page-subtitle">
              {projectName} / {sessionName}
            </span>
          </div>
        </div>
        <div className="cr-page-header-right">
          <span className="cr-branch-chip">{branchName}</span>
        </div>
      </div>

      {/* ── Conflict summary banner ── */}
      <div className="cr-summary-banner">
        <WarningIcon size={16} />
        <div className="cr-summary-text">
          <span className="cr-summary-title">
            {conflicts.length} merge conflict
            {conflicts.length !== 1 ? "s" : ""} found
          </span>
          <span className="cr-summary-desc">
            Main has diverged from <code>{branchName}</code>. Review each
            conflict below, then approve or reject the proposed resolutions.
          </span>
        </div>
        <div className="cr-summary-stats">
          {approvedCount > 0 && (
            <span className="cr-stat cr-stat-approved">
              {approvedCount} approved
            </span>
          )}
          {rejectedCount > 0 && (
            <span className="cr-stat cr-stat-rejected">
              {rejectedCount} rejected
            </span>
          )}
          {pendingCount > 0 && (
            <span className="cr-stat cr-stat-pending">
              {pendingCount} pending
            </span>
          )}
        </div>
      </div>

      {/* ── Conflict list ── */}
      <div className="cr-conflicts-list">
        {conflicts.map((conflict, i) => (
          <ConflictReviewCard
            key={conflict.file}
            conflict={conflict}
            index={i}
            state={decisions[i] ?? { decision: "pending", feedback: "" }}
            onApprove={() => handleApprove(i)}
            onReject={() => handleReject(i)}
            onFeedbackChange={(fb) => handleFeedbackChange(i, fb)}
          />
        ))}
      </div>

      {/* ── Sticky action bar ── */}
      <div className="cr-action-bar">
        <div className="cr-action-bar-inner">
          <button
            className="btn btn-sm cr-accept-all-btn"
            onClick={handleAcceptAll}
          >
            <CheckIcon size={11} /> Accept All and Fix
          </button>
          <div className="cr-action-bar-sep" />
          <button
            className="btn btn-primary btn-sm"
            disabled={!hasAnyDecision}
            onClick={handleFixApproved}
          >
            Fix with Claude
          </button>
        </div>
      </div>
    </div>
  );
}
