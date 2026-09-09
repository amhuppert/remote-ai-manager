"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/Dialog";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { StatusChip } from "@/components/ui/StatusChip";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { cn } from "@/lib/ui/cn";
import { scheduleActivePromptFocus } from "@/lib/hotkeys/prompt-focus";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";

import CheckpointEvidence from "./CheckpointEvidence";
import {
  checkpointChipIsBusy,
  checkpointChipLabel,
  checkpointPhaseHeadline,
  type CheckpointActionState,
  type CheckpointChipState,
} from "./checkpoint-action-state";
import type { ConversationCheckpointSurface } from "./use-conversation-checkpoint";

export interface CheckpointPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surface: ConversationCheckpointSurface;
  /**
   * Overrides where "Review queued messages" goes. Uncertain queued deliveries
   * are resolved in the composer's existing review UI, and that is where the
   * panel sends the user by default — this prop exists for a host that puts
   * the review somewhere else, not to make the destination optional.
   */
  onReviewQueue?: () => void;
  /** Scrolls the host transcript to a merged message index. */
  onNavigateToMessage?: (messageIndex: number) => void;
  /**
   * The conversation's rolling reading artifact, so the panel can say when it
   * covers later history than the saved checkpoint.
   */
  artifact?: { coveredEndSeq: number; updatedAt: string } | null;
}

const LABEL_CLASS =
  "font-mono text-[10px] font-bold tracking-[0.16em] text-text-tertiary uppercase";
const FACT_ROW_CLASS =
  "flex flex-wrap items-baseline gap-x-sm gap-y-2xs font-mono text-[0.72rem] text-text-secondary";
const VALUE_CLASS = "text-text-primary [overflow-wrap:anywhere]";

function unavailable(value: number | null): string {
  return value === null ? "unavailable" : String(value);
}

/**
 * Whether a phase can still be abandoned. Once retirement starts, cancelling
 * cannot restore a provider session — so the control is not offered rather
 * than offered and refused.
 */
function isCancellable(state: CheckpointChipState): boolean {
  return state.kind === "building";
}

