"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/Dialog";
import { IconButton } from "@/components/ui/IconButton";
import { CloseIcon } from "@/components/icons";
import Link from "next/link";
import { formatGraphWorkflowHaltReason } from "@/components/workflow-graph/ContextHaltCard";
import {
  outputSchemaEvidenceForReason,
  type OutputSchemaHaltEvidenceByContext,
} from "@/components/workflow-graph/derive-output-schema-halt";
import {
  planRepairStatement,
  PLAN_REPAIR_OUTCOME_LABEL,
  type PlanRepairActivity,
} from "@/components/workflow-graph/derive-plan-repair-activity";
import JoinConflictRecoveryCard from "@/components/workflow-graph/JoinConflictRecoveryCard";
import type { JoinConflictSummary } from "@/components/workflow-graph/join-conflict-summary";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import type { ConflictDecisionInput, ConflictEntry } from "@/lib/jobs/schemas";
import { cn } from "@/lib/ui/cn";

// Full read view for an execution halt. The status bar shows only a one-line
// summary (so a long failure can never grow the bar); everything else — the
// raw failure output, per-file conflict lists, the join-conflict recovery
// form, and secondary failures — lives here behind "Details".

export interface HaltDetailsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  primary: GraphWorkflowHaltReason;
  secondary?: GraphWorkflowHaltReason[];
  /** Per-file analysis persisted from a failed join resolution attempt. */
  conflictAnalysis: ConflictEntry[] | null;
  /** Whether the execution is in a resumable status (halted/paused). */
  canResume: boolean;
  /**
   * Why a resume this status would otherwise offer cannot be taken yet — the
   * page's one answer, so this view cannot contradict the bar beside it. The
   * resuming acts (Resume, Retry join) render disabled and say why; everything
   * else in the view is a read or a navigation and stays available, because a
   * halt the operator cannot resume is precisely the one they need to read.
   */
  resumeBlockedReason?: string | null;
  onResume(conflictGuidance?: ConflictDecisionInput[]): void;
  isMutating: boolean;
  isResuming: boolean;
  /**
   * Output-schema evidence keyed by context, covering the primary reason AND
   * every secondary one — a second context can refuse its contract in the same
   * halt, and this is the full read view, so it must not degrade that failure
   * to a paths-less headline.
   */
  outputSchemaEvidence?: OutputSchemaHaltEvidenceByContext | null;
  /**
   * Opens the halted context's Config tab, where the refusing `outputSchema`
   * is edited. Omitted by a host that cannot navigate there, in which case the
   * action is not offered rather than offered dead.
   */
  onEditSchema?(contextId: string): void;
  /** The failed join as the operator sees it — lane, members, merge outcomes. */
  joinConflict?: JoinConflictSummary | null;
  /** Opens the blocked member's runtime (its lane worktree and branch). */
  onOpenLaneWorktree?(contextId: string): void;
  /** Opens the blocked member's placement, where its owned paths are edited. */
  onEditOwnership?(contextId: string): void;
  /**
   * Whether a repair agent is on this halt, and what earlier rounds decided.
   * The read view is where the diagnoses live: a declined round is the operator
   * asking "has anything looked at this?" and getting an answer instead of a
   * silent halt.
   */
  planRepairActivity?: PlanRepairActivity | null;
  /**
   * Opens the open round's transcript. The claim that an agent is working is
   * only worth as much as the operator's ability to check it — this is the
   * check. Omitted by a host with no transcript surface, in which case the
   * action is not offered rather than offered dead.
   */
  onViewRepairConversation?(conversationId: string, contextId: string): void;
}

