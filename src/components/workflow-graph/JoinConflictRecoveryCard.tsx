"use client";

import { useRef, useState } from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import type { ConflictDecisionInput, ConflictEntry } from "@/lib/jobs/schemas";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/ui/cn";
import type { JoinConflictSummary } from "./join-conflict-summary";

/**
 * The join-conflict recovery card (E2).
 *
 * A join is a runtime state with its own recovery, not an approval: the card
 * names the lane being merged into, which members already landed, which one is
 * blocked and why, and offers the three ways out — retry the merge (optionally
 * with per-file guidance for the resolver), open the blocked member's lane
 * worktree, or narrow its owned paths.
 */

const ACTION_BTN =
  "inline-flex h-[24px] cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-solid px-[10px] py-[3px] font-mono text-[0.7rem] font-medium whitespace-nowrap transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:h-[44px] max-768:px-md";
const ACTION_BTN_PRIMARY =
  "border-[var(--cyan-glow-strong)] bg-[var(--cc-cyan-a12)] text-cyan hover:bg-[var(--cc-cyan-a20)]";
const ACTION_BTN_SECONDARY =
  "border-border-default bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary";

const MEMBER_TONE: Record<
  JoinConflictSummary["members"][number]["status"],
  string
> = {
  merged: "text-text-tertiary",
  blocked: "text-red",
  pending: "text-text-tertiary",
};

export interface JoinConflictRecoveryCardProps {
  conflictFiles: string[];
  /** Per-file analysis persisted from the failed resolution attempt. */
  analysis: ConflictEntry[] | null;
  /**
   * The join as the operator sees it — target lane, join id, per-member merge
   * outcome. Omitted by a host that has no execution to derive it from, in
   * which case the card stays the retry form alone.
   */
  summary?: JoinConflictSummary | null;
  /** Retry the join merge; guidance entries exist only for files the operator
   *  annotated. An empty array retries without guidance. */
  onRetry(guidance: ConflictDecisionInput[]): void;
  /** Opens the blocked member's runtime — its lane worktree and branch. */
  onOpenLaneWorktree?(contextId: string): void;
  /** Opens the blocked member's placement, where its owned paths are edited. */
  onEditOwnership?(contextId: string): void;
  isRetrying: boolean;
  disabled: boolean;
  /**
   * Why the retry cannot be taken yet, when something other than this join
   * withholds it — a concurrent unrepaired output-schema contract is the case
   * today. Only the retry is withheld: naming the members, the conflicting file
   * and reaching the blocked lane are reads, and a card that vanished with the
   * resume would leave the failure unexplained and the lane unreachable.
   */
  retryBlockedReason?: string | null;
}