function ReceiptFacts({
  receipt,
}: {
  receipt: CheckpointReceipt;
}): React.JSX.Element {
  const seed = receipt.checkpoint;
  const usage = receipt.compactionUsage;
  return (
    <div className="flex flex-col gap-xs">
      <p className={FACT_ROW_CLASS}>
        <span className={LABEL_CLASS}>Operation</span>
        <span className={VALUE_CLASS}>{receipt.operationId}</span>
        <span className={LABEL_CLASS}>Ordinal</span>
        <span className={VALUE_CLASS}>{receipt.ordinal}</span>
        <span className={LABEL_CLASS}>Mechanism</span>
        <span className={VALUE_CLASS}>{receipt.mechanism}</span>
      </p>
      <p className={FACT_ROW_CLASS}>
        <span className={LABEL_CLASS}>Source boundary</span>
        <span className={VALUE_CLASS}>
          captured through seq {receipt.boundary.capturedThroughSeq}
        </span>
      </p>
      {seed === null ? (
        <p className={FACT_ROW_CLASS}>
          <span className={LABEL_CLASS}>Seed</span>
          <span className={VALUE_CLASS}>not frozen</span>
        </p>
      ) : (
        <>
          <p className={FACT_ROW_CLASS}>
            <span className={LABEL_CLASS}>Seed bytes</span>
            {/* Exact byte counts, never a rounded size or a savings claim. */}
            <span className={VALUE_CLASS}>
              {seed.sectionBytes.total} total · {seed.sectionBytes.workingState}{" "}
              working state · {seed.sectionBytes.recentDialogue} recent dialogue
              · {seed.sectionBytes.recoveryFraming} recovery framing
            </span>
          </p>
          <p className={FACT_ROW_CLASS}>
            <span className={LABEL_CLASS}>Seed sha256</span>
            <span className={VALUE_CLASS}>{seed.seedSha256}</span>
          </p>
          <p className={FACT_ROW_CLASS}>
            <span className={LABEL_CLASS}>Versions</span>
            <span className={VALUE_CLASS}>
              generator {seed.versions.generatorVersion} · builder{" "}
              {seed.versions.builderVersion} · normalizer{" "}
              {seed.versions.normalizerVersion}
            </span>
          </p>
          {seed.omissions.length > 0 && (
            <div className="flex flex-col gap-2xs">
              <span className={LABEL_CLASS}>Omissions</span>
              <ul className="m-0 flex list-none flex-col gap-2xs p-0 font-mono text-[0.72rem] text-text-secondary">
                {seed.omissions.map((omission) => (
                  <li key={`${omission.category}-${omission.detail}`}>
                    {omission.category}: {omission.detail || "(no detail)"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <p className={FACT_ROW_CLASS}>
        <span className={LABEL_CLASS}>Compaction passes</span>
        <span className={VALUE_CLASS}>
          {unavailable(receipt.generationPassCount)}
        </span>
      </p>
      <p className={FACT_ROW_CLASS}>
        {/* Named for what it measures: the checkpoint's own compaction calls,
            never the conversation's turn or cumulative usage. A counter the
            backend did not report reads `unavailable`, never `0`. */}
        <span className={LABEL_CLASS}>Compaction usage</span>
        <span className={VALUE_CLASS}>
          input {unavailable(usage.inputTokens)} · cached{" "}
          {unavailable(usage.cachedInputTokens)} · output{" "}
          {unavailable(usage.outputTokens)} · duration{" "}
          {usage.durationMs === null ? "unavailable" : `${usage.durationMs}ms`}
        </span>
      </p>
      <p className={FACT_ROW_CLASS}>
        <span className={LABEL_CLASS}>Accepted continuation</span>
        <span className={VALUE_CLASS}>
          {receipt.hasAcceptedContinuation ? "yes" : "no"}
        </span>
      </p>
      {receipt.failure !== null && (
        <p
          className="rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.72rem] text-red"
          data-checkpoint-failure=""
        >
          {receipt.failure.code} — {receipt.failure.message}
        </p>
      )}
    </div>
  );
}

/**
 * The delivery/acceptance sentence. Three states, not two: an operation with a
 * delivery binding and no acceptance was ATTEMPTED, and calling that "not
 * delivered" is the claim that would authorize an unsafe replay.
 */
function acceptanceSentence(receipt: CheckpointReceipt): string {
  if (receipt.acceptance !== null) {
    return `Accepted by attempt ${receipt.acceptance.attemptId} at ${receipt.acceptance.acceptedAt}.`;
  }
  if (receipt.delivery === null) {
    return "The seed has not been delivered to a turn yet.";
  }
  return `Unconfirmed — the seed is bound to attempt ${receipt.delivery.attemptId} and no acceptance was recorded. Whether that input reached the provider is unresolved.`;
}

/**
 * The boundary of the checkpoint immediately older than the selected one.
 *
 * The receipt index is descending by ordinal, so the next row is the previous
 * operation — and its boundary is where the selected checkpoint's own archive
 * window begins. Null when this is the first checkpoint the conversation ever
 * took, or when the older rows have not been paged in yet, which makes the
 * window start at the conversation's beginning rather than at a guess.
 */
function previousBoundarySeq(
  recent: readonly CheckpointReceipt[],
  operationId: string,
): number | null {
  const index = recent.findIndex(
    (receipt) => receipt.operationId === operationId,
  );
  if (index === -1) return null;
  const older = recent[index + 1];
  return older === undefined ? null : older.boundary.capturedThroughSeq;
}

function RecoveryControls({
  action,
  surface,
  onReviewQueue,
}: {
  action: CheckpointActionState;
  surface: ConversationCheckpointSurface;
  onReviewQueue: () => void;
}): React.JSX.Element | null {
  const latest = surface.latest;
  if (action.kind === "queue_review") {
    return (
      <div className="flex flex-col gap-xs" data-checkpoint-recovery="queue">
        <p className="m-0 text-[0.8rem] text-text-secondary">{action.reason}</p>
        <DialogActions>
          <Button variant="default" onClick={onReviewQueue}>
            Review queued messages
          </Button>
        </DialogActions>
      </div>
    );
  }
  if (action.kind !== "recovery") return null;

  const operationId = action.operationId;
  return (
    <div className="flex flex-col gap-xs" data-checkpoint-recovery="explicit">
      <p className="m-0 text-[0.8rem] text-text-secondary">{action.reason}</p>
      {/* Stated where the user chooses the action, not in a tooltip: a
          recovery checkpoint restores CONTEXT continuity and nothing else. */}
      <p className="m-0 text-[0.8rem] text-text-tertiary">
        Recovery does not undo tool effects, file changes, or anything an
        earlier turn already did. It builds a fresh checkpoint from the complete
        recorded history.
      </p>
      <DialogActions>
        {action.code === "reconciliation_failed" || latest !== null ? (
          <Button
            variant="default"
            onClick={() => {
              if (operationId !== null) surface.reconcile(operationId);
            }}
            disabled={operationId === null}
            loading={surface.isReconciling}
          >
            Reconcile
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={() => {
            if (operationId !== null) surface.startRecovery(operationId);
          }}
          disabled={operationId === null}
          loading={surface.isStarting}
        >
          {operationId === null
            ? "Recovery checkpoint"
            : `Recovery checkpoint for ${operationId}`}
        </Button>
      </DialogActions>
    </div>
  );
}

/**
 * The checkpoint receipt viewer and the recovery surface (design §8).
 *
 * Everything it shows comes from a query, so closing the dialog, remounting
 * the host, or reconnecting the event stream all recover the same phase —
 * there is no progress held here that a remount could lose. It renders no seed
 * text, no retention form, and no pre-compaction preview.
 */
export default function CheckpointPanel({
  open,
  onOpenChange,
  surface,
  onReviewQueue,
  onNavigateToMessage,
  artifact = null,
}: CheckpointPanelProps): React.JSX.Element {
  const { chip, action, latest } = surface;
  // Which saved checkpoint the evidence below describes. It defaults to the
  // newest and follows it, so a panel left open during a new operation keeps
  // showing the current one rather than pinning a stale selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    surface.recent.find((receipt) => receipt.operationId === selectedId) ??
    latest;
  const busy = checkpointChipIsBusy(chip);
  // The review lives in the composer, which is behind this modal. Closing
  // first and then focusing the prompt is what actually puts the retained
  // messages in front of the user; leaving the dialog open would hide them.
  const reviewQueue = useCallback(() => {
    onOpenChange(false);
    if (onReviewQueue !== undefined) {
      onReviewQueue();
      return;
    }
    scheduleActivePromptFocus();
  }, [onOpenChange, onReviewQueue]);
  // The panel is opened from a chip or a menu item, not a `DialogTrigger`, so
  // Radix has no trigger to restore focus to on close and a keyboard user
  // would be dropped at <body>.
  const { captureOpener, restoreOpener } = useOpenerFocus();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        aria-labelledby="checkpoint-panel-title"
        onOpenAutoFocus={captureOpener}
        onCloseAutoFocus={restoreOpener}
      >
        <DialogTitle id="checkpoint-panel-title">
          Context checkpoint
        </DialogTitle>
        <DialogDescription>
          A checkpoint retires this conversation&apos;s provider context and
          hands the next message a frozen summary. It never sends a message on
          its own.
        </DialogDescription>

        {/* One polite live region carrying one sentence. It changes only when
            the durable phase changes, so a build does not narrate progress it
            cannot measure. */}
        <p
          role="status"
          aria-live="polite"
          className="m-0 flex items-center gap-sm text-[0.85rem] text-text-primary"
          data-checkpoint-headline=""
        >
          {busy ? <Spinner size="sm" tone="inherit" /> : null}
          {checkpointPhaseHeadline(chip)}
        </p>

        {surface.isLoading && latest === null ? (
          <EmptyState>
            <EmptyStateTitle>Reading checkpoint state…</EmptyStateTitle>
          </EmptyState>
        ) : latest === null ? (
          <EmptyState>
            <EmptyStateTitle>No checkpoint yet</EmptyStateTitle>
            <EmptyStateDesc>
              Compacting context now freezes a summary of this conversation and
              starts a fresh provider session under the same conversation.
            </EmptyStateDesc>
          </EmptyState>
        ) : (
          <div className="flex min-h-0 flex-col gap-md overflow-y-auto">
            <ReceiptFacts receipt={selected ?? latest} />
            <p className="m-0 text-[0.8rem] text-text-secondary">
              {acceptanceSentence(selected ?? latest)}
            </p>
            <CheckpointEvidence
              // Keyed by operation so selecting a different checkpoint starts
              // from its own boundary rather than keeping an entry opened from
              // the window of the one before it.
              key={(selected ?? latest).operationId}
              target={surface.target}
              receipt={selected ?? latest}
              previousBoundarySeq={previousBoundarySeq(
                surface.recent,
                (selected ?? latest).operationId,
              )}
              artifact={artifact}
              {...(onNavigateToMessage === undefined
                ? {}
                : { onNavigateToMessage })}
            />
            {(surface.recent.length > 1 || surface.hasOlder) && (
              <div className="flex flex-col gap-2xs">
                <span className={LABEL_CLASS}>Checkpoint history</span>
                {/* Every saved operation is selectable: a conversation
                    compacted repeatedly keeps its earlier boundaries, entry
                    exports and images, and this is the only route to them. */}
                <ul className="m-0 flex list-none flex-col gap-2xs p-0">
                  {surface.recent.map((receipt) => {
                    const isSelected =
                      receipt.operationId === (selected ?? latest).operationId;
                    return (
                      <li key={receipt.operationId}>
                        <button
                          type="button"
                          className={cn(
                            FACT_ROW_CLASS,
                            "w-full cursor-pointer rounded-sm border border-solid bg-transparent px-xs py-2xs text-left",
                            isSelected
                              ? "border-cyan bg-bg-hover"
                              : "border-transparent hover:border-border-default",
                          )}
                          aria-current={isSelected}
                          onClick={() => setSelectedId(receipt.operationId)}
                        >
                          <StatusChip tone="neutral" appearance="solid">
                            {`#${receipt.ordinal}`}
                          </StatusChip>
                          <span className={VALUE_CLASS}>
                            {receipt.operationId}
                          </span>
                          <span>{receipt.phase}</span>
                          <span>seq {receipt.boundary.capturedThroughSeq}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {surface.hasOlder && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={surface.loadOlder}
                    loading={surface.isLoadingOlder}
                  >
                    Load older checkpoints
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {surface.requestError !== null && (
          <p
            className="m-0 rounded-sm border border-solid border-red-dim bg-red-glow px-sm py-xs font-mono text-[0.75rem] text-red"
            data-checkpoint-error=""
          >
            {surface.requestError}
          </p>
        )}

        <RecoveryControls
          action={action}
          surface={surface}
          onReviewQueue={reviewQueue}
        />

        <DialogActions>
          {latest !== null && isCancellable(chip) && (
            <Button
              variant="default"
              onClick={() => surface.cancel(latest.operationId)}
              loading={surface.isCancelling}
            >
              Cancel checkpoint
            </Button>
          )}
          {chip.kind === "needs_reconciliation" &&
            latest !== null &&
            action.kind !== "recovery" &&
            action.kind !== "queue_review" && (
              <Button
                variant="default"
                onClick={() => surface.reconcile(latest.operationId)}
                loading={surface.isReconciling}
              >
                Reconcile
              </Button>
            )}
          <DialogClose asChild>
            <Button variant="default">Close</Button>
          </DialogClose>
        </DialogActions>

        {action.kind === "unsupported" || action.kind === "disabled" ? (
          <p
            className="m-0 text-[0.8rem] text-text-tertiary"
            data-checkpoint-disabled-reason=""
          >
            {action.reason}
          </p>
        ) : null}

        {action.kind === "available" && (
          <p className="m-0 text-[0.8rem] text-text-tertiary">
            {`Status: ${checkpointChipLabel(chip)}. A new checkpoint can start now.`}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