function PlanRepairActivitySection({
  activity,
  onViewRepairConversation,
}: {
  activity: PlanRepairActivity;
  onViewRepairConversation:
    | ((conversationId: string, contextId: string) => void)
    | undefined;
}): React.JSX.Element {
  const statement = planRepairStatement(activity);
  const openRound = activity.openRound;
  const watchable =
    openRound !== null &&
    openRound.conversationId !== null &&
    onViewRepairConversation !== undefined
      ? {
          conversationId: openRound.conversationId,
          contextId: openRound.contextId,
        }
      : null;
  return (
    <section
      data-testid="halt-repair-activity"
      className={cn(
        "flex flex-col gap-xs rounded-sm border border-solid px-md py-sm",
        statement.working
          ? "border-[var(--cc-cyan-a25)] bg-[var(--cc-cyan-a08)]"
          : "border-border-dim bg-bg-raised",
      )}
    >
      <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Plan repair
      </span>
      <p
        className={cn(
          "m-0 text-[0.74rem] leading-[1.5]",
          statement.working ? "text-cyan" : "text-text-secondary",
        )}
      >
        {statement.sentence}
      </p>
      {statement.working && (
        // The one consequence of acting during a repair turn: the round
        // withdraws as `superseded` and its diagnosis is never written.
        <p className="m-0 text-[0.72rem] text-text-tertiary italic">
          Resuming or aborting now supersedes the open round — its diagnosis is
          discarded.
        </p>
      )}
      {watchable !== null && (
        <DialogClose asChild>
          <Button
            size="sm"
            touch
            layoutClassName="w-fit"
            onClick={() =>
              onViewRepairConversation?.(
                watchable.conversationId,
                watchable.contextId,
              )
            }
          >
            Watch the repair agent
          </Button>
        </DialogClose>
      )}
      <ul className="m-0 flex list-none flex-col gap-[2px] p-0 font-mono text-[0.7rem] text-text-secondary">
        {activity.rounds.map((round) => (
          <li key={round.seq}>
            <span className="mr-[6px] text-amber">round {round.seq}</span>
            {round.outcome === null
              ? "in flight"
              : PLAN_REPAIR_OUTCOME_LABEL[round.outcome]}
            {round.diagnosis === null ? "" : ` — ${round.diagnosis}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HaltDetailsDialog({
  open,
  onOpenChange,
  primary,
  secondary = [],
  conflictAnalysis,
  canResume,
  resumeBlockedReason = null,
  onResume,
  isMutating,
  isResuming,
  outputSchemaEvidence,
  onEditSchema,
  joinConflict = null,
  onOpenLaneWorktree,
  onEditOwnership,
  planRepairActivity = null,
  onViewRepairConversation,
}: HaltDetailsDialogProps): React.JSX.Element {
  const hasConflictRecovery =
    canResume &&
    primary.type === "join_failure" &&
    primary.conflictFiles.length > 0;
  // The recovery form below is the canonical conflict-file presentation here;
  // omit the formatter's plain list so each file appears once.
  // This is the full read view, so it is the surface that asks the formatter to
  // expand an output-schema trip into payload + contract + budget chips.
  const primaryEvidence = outputSchemaEvidenceForReason(
    outputSchemaEvidence,
    primary,
  );
  const formatted = formatGraphWorkflowHaltReason(primary, {
    omitConflictFiles: hasConflictRecovery,
    ...(primaryEvidence !== undefined
      ? {
          outputSchemaEvidence: primaryEvidence,
          expandOutputSchemaEvidence: true,
        }
      : {}),
  });
  const editSchemaContextId =
    primaryEvidence !== undefined && onEditSchema !== undefined
      ? primaryEvidence.contextId
      : null;
  // "attention" = the run waits on a human act (delivery approval); the read
  // view keeps its structure but must not present the wait as a failure.
  const attention = formatted.tone === "attention";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" aria-describedby={undefined}>
        <header className="mb-xs flex items-center gap-[10px]">
          <span
            className={cn(
              "min-w-0 flex-1 font-mono text-[0.7rem] font-semibold tracking-[0.08em] uppercase",
              attention ? "text-amber" : "text-red",
            )}
            data-tone={attention ? "attention" : "blocked"}
          >
            Execution halted
          </span>
          <Badge subtle layoutClassName="shrink-0">
            {primary.type}
          </Badge>
          <DialogClose asChild>
            <IconButton aria-label="Close">
              <CloseIcon />
            </IconButton>
          </DialogClose>
        </header>
        <DialogTitle layoutClassName="min-w-0">
          {formatted.headline}
        </DialogTitle>
        <div className="flex max-h-[60vh] min-h-0 flex-col gap-md overflow-y-auto">
          {/* Above the evidence: whether anything is acting on this halt is
              the first question the read view has to answer. */}
          {planRepairActivity !== null &&
            planRepairActivity.rounds.length > 0 && (
              <PlanRepairActivitySection
                activity={planRepairActivity}
                onViewRepairConversation={onViewRepairConversation}
              />
            )}
          {formatted.detail && (
            <div className="text-[0.74rem] leading-[1.5] text-text-secondary [&_p]:m-0">
              {formatted.detail}
            </div>
          )}
          {formatted.action && (
            <div className="text-[0.74rem] text-text-tertiary italic">
              {formatted.action}
            </div>
          )}
          {formatted.actionHref && (
            <Link
              href={formatted.actionHref}
              className="w-fit text-[0.74rem] font-semibold text-cyan hover:underline max-768:inline-flex max-768:min-h-[44px] max-768:items-center"
            >
              Open the merge gate →
            </Link>
          )}
          {hasConflictRecovery && (
            <JoinConflictRecoveryCard
              conflictFiles={primary.conflictFiles}
              analysis={conflictAnalysis}
              summary={joinConflict}
              onRetry={(guidance) =>
                onResume(guidance.length > 0 ? guidance : undefined)
              }
              {...(onOpenLaneWorktree !== undefined
                ? {
                    onOpenLaneWorktree: (contextId: string) => {
                      onOpenChange(false);
                      onOpenLaneWorktree(contextId);
                    },
                  }
                : {})}
              {...(onEditOwnership !== undefined
                ? {
                    onEditOwnership: (contextId: string) => {
                      onOpenChange(false);
                      onEditOwnership(contextId);
                    },
                  }
                : {})}
              isRetrying={isResuming}
              disabled={isMutating}
              retryBlockedReason={resumeBlockedReason}
            />
          )}
          {secondary.length > 0 && (
            <section className="flex flex-col gap-sm border-t border-dashed border-[var(--cc-red-a25)] pt-md">
              <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                {secondary.length} more{" "}
                {secondary.length === 1 ? "failure" : "failures"}
              </span>
              <ul className="m-0 flex list-none flex-col gap-md p-0">
                {secondary.map((reason, idx) => {
                  const evidence = outputSchemaEvidenceForReason(
                    outputSchemaEvidence,
                    reason,
                  );
                  const f = formatGraphWorkflowHaltReason(reason, {
                    ...(evidence !== undefined
                      ? {
                          outputSchemaEvidence: evidence,
                          expandOutputSchemaEvidence: true,
                        }
                      : {}),
                  });
                  return (
                    <li
                      key={`${reason.type}-${idx}`}
                      data-testid="halt-secondary-reason"
                      className="flex flex-col gap-xs text-[0.74rem] leading-[1.5] text-text-secondary [&_p]:m-0"
                    >
                      <strong className="font-semibold text-text-primary">
                        {f.headline}
                      </strong>
                      {f.detail}
                      {evidence !== undefined && onEditSchema !== undefined && (
                        <DialogClose asChild>
                          <Button
                            size="sm"
                            touch
                            layoutClassName="w-fit"
                            onClick={() => onEditSchema(evidence.contextId)}
                          >
                            Edit schema
                          </Button>
                        </DialogClose>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        <DialogActions layoutClassName="mt-lg">
          <DialogClose asChild>
            <Button touch>Close</Button>
          </DialogClose>
          {editSchemaContextId !== null && (
            <DialogClose asChild>
              <Button touch onClick={() => onEditSchema?.(editSchemaContextId)}>
                Edit schema
              </Button>
            </DialogClose>
          )}
          {canResume && !hasConflictRecovery && (
            <Button
              variant="primary"
              touch
              onClick={() => onResume()}
              disabled={isMutating || resumeBlockedReason !== null}
              loading={isResuming}
            >
              {isResuming
                ? "Resuming…"
                : resumeBlockedReason !== null
                  ? `Resume — ${resumeBlockedReason}`
                  : "Resume"}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
