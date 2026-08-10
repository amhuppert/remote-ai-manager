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
  ghost:
    "bg-transparent border-transparent font-medium text-text-secondary hover:bg-bg-hover hover:border-border-default hover:text-cyan",
} as const;

const HINT_BASE = "font-mono text-[0.7rem]";

/**
 * The change set an ENVELOPED context's reviewer decides on (R15.2): the
 * ownership-scoped snapshot its gate froze, resolved through the approval API.
 *
 * A union rather than a nullable diff because the three non-ready states are
 * things the reviewer has to be told, not absences to render as "no changes":
 * `drifted` means the owned paths moved after the gate opened, so these are no
 * longer the bytes the gate froze, and `unavailable` means the artifact could
 * not be read at all. Neither ever falls back to the whole-worktree delta — in a
 * shared lane that delta is partly a concurrent sibling's in-progress work.
 *
 * Null on the props for a full-access member, which keeps the whole-tree
 * approval view the session's own diff surface already provides.
 */
export type ApprovalScopedChanges =
  | { status: "loading" }
  | { status: "ready"; ownedPaths: string[]; diff: SessionDiff }
  | { status: "drifted" }
  | { status: "unavailable"; reason: string };

interface ApprovalGatePanelProps {
  contextTitle: string | null;
  workflowName: string | null;
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

function ScopedChangesSection({
  scopedChanges,
}: {
  scopedChanges: ApprovalScopedChanges;
}) {
  return (
    <div
      className="flex flex-col gap-xs rounded-md border border-solid border-border-subtle bg-bg-surface"
      data-testid="approval-gate-scoped-changes"
    >
      {scopedChanges.status === "ready" && (
        <>
          <div className="flex flex-wrap items-baseline gap-sm px-md pt-sm font-mono text-[0.68rem] text-text-tertiary">
            <span className="text-text-secondary">Changes under review</span>
            <span>
              +{scopedChanges.diff.totalAdditions} −
              {scopedChanges.diff.totalDeletions}
            </span>
            <span>
              {scopedChanges.ownedPaths.length > 0
                ? `owned: ${scopedChanges.ownedPaths.join(", ")}`
                : "owns no writable path"}
            </span>
          </div>
          {scopedChanges.diff.files.length === 0 ? (
            <div className={cn(HINT_BASE, "px-md pb-sm text-text-tertiary")}>
              No changes inside the paths this context owns. Work by other
              contexts sharing this worktree is deliberately not shown.
            </div>
          ) : (
            <div className="max-h-[320px] overflow-auto pb-sm font-mono text-[0.7rem] leading-[1.5]">
              {scopedChanges.diff.files.map((file) => (
                <div key={file.filePath} className={DIFF_FILE_SECTION_CLASS}>
                  <div className={DIFF_FILE_HEADER_CLASS}>
                    <span className={DIFF_FILE_NAME_CLASS}>
                      {file.filePath}
                    </span>
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
                          className={cn(
                            DIFF_LINE_BASE,
                            DIFF_LINE_TYPE[line.type],
                          )}
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
        </>
      )}
      {scopedChanges.status === "loading" && (
        <div className={cn(HINT_BASE, "px-md py-sm text-text-tertiary")}>
          Loading the changes this context owns…
        </div>
      )}
      {scopedChanges.status === "drifted" && (
        <div className={cn(HINT_BASE, "px-md py-sm text-amber-dim")}>
          The files this context owns have changed since it entered review, so
          these are no longer the changes it submitted. Reject to send it back
          for a fresh review.
        </div>
      )}
      {scopedChanges.status === "unavailable" && (
        <div className={cn(HINT_BASE, "px-md py-sm text-text-tertiary")}>
          The changes this context owns could not be read (
          {scopedChanges.reason}). Inspect its worktree directly before
          deciding.
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

export default function ApprovalGatePanel({
  contextTitle,
  workflowName,
  requestedAt,
  isSubmitting,
  conversationBusy,
  executionSuspended,
  scopedChanges = null,
  voiceProjectName,
  onApprove,
  onReject,
}: ApprovalGatePanelProps) {
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState("");
  const [rejectVoiceBusy, setRejectVoiceBusy] = useState(false);
  const rejectActionRef = useRef<MultilineInputActionHandle | null>(null);

  const actionsDisabled = isSubmitting || conversationBusy;
  // Approving is a decision ABOUT the frozen artifact, so it stays unavailable
  // until that artifact is on screen: loading, drift, and an unreadable
  // candidate all mean the reviewer cannot see what they would be approving.
  // Rejecting is never blocked — it is the documented way out of drift.
  const approveDisabled =
    actionsDisabled ||
    (scopedChanges !== null && scopedChanges.status !== "ready");
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

  const submitReject = (nextMessage = message) => {
    const trimmed = nextMessage.trim();
    if (actionsDisabled || trimmed === "") return;
    onReject(trimmed);
  };

  const handleRejectKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
              disabled={approveDisabled}
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
      {scopedChanges !== null && (
        <ScopedChangesSection scopedChanges={scopedChanges} />
      )}

      {rejecting && (
        <div className="flex flex-col gap-sm">
          <MultilineInput
            className="w-full resize-y rounded-md border border-solid border-border-default bg-bg-surface px-md py-sm font-mono text-[0.78rem] leading-[1.5] text-text-primary transition-[border-color,box-shadow] duration-150 ease-[ease] placeholder:text-text-tertiary focus:border-red-dim focus:shadow-[0_0_0_2px_var(--red-glow)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Rejection feedback"
            placeholder="Explain what needs to change..."
            value={message}
            onValueChange={setMessage}
            onKeyDown={handleRejectKeyDown}
            onPrimaryAction={submitReject}
            actionRef={rejectActionRef}
            onVoiceStateChange={setRejectVoiceBusy}
            voiceProjectName={voiceProjectName}
            disabled={actionsDisabled}
            autoFocus
            rows={3}
          />
          <div className="flex shrink-0 items-center gap-sm">
            <button
              className={cn(ACTION_BTN_BASE, ACTION_BTN_VARIANT.danger)}
              disabled={
                actionsDisabled || (trimmedMessage === "" && !rejectVoiceBusy)
              }
              onClick={() => rejectActionRef.current?.primaryAction()}
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