export default function JoinConflictRecoveryCard({
  conflictFiles,
  analysis,
  summary = null,
  onRetry,
  onOpenLaneWorktree,
  onEditOwnership,
  isRetrying,
  disabled,
  retryBlockedReason = null,
}: JoinConflictRecoveryCardProps) {
  const [feedbackByFile, setFeedbackByFile] = useState<Record<string, string>>(
    {},
  );
  const feedbackActionRefs = useRef<
    Map<string, MultilineInputActionHandle | null>
  >(new Map());

  const analysisByFile = new Map(
    (analysis ?? []).map((entry) => [entry.file, entry]),
  );

  const retryWithheld = disabled || retryBlockedReason !== null;

  const handleRetry = (feedbackOverride?: { file: string; value: string }) => {
    // The guard belongs on the ACT, not on the button: the guidance inputs'
    // primary action (⌘/ctrl↵, and the voice control's submit) lands here too,
    // and a retry is what resumes the run — so guarding the button alone would
    // leave the keyboard a way to resume an unrepaired output-schema contract.
    if (retryWithheld) return;
    const guidance: ConflictDecisionInput[] = conflictFiles
      .map((file) => ({
        file,
        feedback:
          feedbackOverride?.file === file
            ? feedbackOverride.value.trim()
            : (feedbackByFile[file] ?? "").trim(),
      }))
      .filter((entry) => entry.feedback.length > 0)
      .map((entry) => ({
        file: entry.file,
        decision: "rejected" as const,
        feedback: entry.feedback,
      }));
    onRetry(guidance);
  };

  const blockedMember = summary?.blockedMember ?? null;
  const blockedContextId = blockedMember?.contextId ?? null;

  return (
    <div className="mt-[6px] flex basis-full flex-col overflow-hidden rounded-sm border border-solid border-[var(--cc-red-a25)] bg-bg-base">
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-[var(--cc-red-a10)] px-md py-[9px]">
        <span className="font-mono text-[0.74rem] font-semibold text-red">
          {summary ? `Join conflict — ${summary.laneLabel}` : "Join conflict"}
        </span>
        {summary && (
          <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
            {summary.joinId}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-[9px] px-md py-sm text-[0.74rem] leading-[1.45] text-text-secondary">
        {summary && (
          <>
            <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
              {summary.mergedCount} of {summary.members.length}{" "}
              {summary.members.length === 1 ? "member" : "members"} merged.
              {blockedMember !== null && (
                <>
                  {" "}
                  <span className="text-text-primary">
                    {blockedMember.title}
                  </span>{" "}
                  is blocked
                  {conflictFiles.length > 0 && (
                    <>
                      {" "}
                      in{" "}
                      <span className="text-text-primary">
                        {conflictFiles.join(", ")}
                      </span>
                    </>
                  )}
                  {blockedMember.detail === null
                    ? "."
                    : ` — ${blockedMember.detail}`}
                </>
              )}
            </p>
            <div
              data-testid="join-members"
              className="flex flex-col gap-[4px] font-mono text-[0.7rem] leading-[1.6]"
            >
              {summary.members.map((member) => (
                <span
                  key={`${member.laneId}:${member.contextId ?? ""}`}
                  className={MEMBER_TONE[member.status]}
                >
                  {member.status} · {member.title} → {summary.laneLabel}
                  {member.detail === null ? "" : ` — ${member.detail}`}
                </span>
              ))}
            </div>
          </>
        )}

        <ul className="m-0 flex list-none flex-col gap-[8px] p-0">
          {conflictFiles.map((file) => {
            const entry = analysisByFile.get(file);
            return (
              <li key={file} className="flex flex-col gap-[4px]">
                <span className="font-mono text-[0.7rem] text-amber">
                  {file}
                </span>
                {entry && (
                  <div className="text-[0.72rem] text-text-secondary">
                    <p className="m-0">{entry.description}</p>
                    <p className="m-0 text-text-tertiary">
                      Attempted: {entry.resolution} — {entry.rationale}
                    </p>
                  </div>
                )}
                <MultilineInput
                  aria-label={`Guidance for ${file}`}
                  className="min-h-[32px] w-full resize-y rounded-sm border border-border-default bg-bg-surface p-[6px] font-[inherit] text-[0.72rem] text-text-primary placeholder:text-text-tertiary"
                  placeholder="Optional guidance for the resolver (e.g. which side wins, how to combine)"
                  value={feedbackByFile[file] ?? ""}
                  onValueChange={(value) =>
                    setFeedbackByFile((prev) => ({
                      ...prev,
                      [file]: value,
                    }))
                  }
                  onPrimaryAction={(value) => handleRetry({ file, value })}
                  actionRef={(handle) => {
                    if (handle) feedbackActionRefs.current.set(file, handle);
                    else feedbackActionRefs.current.delete(file);
                  }}
                  disabled={disabled}
                />
              </li>
            );
          })}
        </ul>

        <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          Resolve in the lane worktree, or narrow one member&apos;s owned paths
          so the two no longer overlap, then retry the join.
        </p>

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="button"
            className={cn(ACTION_BTN, ACTION_BTN_PRIMARY)}
            onClick={() =>
              runMultilinePrimaryAction(
                feedbackActionRefs.current.values(),
                handleRetry,
              )
            }
            disabled={retryWithheld}
            aria-busy={isRetrying || undefined}
          >
            {isRetrying ? (
              <>
                <Spinner size="sm" tone="inherit" />
                Retrying…
              </>
            ) : retryBlockedReason !== null ? (
              `Retry join — ${retryBlockedReason}`
            ) : (
              "Retry join"
            )}
          </button>
          {blockedContextId !== null && onOpenLaneWorktree !== undefined && (
            <button
              type="button"
              className={cn(ACTION_BTN, ACTION_BTN_SECONDARY)}
              onClick={() => onOpenLaneWorktree(blockedContextId)}
            >
              Open lane worktree
            </button>
          )}
          {blockedContextId !== null && onEditOwnership !== undefined && (
            <button
              type="button"
              className={cn(ACTION_BTN, ACTION_BTN_SECONDARY)}
              onClick={() => onEditOwnership(blockedContextId)}
            >
              Edit ownership
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
