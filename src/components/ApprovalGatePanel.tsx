"use client";

import { useRef, useState } from "react";
import {
  MultilineInput,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import {
  DIFF_FILE_HEADER_CLASS,
  DIFF_FILE_NAME_CLASS,
  DIFF_FILE_SECTION_CLASS,
  DIFF_FILE_STAT_CLASS,
  DIFF_LINE_BASE,
  DIFF_LINE_TYPE,
} from "@/components/git/diff-row-classes";
import {
  AlertTriangleIcon,
  CheckIcon,
} from "@/components/workflow-config-panel/icons";
import { Spinner } from "@/components/ui/Spinner";
import type { SessionDiff } from "@/lib/git/schemas";
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
} as const;

const HINT_BASE = "font-mono text-[0.7rem]";

const NOTE_CLASS =
  "m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary";

/** The gate's frozen baseline-relative change set, including self-commits. */
export type ApprovalCandidate =
  | { scope: "owned"; ownedPaths: string[]; diff: SessionDiff }
  | { scope: "whole_tree"; diff: SessionDiff };

export type ApprovalScopedChanges =
  | { status: "loading" }
  | { status: "ready"; candidate: ApprovalCandidate }
  | { status: "drifted" }
  | { status: "unavailable"; reason: string };

interface ApprovalGatePanelProps {
  contextTitle: string | null;
  workflowName: string | null;
  /** The iteration whose candidate is frozen for this gate, when known. */
  iteration?: number | null;
  /** ISO timestamp of when the gate parked; drives the wait-time readout. */
  requestedAt: string;
  isSubmitting: boolean;
  conversationBusy: boolean;
  executionSuspended: boolean;
  scopedChanges?: ApprovalScopedChanges | null;
  voiceProjectName?: string;
  onApprove(): void;
  onReject(message: string): void;
}

function diffSummary(ownedPaths: string[] | null, diff: SessionDiff): string {
  const fileCount = diff.files.length;
  const files = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  const lines = `+${diff.totalAdditions} −${diff.totalDeletions}`;
  const scope =
    ownedPaths === null
      ? "whole lane worktree"
      : ownedPaths.length > 0
        ? `scoped to ${ownedPaths.join(", ")}`
        : "owns no writable path";
  return `${files} · ${lines} · ${scope}`;
}

/**
 * The four candidate states, as one row (E2). Each names what the reviewer is
 * looking at and what it costs them: Approve is a decision ABOUT the frozen
 * artifact, so it is unavailable until the artifact is on screen, while Reject
 * stays available in every state — it is the way out of drift and of a
 * candidate that could not be assembled.
 */
function CandidateState({
  scopedChanges,
}: {
  scopedChanges: ApprovalScopedChanges;
}) {
  const { tone, icon, label, aside, detail } = ((): {
    tone: string;
    icon: React.ReactNode;
    label: string;
    aside: string;
    detail: string | null;
  } => {
    switch (scopedChanges.status) {
      case "loading":
        return {
          tone: "border-border-subtle bg-bg-base text-text-secondary",
          icon: <Spinner size="sm" tone="inherit" />,
          label: "Loading the candidate…",
          aside: "Approve disabled",
          detail: null,
        };
      case "ready":
        return {
          tone: "border-[var(--cc-green-a20)] bg-green-glow text-green",
          icon: <CheckIcon size={12} />,
          label: "Candidate ready",
          aside: diffSummary(
            scopedChanges.candidate.scope === "owned"
              ? scopedChanges.candidate.ownedPaths
              : null,
            scopedChanges.candidate.diff,
          ),
          detail: "Changes since this context began, including committed work.",
        };
      case "drifted":
        return {
          tone: "border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] text-amber",
          icon: <AlertTriangleIcon size={12} />,
          label: "Drifted — the tree moved since the freeze",
          aside: "Approve disabled · Reject available",
          detail:
            "These are no longer the changes this context submitted. Reject to send it back for a fresh review.",
        };
      case "unavailable":
        return {
          tone: "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] text-red",
          icon: <AlertTriangleIcon size={12} />,
          label: "Unavailable — candidate could not be assembled",
          aside: "Reject is the way out",
          detail: `The changes this context owns could not be read (${scopedChanges.reason}). Inspect its worktree directly before deciding.`,
        };
    }
  })();

  return (
    <div
      data-testid="approval-candidate-state"
      data-candidate-status={scopedChanges.status}
      className={cn(
        "flex flex-col gap-[4px] rounded-sm border border-solid px-[10px] py-[7px]",
        tone,
      )}
    >
      <div className="flex flex-wrap items-center gap-sm">
        <span className="flex shrink-0 items-center" aria-hidden="true">
          {icon}
        </span>
        <span className="font-mono text-[0.72rem] font-medium">{label}</span>
        <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
          {aside}
        </span>
      </div>
      {detail !== null && (
        <span className="font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
          {detail}
        </span>
      )}
    </div>
  );
}

