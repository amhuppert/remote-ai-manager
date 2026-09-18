"use client";

import { useCallback, useRef, useState } from "react";

import {
  ArchiveIcon,
  CheckIcon,
  CloseIcon,
  GearIcon,
  AlertTriangleIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
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
import { WithTooltip } from "@/components/ui/WithTooltip";
import { useOpenerFocus } from "@/hooks/use-opener-focus";
import { cn } from "@/lib/ui/cn";
import { createClientLogger } from "@/lib/logging/client-logger";
import { scheduleActivePromptFocus } from "@/lib/hotkeys/prompt-focus";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";

import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import CheckpointForkForm from "./CheckpointForkForm";

import CheckpointEvidence from "./CheckpointEvidence";
import CheckpointDisclosure from "./CheckpointDisclosure";
import {
  checkpointChipIsBusy,
  checkpointChipLabel,
  checkpointPhaseHeadline,
  deriveCheckpointChipState,
  type CheckpointActionState,
  type CheckpointChipState,
} from "./checkpoint-action-state";
import type { ConversationCheckpointSurface } from "./use-conversation-checkpoint";

export interface CheckpointPanelProps {
  open: boolean;
  preparation?: boolean;
  onPreparationComplete?: () => void;
  onOpenChange: (open: boolean) => void;
  surface: ConversationCheckpointSurface;
  sourceConversation?: PublicConversationState;
  initialForkModel?: BackendModelSelection;
  initialForkTicket?: number;
  initialOperationId?: string;
  onForkCreated?(conversation: PublicConversationState): void;
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
  "font-mono text-[0.7rem] font-medium tracking-[0.1em] text-text-secondary uppercase";
const FACT_ROW_CLASS =
  "grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-md gap-y-sm font-mono text-[0.72rem] leading-[1.6] text-text-secondary max-640:grid-cols-1 max-640:gap-y-xs";
const VALUE_CLASS = "text-text-primary [overflow-wrap:anywhere]";
const logger = createClientLogger("checkpoint-panel");
const checkpointDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function checkpointSummary(receipt: CheckpointReceipt): string {
  if (receipt.acceptance !== null) {
    return "The conversation continued using this saved handoff.";
  }
  if (receipt.delivery !== null) {
    return "Delivery was attempted, but acceptance is unconfirmed. Whether the input reached the provider is unresolved.";
  }
  switch (receipt.phase) {
    case "building":
      if (receipt.handoff?.stage === "settling")
        return "Stopping capture and waiting for execution to settle. Queued messages remain held.";
      if (
        receipt.handoff?.stage === "pending" ||
        receipt.handoff?.stage === "running"
      )
        return "The current agent is recording advisory working state. Queued messages remain held.";
      if (receipt.handoff?.stage === "omitted")
        return `Handoff omitted — ${receipt.handoff.omissionReason?.replaceAll("_", " ") ?? "unavailable"}. Continuing with recorded evidence.`;
      return "Preparing a saved handoff from the recorded conversation. You can cancel while it is building.";
    case "retiring":
      return "The handoff is saved. Retiring the current provider context before the next message.";
    case "ready":
      return "Your next message will carry the saved handoff into a fresh provider context.";
    case "cancelled":
      return "The checkpoint was cancelled before the provider context was retired.";
    case "failed":
      return "The checkpoint could not be completed. Review the failure below.";
    case "needs_reconciliation":
      return "The checkpoint was interrupted. Reconcile its state before continuing.";
    default:
      return "No acceptance has been recorded for this checkpoint.";
  }
}

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
    <div className="flex flex-col gap-md">
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
  const capture = latest?.handoff;
  if (
    latest?.phase === "needs_reconciliation" &&
    latest.lastStablePhase === "building" &&
    latest.checkpoint === null &&
    capture?.stage === "omitted" &&
    ["interrupted", "cleanup_unverified"].includes(
      capture.omissionReason ?? "",
    ) &&
    !capture.executionSettled
  ) {
    return (
      <div className="flex flex-col gap-md rounded-md border border-solid border-amber-dim bg-bg-base p-lg">
        <p className="text-sm text-amber">
          Capture cleanup is unverified —{" "}
          {capture.omissionReason?.replaceAll("_", " ")}.
        </p>
        <p className="text-sm leading-relaxed text-text-secondary">
          Inspect and stop prior backend work before acknowledging. This records
          your testimony, not CC-observed cleanup. Queued messages remain held;
          a separate baseline recovery checkpoint is required.
        </p>
        <Button
          touch
          loading={surface.isReconciling}
          onClick={() => surface.acknowledgeCaptureStopped(latest.operationId)}
        >
          I have stopped the prior execution
        </Button>
      </div>
    );
  }
  if (action.kind === "queue_review") {
    return (
      <div
        className="flex flex-col gap-md rounded-md border border-solid border-border-default bg-bg-base p-lg"
        data-checkpoint-recovery="queue"
      >
        <p className="m-0 text-[0.8rem] text-text-secondary">{action.reason}</p>
        <DialogActions>
          <Button touch variant="default" onClick={onReviewQueue}>
            Review queued messages
          </Button>
        </DialogActions>
      </div>
    );
  }
  if (action.kind !== "recovery") return null;

  const operationId = action.operationId;
  return (
    <div
      className="flex flex-col gap-md rounded-md border border-solid border-border-default bg-bg-base p-lg"
      data-checkpoint-recovery="explicit"
    >
      <p className="m-0 text-[0.8rem] text-text-secondary">{action.reason}</p>
      {/* Stated where the user chooses the action, not in a tooltip: a
          recovery checkpoint restores CONTEXT continuity and nothing else. */}
      <p className="m-0 text-[0.8rem] text-text-tertiary">
        Recovery does not undo tool effects, file changes, or anything an
        earlier turn already did. It builds a fresh checkpoint from the complete
        recorded history.
      </p>
      <div className="flex flex-wrap justify-end gap-sm">
        {action.code === "reconciliation_failed" || latest !== null ? (
          <Button
            touch
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
          touch
          variant="primary"
          aria-label={
            operationId === null
              ? "Recovery checkpoint"
              : `Recovery checkpoint for ${operationId}`
          }
          onClick={() => {
            if (operationId !== null) surface.startRecovery(operationId);
          }}
          disabled={operationId === null}
          loading={surface.isStarting}
        >
          Recovery checkpoint
        </Button>
      </div>
      {operationId !== null && (
        <p className="font-mono text-[0.72rem] leading-[1.6] [overflow-wrap:anywhere] text-text-secondary">
          Recovery supersedes operation{" "}
          <span className="text-text-primary">{operationId}</span>.
        </p>
      )}
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
  preparation = false,
  onPreparationComplete,
  onOpenChange,
  surface,
  sourceConversation,
  initialForkModel,
  initialForkTicket,
  initialOperationId,
  onForkCreated,
  onReviewQueue,
  onNavigateToMessage,
  artifact = null,
}: CheckpointPanelProps): React.JSX.Element {
  const { chip, action, latest } = surface;
  const captureActive =
    latest?.phase === "building" &&
    latest.handoff !== null &&
    ["pending", "running", "settling"].includes(latest.handoff.stage);
  const [forkReceipt, setForkReceipt] = useState<CheckpointReceipt | null>(
    null,
  );
  const [forkVisible, setForkVisible] = useState(false);
  const [forkPending, setForkPending] = useState(false);
  const navigating = useRef(false);
  function changeOpen(next: boolean) {
    if (!next && forkPending && !navigating.current) return;
    if (!next) {
      setForkReceipt(null);
      setForkVisible(false);
    }
    onOpenChange(next);
  }
  function openCreated(conversation: PublicConversationState) {
    navigating.current = true;
    changeOpen(false);
    if (onForkCreated) onForkCreated(conversation);
    else
      window.location.assign(
        surface.target.scope === "session"
          ? conversationsPageHref({
              conversationId: conversation.id,
              autoFocus: true,
            })
          : `/projects/${encodeURIComponent(surface.target.projectName)}?focus=${encodeURIComponent(conversation.id)}`,
      );
  }
  // Which saved checkpoint the evidence below describes. It defaults to the
  // newest and follows it, so a panel left open during a new operation keeps
  // showing the current one rather than pinning a stale selection.
  const [selectedId, setSelectedId] = useState<string | null>(
    initialOperationId ?? null,
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  const selected =
    selectedId === null
      ? latest
      : (surface.recent.find((receipt) => receipt.operationId === selectedId) ??
        null);
  const selectedChip = deriveCheckpointChipState(selected);
  const busy = checkpointChipIsBusy(selectedChip);
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
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        unstyled
        contentClassName="relative mx-lg flex max-h-[calc(100dvh-2*var(--spacing-lg))] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-solid border-border-default bg-bg-surface font-mono text-text-primary shadow-dropdown max-768:mx-sm max-768:max-h-[calc(100dvh-2*var(--spacing-sm))]"
        aria-labelledby="checkpoint-panel-title"
        onOpenAutoFocus={() => {
          navigating.current = false;
          captureOpener();
        }}
        onCloseAutoFocus={(event) => {
          if (navigating.current) event.preventDefault();
          else restoreOpener(event);
        }}
      >
        <div className="shrink-0 border-x-0 border-t-0 border-b border-solid border-border-subtle px-xl pt-xl pb-lg max-768:px-lg max-768:pt-lg">
          <div className="flex items-start justify-between gap-lg">
            <div className="min-w-0 flex-1">
              <DialogTitle id="checkpoint-panel-title">
                {forkVisible
                  ? "Fork from checkpoint"
                  : preparation
                    ? "Compact with agent handoff"
                    : "Context checkpoint"}
              </DialogTitle>
            </div>
            <WithTooltip label="Close checkpoint dialog">
              <DialogClose asChild>
                <IconButton
                  variant="square"
                  disabled={forkPending}
                  aria-label="Close checkpoint dialog"
                >
                  <CloseIcon size={18} />
                </IconButton>
              </DialogClose>
            </WithTooltip>
          </div>
          <DialogDescription layoutClassName="mb-0">
            {forkVisible
              ? "Start a focused conversation from this saved handoff."
              : preparation
                ? "Ask the current agent to record its plan and next step, then create a checkpoint."
                : "A saved handoff lets the next message start with fresh context. Your conversation history stays available."}
          </DialogDescription>
        </div>

        {forkReceipt && sourceConversation && (
          <div
            className={forkVisible ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          >
            <CheckpointForkForm
              key={forkReceipt.operationId}
              target={surface.target}
              receipt={forkReceipt}
              source={sourceConversation}
              {...(initialForkModel ? { initialModel: initialForkModel } : {})}
              {...(initialForkTicket
                ? { initialTicket: initialForkTicket }
                : {})}
              active={forkVisible}
              onPendingChange={setForkPending}
              onBack={() => {
                setForkVisible(false);
                requestAnimationFrame(() =>
                  bodyRef.current
                    ?.querySelector<HTMLButtonElement>(
                      "[data-checkpoint-fork-trigger]",
                    )
                    ?.focus(),
                );
              }}
              onCreated={openCreated}
            />
          </div>
        )}
        {preparation && !forkVisible && (
          <div className="flex min-h-0 flex-col gap-lg overflow-y-auto p-xl max-768:p-lg">
            <p className="text-sm text-text-secondary">
              {sourceConversation?.agentBackend ?? "Current conversation agent"}
              {initialForkModel ? ` · ${initialForkModel.modelId}` : ""}
            </p>
            <p className="text-sm text-text-primary">
              {surface.handoff?.mode === "instruction-only"
                ? "Instruction-only: the agent is asked not to use tools; tools remain available."
                : surface.handoff?.mode === "tool-disabled"
                  ? "Tools are disabled for the handoff."
                  : "No capture mode is available."}
            </p>
            {surface.handoff && (
              <p className="text-sm leading-relaxed text-text-secondary">
                At most {surface.handoff.policy.limits.maxSubmissions} extra
                call; {surface.handoff.policy.limits.executionMs / 1000} seconds
                to execute. Capture-added input is limited to{" "}
                {surface.handoff.policy.limits.inputBytes} bytes; accepted
                output to {surface.handoff.policy.limits.outputBytes} bytes.
                Limits omit the handoff and continue with recorded evidence
                after execution settles. Stopping may require reconciliation.
                Cost is checked after the request; there is no hard cost or
                source-context limit.
              </p>
            )}
            {!surface.handoff?.available && (
              <p role="status" className="text-sm text-amber">
                {surface.handoff?.reason ?? "Reading capture capability…"}
              </p>
            )}
            {action.kind !== "available" && (
              <p className="text-sm text-text-secondary">
                {action.kind === "loading"
                  ? "Checking checkpoint eligibility…"
                  : action.reason}
              </p>
            )}
            {surface.requestError && (
              <p role="alert" className="text-sm text-red">
                {surface.requestError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-sm max-640:flex-col">
              <Button
                touch
                disabled={action.kind !== "available" || surface.isStarting}
                onClick={() => {
                  surface.start();
                  onPreparationComplete?.();
                }}
              >
                Compact without handoff
              </Button>
              <Button
                touch
                variant="primary"
                loading={surface.isStarting}
                disabled={
                  action.kind !== "available" || !surface.handoff?.available
                }
                onClick={() => {
                  surface.startHandoff(surface.handoff?.mode ?? null);
                  onPreparationComplete?.();
                }}
              >
                Capture handoff and compact
              </Button>
            </div>
          </div>
        )}
        {!forkVisible && !preparation && (
          <>
            <div
              ref={bodyRef}
              className="flex min-h-0 flex-col gap-lg overflow-y-auto overscroll-contain p-xl max-768:p-lg"
            >
              {/* One polite live region carrying one sentence. It changes only when
            the durable phase changes, so a build does not narrate progress it
            cannot measure. */}
              {selected !== null && (
                <div className="flex flex-col gap-lg">
                  <div className="flex items-start gap-md">
                    <span
                      aria-hidden="true"
                      data-phase={selectedChip.kind.replaceAll("_", "-")}
                      className="flex size-[36px] shrink-0 items-center justify-center rounded-full bg-bg-raised text-text-secondary data-[phase=applied]:bg-green-glow data-[phase=applied]:text-green data-[phase=building]:text-cyan data-[phase=delivering]:text-cyan data-[phase=failed]:bg-red-glow data-[phase=failed]:text-red data-[phase=needs-reconciliation]:bg-amber-glow data-[phase=needs-reconciliation]:text-amber data-[phase=ready]:bg-green-glow data-[phase=ready]:text-green data-[phase=retiring]:text-cyan"
                    >
                      {busy ? (
                        <Spinner size="sm" tone="inherit" />
                      ) : selectedChip.kind === "applied" ||
                        selectedChip.kind === "ready" ? (
                        <CheckIcon size={20} />
                      ) : selectedChip.kind === "failed" ||
                        selectedChip.kind === "needs_reconciliation" ? (
                        <AlertTriangleIcon size={20} />
                      ) : (
                        <ArchiveIcon size={20} />
                      )}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-xs">
                      <p
                        role="status"
                        aria-live="polite"
                        className="text-[0.9rem] leading-[1.5] font-medium"
                        data-checkpoint-headline=""
                      >
                        {checkpointPhaseHeadline(selectedChip)}
                      </p>
                      <p className="text-[0.78rem] leading-[1.65] text-text-secondary">
                        {checkpointSummary(selected)}
                      </p>
                    </div>
                  </div>
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

              {surface.isLoading && selected === null ? (
                <EmptyState>
                  <EmptyStateTitle>Reading checkpoint state…</EmptyStateTitle>
                </EmptyState>
              ) : selected === null ? (
                <EmptyState>
                  <EmptyStateTitle>No checkpoint yet</EmptyStateTitle>
                  <EmptyStateDesc>
                    Compacting context now freezes a summary of this
                    conversation and starts a fresh provider session under the
                    same conversation.
                  </EmptyStateDesc>
                </EmptyState>
              ) : (
                <div className="flex min-w-0 flex-col gap-sm">
                  <div className="mb-sm grid grid-cols-3 gap-md rounded-md border border-solid border-border-subtle bg-bg-base p-lg max-768:gap-sm max-768:p-md">
                    <div className="flex flex-col gap-sm">
                      <span className="text-[1.1rem] font-medium tabular-nums">
                        #{selected.ordinal}
                      </span>
                      <span className={LABEL_CLASS}>Checkpoint</span>
                    </div>
                    <div className="flex flex-col gap-sm">
                      <span className="text-[1.1rem] font-medium tabular-nums">
                        {selected.checkpoint?.sectionBytes.total.toLocaleString() ??
                          "—"}
                      </span>
                      <span className={LABEL_CLASS}>Checkpoint bytes</span>
                      {selected.forkFramingBytes !== undefined && (
                        <span className="text-[0.7rem] text-text-secondary">
                          + {selected.forkFramingBytes.toLocaleString()} fork
                          framing bytes
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-sm">
                      <span className="text-[1.1rem] font-medium tabular-nums">
                        {selected.generationPassCount ?? "—"}
                      </span>
                      <span className={LABEL_CLASS}>Build passes</span>
                    </div>
                  </div>
                  {selected.acceptance !== null && (
                    <p className="mb-sm text-[0.72rem] text-text-secondary">
                      Accepted{" "}
                      <time dateTime={selected.acceptance.acceptedAt}>
                        {checkpointDate.format(
                          new Date(selected.acceptance.acceptedAt),
                        )}
                      </time>
                    </p>
                  )}
                  {selected.failure !== null && (
                    <p
                      className="mb-sm rounded-md border border-solid border-red-dim bg-red-glow p-md text-[0.78rem] leading-[1.6] [overflow-wrap:anywhere] text-red"
                      data-checkpoint-failure=""
                    >
                      {selected.failure.code} — {selected.failure.message}
                    </p>
                  )}
                  {sourceConversation &&
                    !sourceConversation.archived &&
                    sourceConversation.owner === null &&
                    sourceConversation.role === null &&
                    selected.checkpoint !== null && (
                      <Button
                        data-checkpoint-fork-trigger=""
                        touch
                        variant="primary"
                        onClick={() => {
                          setForkReceipt(selected);
                          setForkVisible(true);
                        }}
                      >
                        Fork from this checkpoint
                      </Button>
                    )}
                  <CheckpointEvidence
                    // Keyed by operation so selecting a different checkpoint starts
                    // from its own boundary rather than keeping an entry opened from
                    // the window of the one before it.
                    key={selected.operationId}
                    target={surface.target}
                    receipt={selected}
                    previousBoundarySeq={previousBoundarySeq(
                      surface.recent,
                      selected.operationId,
                    )}
                    artifact={artifact}
                    {...(onNavigateToMessage === undefined
                      ? {}
                      : { onNavigateToMessage })}
                  />
                  <CheckpointDisclosure
                    title="Checkpoint details"
                    description="Usage, integrity and delivery receipt"
                    icon={<GearIcon size={20} />}
                    operationId={selected.operationId}
                  >
                    <ReceiptFacts receipt={selected} />
                    <p className="mt-lg text-[0.72rem] leading-[1.65] [overflow-wrap:anywhere] text-text-secondary">
                      {acceptanceSentence(selected)}
                    </p>
                  </CheckpointDisclosure>
                  {(surface.recent.length > 1 || surface.hasOlder) && (
                    <CheckpointDisclosure
                      title="Checkpoint history"
                      description="Inspect earlier handoffs and their archives"
                      icon={<ArchiveIcon size={20} />}
                      operationId={selected.operationId}
                    >
                      {/* Every saved operation is selectable: a conversation
                    compacted repeatedly keeps its earlier boundaries, entry
                    exports and images, and this is the only route to them. */}
                      <ul className="m-0 flex list-none flex-col gap-2xs p-0">
                        {surface.recent.map((receipt) => {
                          const isSelected =
                            receipt.operationId === selected.operationId;
                          return (
                            <li key={receipt.operationId}>
                              <button
                                type="button"
                                className={cn(
                                  "flex min-h-[44px] w-full cursor-pointer items-center gap-md rounded-sm border border-solid px-md py-sm text-left font-mono text-[0.78rem] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]",
                                  isSelected
                                    ? "border-cyan bg-bg-surface"
                                    : "border-transparent bg-transparent hover:border-border-default hover:bg-bg-surface",
                                )}
                                aria-current={isSelected}
                                onClick={() => {
                                  logger.debug("checkpoint_panel.selected", {
                                    operationId: receipt.operationId,
                                  });
                                  setSelectedId(receipt.operationId);
                                  if (bodyRef.current !== null)
                                    bodyRef.current.scrollTop = 0;
                                }}
                              >
                                <StatusChip tone="neutral" appearance="solid">
                                  {`#${receipt.ordinal}`}
                                </StatusChip>
                                <span className="min-w-0 flex-1 text-text-primary">
                                  {checkpointChipLabel(
                                    deriveCheckpointChipState(receipt),
                                  )}
                                </span>
                                <span className="text-[0.72rem] text-text-secondary">
                                  seq {receipt.boundary.capturedThroughSeq}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                      {surface.hasOlder && (
                        <Button
                          touch
                          size="sm"
                          variant="ghost"
                          onClick={surface.loadOlder}
                          loading={surface.isLoadingOlder}
                        >
                          Load older checkpoints
                        </Button>
                      )}
                    </CheckpointDisclosure>
                  )}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-lg border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-xl py-lg max-768:flex-wrap max-768:gap-md max-768:px-lg">
              <div className="min-w-0 flex-1 text-[0.72rem] leading-[1.6] text-text-secondary max-768:basis-full">
                <p>
                  {captureActive
                    ? "Queued messages stay held until capture settles."
                    : "No message is sent automatically."}
                </p>
                {captureActive && (
                  <p id="checkpoint-skip-description">
                    Continue with recorded evidence.
                  </p>
                )}
                {selected !== null &&
                  latest !== null &&
                  selected.operationId !== latest.operationId && (
                    <p className="mt-xs">
                      Latest: #{latest.ordinal} · {checkpointChipLabel(chip)}
                    </p>
                  )}
                {action.kind === "unsupported" || action.kind === "disabled" ? (
                  <p className="mt-xs" data-checkpoint-disabled-reason="">
                    {action.reason}
                  </p>
                ) : null}
              </div>
              <DialogActions layoutClassName="max-768:ml-auto">
                {captureActive && latest && (
                  <Button
                    touch
                    variant="default"
                    aria-describedby="checkpoint-skip-description"
                    disabled={
                      latest.handoff?.stage === "settling" ||
                      surface.isCancelling
                    }
                    loading={surface.isSkipping}
                    onClick={() => surface.skipHandoff(latest.operationId)}
                  >
                    Skip handoff
                  </Button>
                )}
                {latest !== null && isCancellable(chip) && (
                  <Button
                    touch
                    variant="default"
                    onClick={() => surface.cancel(latest.operationId)}
                    loading={surface.isCancelling}
                    disabled={latest.handoff?.stopIntent === "cancel"}
                  >
                    Cancel checkpoint
                  </Button>
                )}
                {chip.kind === "needs_reconciliation" &&
                  latest !== null &&
                  action.kind !== "recovery" &&
                  action.kind !== "queue_review" && (
                    <Button
                      touch
                      variant="default"
                      onClick={() => surface.reconcile(latest.operationId)}
                      loading={surface.isReconciling}
                    >
                      Reconcile
                    </Button>
                  )}
                <DialogClose asChild>
                  <Button touch variant="default">
                    Close
                  </Button>
                </DialogClose>
                {action.kind === "available" && (
                  <Button
                    touch
                    variant="primary"
                    onClick={surface.start}
                    loading={surface.isStarting}
                  >
                    Create checkpoint
                  </Button>
                )}
              </DialogActions>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
