"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";

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
  targetBranch?: string;
  conflicts: ConflictEntry[];
  error?: string | null;
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

// ── Static appearance recipes ──────────────────────────────────

// The summary-stat chip (`.cr-stat`); each tone appends its colour.
const STAT_BASE =
  "font-mono text-[0.7rem] font-semibold uppercase tracking-[0.04em] px-[8px] py-[2px] rounded-[100px]";

// Approve/reject action button (`.cr-action-btn`). Resting/hover/active
// appearance is gated by `data-active` (active beats hover via mutually
// exclusive `data-[active=…]` selectors, not source order). The active border
// colours (green/red at 0.4 alpha) have no solid-colour token, so they are
// derived from the base `--green`/`--red` tokens via `color-mix` (token-backed,
// no raw literal — passes `no-hardcoded-color`; `--green`/`--red` are opaque so
// the mix with `transparent` reproduces the legacy 0.4-alpha rgba exactly).
const ACTION_BTN_BASE =
  "w-[28px] h-[28px] flex items-center justify-center border border-solid rounded-sm cursor-pointer transition-all duration-150 ease-[ease] " +
  "max-768:w-[44px] max-768:h-[44px] " +
  "data-[active=false]:bg-transparent data-[active=false]:text-text-tertiary data-[active=false]:border-border-default " +
  "data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary data-[active=false]:hover:border-border-strong";

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
      data-decision={state.decision}
      className={cn(
        "group overflow-hidden rounded-md border border-solid bg-bg-surface transition-[border-color] duration-150 ease-[ease]",
        "data-[decision=pending]:border-border-subtle",
        "data-[decision=approved]:border-[var(--cc-green-border)]",
        "data-[decision=rejected]:border-[var(--cc-red-border)]",
      )}
    >
      <div className="flex items-center px-md py-sm">
        <button
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-sm border-0 bg-transparent px-0 py-xs font-mono text-[0.78rem] text-text-primary max-768:text-[0.72rem]"
          onClick={() => setExpanded(!expanded)}
        >
          <span
            className={cn(
              "shrink-0 text-[0.72rem] text-text-tertiary transition-transform duration-150 ease-[ease]",
              expanded && "rotate-90",
            )}
          >
            ▸
          </span>
          <span
            className={cn(
              "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold",
              "group-data-[decision=pending]:bg-amber-glow group-data-[decision=pending]:text-amber",
              "group-data-[decision=approved]:bg-green-glow group-data-[decision=approved]:text-green",
              "group-data-[decision=rejected]:bg-red-glow group-data-[decision=rejected]:text-red",
            )}
          >
            {index + 1}
          </span>
          <span className="flex-1 overflow-hidden text-left text-ellipsis whitespace-nowrap">
            {conflict.file}
          </span>
        </button>
        <div className="ml-sm flex shrink-0 gap-[4px]">
          <button
            data-active={state.decision === "approved"}
            className={cn(
              ACTION_BTN_BASE,
              "data-[active=true]:border-[color:color-mix(in_srgb,var(--green)_40%,transparent)] data-[active=true]:bg-green-glow data-[active=true]:text-green",
            )}
            onClick={handleApprove}
            title="Approve this resolution"
          >
            <CheckIcon size={11} />
          </button>
          <button
            data-active={state.decision === "rejected"}
            className={cn(
              ACTION_BTN_BASE,
              "data-[active=true]:border-[color:color-mix(in_srgb,var(--red)_40%,transparent)] data-[active=true]:bg-red-glow data-[active=true]:text-red",
            )}
            onClick={handleReject}
            title="Reject this resolution"
          >
            <XIcon size={11} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="flex flex-col gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle px-lg py-md max-768:px-md max-768:py-sm">
          <div className="flex flex-col gap-[4px]">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-cyan-dim uppercase">
              Conflict
            </span>
            <p className="font-mono text-[0.75rem] leading-[1.6] text-text-secondary">
              {conflict.description}
            </p>
          </div>
          <div className="flex flex-col gap-[4px]">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-cyan-dim uppercase">
              Proposed Resolution
            </span>
            <p className="font-mono text-[0.75rem] leading-[1.6] text-text-secondary">
              {conflict.resolution}
            </p>
          </div>
          <div className="flex flex-col gap-[4px]">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-cyan-dim uppercase">
              Rationale
            </span>
            <p className="font-mono text-[0.75rem] leading-[1.6] text-text-secondary">
              {conflict.rationale}
            </p>
          </div>

          {state.decision === "rejected" && (
            <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm">
              <label className="mb-xs block font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-red uppercase">
                Guidance for Claude
              </label>
              <textarea
                // `.form-input` (globals.css:7991) loads after dialogs.css's
                // `@import`, so at equal specificity its `font-size:0.82rem`
                // overrides `.cr-feedback-input{font-size:0.75rem}` — the
                // override was dead. 0.82rem is the effective recipe.
                className="w-full rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] font-mono text-[0.82rem] text-text-primary outline-0 transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]"
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
  targetBranch = "main",
  conflicts,
  error = null,
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

  if (error) {
    return (
      <div className="flex h-dvh flex-col overflow-clip">
        <main className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto p-lg">
          <EmptyState>
            <EmptyStateTitle>{error}</EmptyStateTitle>
            <Button size="sm" touch onClick={onBack}>
              Back to session
            </Button>
          </EmptyState>
        </main>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-var(--topbar-height))] max-w-[800px] flex-col gap-md px-lg pt-lg pb-[80px] max-768:px-md max-768:pt-md">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between gap-md max-768:flex-col max-768:items-start">
        <div className="flex items-center gap-md">
          <IconButton variant="square" onClick={onBack} data-tooltip="Back">
            <ArrowLeftIcon size={14} />
          </IconButton>
          <div className="flex flex-col gap-[2px]">
            <h1 className="font-display text-[1.2rem] leading-[1.2] font-bold text-text-primary max-768:text-[1rem]">
              Merge Conflicts
            </h1>
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              {projectName} / {sessionName}
            </span>
          </div>
        </div>
        <div className="shrink-0">
          <span className="inline-block rounded-[100px] border border-solid border-border-subtle bg-bg-raised px-[10px] py-[3px] font-mono text-[0.72rem] text-text-secondary">
            {branchName}
          </span>
        </div>
      </div>

      {/* ── Conflict summary banner ── */}
      <div className="flex items-start gap-md rounded-md border border-solid border-[color:color-mix(in_srgb,var(--amber)_20%,transparent)] bg-amber-glow px-lg py-md text-amber max-768:flex-col max-768:gap-sm max-768:px-md">
        <WarningIcon size={16} />
        <div className="flex flex-1 flex-col gap-[4px]">
          <span className="font-mono text-[0.78rem] font-semibold">
            {conflicts.length} merge conflict
            {conflicts.length !== 1 ? "s" : ""} found
          </span>
          <span className="font-mono text-[0.72rem] leading-[1.5] text-text-secondary">
            {targetBranch} has diverged from{" "}
            <code className="rounded-[3px] bg-bg-raised px-[5px] py-[1px] text-[0.7rem] text-cyan">
              {branchName}
            </code>
            . Review each conflict below, then approve or reject the proposed
            resolutions.
          </span>
        </div>
        <div className="flex shrink-0 gap-sm self-center max-768:self-start">
          {approvedCount > 0 && (
            <span className={cn(STAT_BASE, "bg-green-glow text-green")}>
              {approvedCount} approved
            </span>
          )}
          {rejectedCount > 0 && (
            <span className={cn(STAT_BASE, "bg-red-glow text-red")}>
              {rejectedCount} rejected
            </span>
          )}
          {pendingCount > 0 && (
            <span
              className={cn(
                STAT_BASE,
                "border border-solid border-border-default bg-bg-hover text-text-secondary",
              )}
            >
              {pendingCount} pending
            </span>
          )}
        </div>
      </div>

      {/* ── Conflict list ── */}
      <div className="flex flex-col gap-sm">
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

      {/* ── Sticky action bar (preserved overlay residual: fixed positioning
          + backdrop-filter; `.cr-*` per docs/reports/css-inventory.md) ── */}
      <div className="cr-action-bar">
        <div className="cr-action-bar-inner">
          <Button size="sm" touch onClick={handleAcceptAll}>
            <CheckIcon size={11} /> Accept All and Fix
          </Button>
          <div className="h-[20px] w-px bg-border-subtle" />
          <Button
            variant="primary"
            size="sm"
            touch
            disabled={!hasAnyDecision}
            onClick={handleFixApproved}
          >
            Fix with Claude
          </Button>
        </div>
      </div>
    </div>
  );
}
