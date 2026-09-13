"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  FormInput,
  FormLabel,
  FormHint,
  FormError,
} from "@/components/ui/FormField";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  AcceptanceReviewRequest,
  DeliveryReviewView,
} from "@/lib/specs/delivery-review-schemas";

export interface SpecDeliveryReviewProps {
  view: DeliveryReviewView;
  pending?: boolean;
  error?: string | null;
  onReview(input: AcceptanceReviewRequest): Promise<void>;
  onApprove(waiveRemaining: boolean, note: string): Promise<void>;
  canContinueMerge?: boolean;
}

export default function SpecDeliveryReview(
  props: SpecDeliveryReviewProps,
): React.JSX.Element {
  const { view } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const noteId = useId();
  const pending = props.pending || working !== null;
  const selectedIds = view.criteria
    .filter((criterion) => selected.has(criterion.id))
    .map((criterion) => criterion.id);
  const unresolved = view.criteria.filter(
    (criterion) => criterion.inScope && criterion.outcome === "needs_review",
  );
  const settled = view.criteria.filter(
    (criterion) => criterion.inScope && criterion.outcome !== "needs_review",
  ).length;
  const total = view.criteria.filter((criterion) => criterion.inScope).length;
  const visible = expanded ? view.criteria : view.criteria.slice(0, 4);
  const executionBlocked =
    view.execution?.state !== "running" ||
    view.blockers.some((blocker) => blocker.kind === "execution");

  async function act(
    label: string,
    action: () => Promise<void>,
    success: string,
  ) {
    setWorking(label);
    setLocalError(null);
    setFeedback("");
    try {
      await action();
      setFeedback(success);
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "The delivery review could not be saved.",
      );
    } finally {
      setWorking(null);
    }
  }
  function review(decision: AcceptanceReviewRequest["decision"]) {
    void act(
      decision,
      async () => {
        await props.onReview({
          revisionId: view.revisionId,
          expectedContentHash: view.contentHash,
          expectedReviewId: view.lastReviewId,
          criterionIds: selectedIds,
          decision,
          note: note.trim(),
        });
        setSelected(new Set());
      },
      `${selectedIds.length} criteria reviewed.`,
    );
  }

  return (
    <section
      aria-label="Delivery review"
      className="overflow-hidden rounded-lg border border-solid border-border-default bg-bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-lg border-x-0 border-t-0 border-b border-solid border-border-dim p-lg">
        <div className="min-w-0 flex-1">
          <div className="mb-sm flex flex-wrap items-center gap-sm">
            <h3 className="m-0 font-sans text-[1.15rem] font-semibold text-text-primary">
              Delivery review
            </h3>
            <StatusChip tone="neutral">
              Revision {view.revisionNumber}
            </StatusChip>
          </div>
          <p className="m-0 max-w-[640px] text-[0.85rem] leading-relaxed text-text-secondary">
            Accept criteria based on the available proof or your judgment. Each
            decision stays with the specification.
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono text-[1.5rem] font-semibold text-text-primary">
            {settled}
            <span className="text-[0.85rem] font-normal text-text-tertiary">
              {" "}
              / {total}
            </span>
          </div>
          <span className="font-mono text-[0.65rem] text-text-tertiary">
            in scope settled
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
        <span className="mr-sm font-mono text-[0.7rem] text-text-secondary">
          Select
        </span>
        <Button
          size="sm"
          touch
          disabled={pending}
          onClick={() =>
            setSelected(new Set(view.criteria.map((criterion) => criterion.id)))
          }
        >
          Select all {view.criteria.length}
        </Button>
        <Button
          size="sm"
          touch
          disabled={pending || unresolved.length === 0}
          onClick={() =>
            setSelected(new Set(unresolved.map((criterion) => criterion.id)))
          }
        >
          Select unresolved {unresolved.length}
        </Button>
        {selectedIds.length > 0 && (
          <Button
            size="sm"
            touch
            variant="ghost"
            disabled={pending}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        )}
      </div>

      <div className="grid gap-md border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-base p-lg">
        <div
          className="font-mono text-[0.75rem] text-text-primary"
          aria-live="polite"
        >
          {selectedIds.length} selected · Revision {view.revisionNumber}
        </div>
        <div>
          <FormLabel htmlFor={noteId}>Review note</FormLabel>
          <FormInput
            id={noteId}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add context for this decision"
            aria-describedby={`${noteId}-hint`}
          />
          <FormHint id={`${noteId}-hint`}>
            Optional when marking satisfied. One shared reason is required to
            waive evidence.
          </FormHint>
        </div>
        <div className="flex flex-wrap gap-sm">
          <Button
            variant={selectedIds.length > 0 ? "primary" : "default"}
            size="sm"
            touch
            disabled={pending || selectedIds.length === 0}
            loading={working === "satisfied"}
            onClick={() => review("satisfied")}
          >
            Mark satisfied
          </Button>
          <Button
            size="sm"
            touch
            disabled={pending || selectedIds.length === 0 || !note.trim()}
            loading={working === "waived"}
            onClick={() => review("waived")}
          >
            Waive evidence
          </Button>
          <Button
            size="sm"
            touch
            variant="ghost"
            disabled={pending || selectedIds.length === 0}
            loading={working === "revoked"}
            onClick={() => review("revoked")}
          >
            Revoke decision
          </Button>
        </div>
        {(localError || props.error) && (
          <FormError role="alert">{localError ?? props.error}</FormError>
        )}
        {feedback && (
          <p role="status" className="m-0 text-[0.78rem] text-green">
            {feedback}
          </p>
        )}
      </div>

      <div>
        {visible.map((criterion, index) => (
          <div key={criterion.id}>
            {(index === 0 ||
              visible[index - 1]?.requirement !== criterion.requirement) && (
              <div className="bg-bg-base px-lg py-sm font-mono text-[0.68rem] font-semibold text-text-secondary">
                {criterion.requirement}
              </div>
            )}
            <div className="flex items-start gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
              <Checkbox
                touch
                aria-label={`Select ${criterion.handle}`}
                checked={selected.has(criterion.id)}
                disabled={pending}
                layoutClassName="mt-xs"
                onCheckedChange={(checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(criterion.id);
                    else next.delete(criterion.id);
                    return next;
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className="mb-xs flex flex-wrap items-center gap-sm">
                  <span className="font-mono text-[0.68rem] text-text-tertiary">
                    {criterion.handle}
                  </span>
                  <StatusChip tone={outcomeTone[criterion.outcome]}>
                    {outcomeLabel[criterion.outcome]}
                  </StatusChip>
                </div>
                <p className="m-0 text-[0.83rem] leading-relaxed text-text-primary">
                  {criterion.text}
                </p>
                {criterion.humanReview?.note && (
                  <p className="mt-sm mb-0 text-[0.75rem] leading-relaxed text-text-secondary">
                    {criterion.humanReview.note}
                  </p>
                )}
                {criterion.automated.length > 0 && (
                  <details className="mt-sm text-[0.72rem] leading-relaxed text-text-tertiary">
                    <summary className="cursor-pointer">
                      Automated results
                    </summary>
                    {criterion.automated.map((result, resultIndex) => (
                      <p key={resultIndex} className="mt-sm mb-0 break-words">
                        {result}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {view.criteria.length > 4 && (
        <div className="px-lg py-sm">
          <Button
            size="sm"
            touch
            variant="ghost"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? "Show fewer criteria"
              : `Show all ${view.criteria.length} criteria`}
          </Button>
        </div>
      )}

      {!view.delivered && (
        <div className="grid gap-md border-x-0 border-t border-b-0 border-solid border-border-default p-lg">
          <div className="flex flex-wrap items-center gap-sm">
            <h4 className="m-0 text-[0.9rem] font-semibold text-text-primary">
              Ready to merge
            </h4>
            {view.approvalGranted && (
              <StatusChip tone="green">Delivery approved</StatusChip>
            )}
          </div>
          {view.blockers.length > 0 && (
            <div className="text-[0.78rem] leading-relaxed text-text-secondary">
              <p className="m-0">
                {unresolved.length > 0
                  ? `${unresolved.length} criteria need your review.`
                  : "Acceptance criteria are settled."}
              </p>
              {view.blockers
                .filter((blocker) => blocker.kind !== "criterion")
                .map((blocker) => (
                  <p key={blocker.criterionId} className="mt-sm mb-0">
                    {blocker.reason}
                  </p>
                ))}
            </div>
          )}
          <div className="flex flex-wrap gap-sm">
            <Button
              variant={
                executionBlocked || unresolved.length > 0
                  ? "default"
                  : "primary"
              }
              size="sm"
              touch
              disabled={
                pending ||
                executionBlocked ||
                unresolved.length > 0 ||
                (view.approvalGranted && !props.canContinueMerge)
              }
              loading={working === "approve"}
              onClick={() => {
                void act(
                  "approve",
                  () => props.onApprove(false, note.trim()),
                  props.canContinueMerge
                    ? "Merge started."
                    : "Delivery approved.",
                );
              }}
            >
              {view.approvalGranted
                ? props.canContinueMerge
                  ? "Continue merge"
                  : "Delivery approved"
                : props.canContinueMerge
                  ? "Approve delivery and continue merge"
                  : "Approve delivery"}
            </Button>
            {unresolved.length > 0 && (
              <Button
                size="sm"
                touch
                disabled={pending || executionBlocked || !note.trim()}
                loading={working === "waive-approve"}
                onClick={() => {
                  void act(
                    "waive-approve",
                    () => props.onApprove(true, note.trim()),
                    props.canContinueMerge
                      ? "Remaining evidence waived. Merge started."
                      : "Remaining evidence waived. Delivery approved.",
                  );
                }}
              >
                Waive remaining evidence and approve
                {props.canContinueMerge
                  ? " delivery and continue merge"
                  : " delivery"}
              </Button>
            )}
          </div>
          <p className="m-0 text-[0.7rem] text-text-tertiary">
            Approval applies to this delivery scope. Merge validation still runs
            before publication.
          </p>
        </div>
      )}
      {view.history.length > 0 && (
        <details className="border-x-0 border-t border-b-0 border-solid border-border-dim px-lg py-md text-[0.75rem] text-text-secondary">
          <summary className="cursor-pointer">
            Decision history · {view.history.length}
          </summary>
          <ol className="mb-0 grid gap-sm pl-lg">
            {view.history
              .slice()
              .reverse()
              .map((review) => (
                <li key={review.id}>
                  {review.criteria.length} criteria{" "}
                  {review.decision === "revoked"
                    ? "reopened"
                    : review.decision === "satisfied"
                      ? "marked satisfied"
                      : "waived"}{" "}
                  by you · {new Date(review.createdAt).toLocaleString()}
                  {review.note && <p className="mt-xs mb-0">{review.note}</p>}
                </li>
              ))}
          </ol>
        </details>
      )}
    </section>
  );
}

const outcomeLabel: Record<
  DeliveryReviewView["criteria"][number]["outcome"],
  string
> = {
  delivered: "Delivered",
  delivered_externally: "Delivered externally",
  proven: "Verified",
  satisfied: "Satisfied by you",
  waived: "Evidence waived",
  needs_review: "Needs review",
  excluded: "Outside this delivery",
};
const outcomeTone: Record<
  DeliveryReviewView["criteria"][number]["outcome"],
  StatusChipTone
> = {
  delivered: "green",
  delivered_externally: "green",
  proven: "green",
  satisfied: "cyan",
  waived: "amber",
  needs_review: "neutral",
  excluded: "neutral",
};