/** The frozen bytes themselves, under the state that vouches for them. */
function ScopedChangesSection({
  ownedPaths,
  diff,
}: {
  ownedPaths: string[] | null;
  diff: SessionDiff;
}) {
  return (
    <div
      className="flex flex-col gap-xs rounded-md border border-solid border-border-subtle bg-bg-surface"
      data-testid="approval-gate-scoped-changes"
    >
      {diff.files.length === 0 ? (
        <div className={cn(HINT_BASE, "px-md py-sm text-text-tertiary")}>
          {ownedPaths === null ? (
            "This context produced no file changes since it began."
          ) : (
            <>
              No changes inside the paths this context owns
              {ownedPaths.length > 0 ? ` (${ownedPaths.join(", ")})` : ""}. Work
              by other contexts sharing this worktree is deliberately not shown.
            </>
          )}
        </div>
      ) : (
        <div className="max-h-[320px] overflow-auto py-sm font-mono text-[0.7rem] leading-[1.5]">
          {diff.files.map((file) => (
            <div key={file.filePath} className={DIFF_FILE_SECTION_CLASS}>
              <div className={DIFF_FILE_HEADER_CLASS}>
                <span className={DIFF_FILE_NAME_CLASS}>{file.filePath}</span>
                <span className={cn(DIFF_FILE_STAT_CLASS, "text-green")}>
                  +{file.additions}
                </span>
                <span className={cn(DIFF_FILE_STAT_CLASS, "text-red")}>
                  -{file.deletions}
                </span>
              </div>
              {file.hunks.map((hunk, hunkIndex) => (
                <div key={`${file.filePath}:${hunkIndex}`}>
                  {hunk.lines.map((line, lineIndex) => (
                    <div
                      key={`${file.filePath}:${hunkIndex}:${lineIndex}`}
                      className={cn(DIFF_LINE_BASE, DIFF_LINE_TYPE[line.type])}
                    >
                      {line.content}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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

/**
 * The context approval surface (E2 · README §10).
 *
 * The second of the four approvals, and only the second: this reviews the
 * candidate frozen for one context's gate. Approving lets orchestration
 * continue — it is neither the lane join nor publication — and rejecting
 * returns the work to the implementer, which is why feedback is required and
 * the field stands open rather than hiding behind the decision.
 */
export default function ApprovalGatePanel({
  contextTitle,
  workflowName,
  iteration = null,
  requestedAt,
  isSubmitting,
  conversationBusy,
  executionSuspended,
  scopedChanges = null,
  voiceProjectName,
  onApprove,
  onReject,
}: ApprovalGatePanelProps) {
  const [message, setMessage] = useState("");
  const [rejectVoiceBusy, setRejectVoiceBusy] = useState(false);
  const rejectActionRef = useRef<MultilineInputActionHandle | null>(null);

  const actionsDisabled = isSubmitting || conversationBusy;
  // Approve is a decision ABOUT the frozen candidate, so it needs one. A host
  // that resolved no candidate state at all is not a fifth, permissive state —
  // it is an unanswered question, and answering it "approve" blind is the thing
  // this row exists to prevent.
  const approveDisabled =
    actionsDisabled ||
    scopedChanges === null ||
    scopedChanges.status !== "ready";
  const trimmedMessage = message.trim();
  const needsFeedback = trimmedMessage === "" && !rejectVoiceBusy;
  const waitLabel = formatWaitTime(requestedAt);

  const busyHint = conversationBusy
    ? "Chat turn in progress — actions re-enable when it completes."
    : isSubmitting
      ? "Submitting decision…"
      : null;

  const submitReject = (nextMessage = message) => {
    const trimmed = nextMessage.trim();
    if (actionsDisabled || trimmed === "") return;
    onReject(trimmed);
  };

  const handleRejectKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (isSubmitting) return;
      setMessage("");
    }
  };

  const meta = [
    iteration === null ? null : `iteration ${iteration}`,
    workflowName,
    waitLabel,
  ].filter((part): part is string => part !== null && part !== "");

  return (
    <div
      className="shrink-0 border-x-0 border-t border-b-0 border-solid border-t-border-subtle bg-bg-base px-lg py-md"
      data-testid="approval-gate-panel"
    >
      <section
        aria-label="Context approval"
        className="flex flex-col overflow-hidden rounded-md border border-solid border-[var(--cc-amber-a30)] bg-bg-base"
      >
        <header className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-[var(--cc-amber-a10)] px-3 py-[9px]">
          <span className="font-mono text-[0.74rem] font-semibold text-amber">
            {contextTitle
              ? `Context approval — ${contextTitle}`
              : "Context approval"}
          </span>
          {meta.length > 0 && (
            <span className="ml-auto flex items-baseline gap-sm font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
              {meta.map((part) => (
                <span key={part}>{part}</span>
              ))}
            </span>
          )}
        </header>

        <div className="flex flex-col gap-[10px] px-3 py-[11px]">
          {scopedChanges !== null && (
            <CandidateState scopedChanges={scopedChanges} />
          )}

          <p className={NOTE_CLASS}>
            You are reviewing the candidate{" "}
            <span className="text-text-primary">frozen for this gate</span>.
            Approving lets orchestration continue; it does not land the lane or
            publish it.
          </p>

          {scopedChanges?.status === "ready" && (
            <ScopedChangesSection
              ownedPaths={
                scopedChanges.candidate.scope === "owned"
                  ? scopedChanges.candidate.ownedPaths
                  : null
              }
              diff={scopedChanges.candidate.diff}
            />
          )}

          {busyHint && (
            <div className={cn(HINT_BASE, "text-text-tertiary")}>
              {busyHint}
            </div>
          )}
          {executionSuspended && (
            <div className={cn(HINT_BASE, "text-amber-dim")}>
              Execution suspended — the decision applies when the workflow
              resumes.
            </div>
          )}

          <label className="flex flex-col gap-[5px]">
            <span className="font-mono text-[0.7rem] font-medium tracking-[0.06em] text-text-tertiary uppercase">
              Rejection feedback
            </span>
            <MultilineInput
              className="w-full resize-y rounded-sm border border-solid border-border-default bg-bg-surface px-md py-sm font-mono text-[0.72rem] leading-[1.5] text-text-primary transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary focus:border-red-dim focus:shadow-[0_0_0_2px_var(--red-glow)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Rejection feedback"
              placeholder="Required to reject — returned to the implementer"
              value={message}
              onValueChange={setMessage}
              onKeyDown={handleRejectKeyDown}
              onPrimaryAction={submitReject}
              actionRef={rejectActionRef}
              onVoiceStateChange={setRejectVoiceBusy}
              voiceProjectName={voiceProjectName}
              disabled={actionsDisabled}
              rows={2}
            />
          </label>

          <div className="flex flex-wrap items-center gap-sm">
            <button
              type="button"
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.primary)}
              disabled={approveDisabled}
              onClick={onApprove}
            >
              Approve
            </button>
            <button
              type="button"
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.danger)}
              disabled={actionsDisabled || needsFeedback}
              onClick={() => rejectActionRef.current?.primaryAction()}
            >
              {needsFeedback ? "Reject — needs feedback" : "Reject"}
            </button>
            <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
              rejection reruns validators
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-sm">
            <span className="font-mono text-[0.7rem] text-text-tertiary">
              Sibling contexts keep running — nothing here pauses the run.
            </span>
            <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
              ⌘↵ reject · esc clear
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
