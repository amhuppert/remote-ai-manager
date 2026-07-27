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
import JoinConflictRecoveryCard from "@/components/workflow-graph/JoinConflictRecoveryCard";
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
  onResume(conflictGuidance?: ConflictDecisionInput[]): void;
  isMutating: boolean;
  isResuming: boolean;
}

export default function HaltDetailsDialog({
  open,
  onOpenChange,
  primary,
  secondary = [],
  conflictAnalysis,
  canResume,
  onResume,
  isMutating,
  isResuming,
}: HaltDetailsDialogProps): React.JSX.Element {
  const hasConflictRecovery =
    primary.type === "join_failure" && primary.conflictFiles.length > 0;
  // The recovery form below is the canonical conflict-file presentation here;
  // omit the formatter's plain list so each file appears once.
  const formatted = formatGraphWorkflowHaltReason(primary, {
    omitConflictFiles: hasConflictRecovery,
  });
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
              className="w-fit text-[0.74rem] font-semibold text-cyan hover:underline"
            >
              Open the merge gate →
            </Link>
          )}
          {hasConflictRecovery && (
            <JoinConflictRecoveryCard
              conflictFiles={primary.conflictFiles}
              analysis={conflictAnalysis}
              onRetry={(guidance) =>
                onResume(guidance.length > 0 ? guidance : undefined)
              }
              isRetrying={isResuming}
              disabled={isMutating}
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
                  const f = formatGraphWorkflowHaltReason(reason);
                  return (
                    <li
                      key={`${reason.type}-${idx}`}
                      className="flex flex-col gap-xs text-[0.74rem] leading-[1.5] text-text-secondary [&_p]:m-0"
                    >
                      <strong className="font-semibold text-text-primary">
                        {f.headline}
                      </strong>
                      {f.detail}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
        <DialogActions layoutClassName="mt-lg">
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
          {canResume && !hasConflictRecovery && (
            <Button
              variant="primary"
              onClick={() => onResume()}
              disabled={isMutating}
              loading={isResuming}
            >
              {isResuming ? "Resuming…" : "Resume"}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
