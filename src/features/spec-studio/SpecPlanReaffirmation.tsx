"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import { StatusChip } from "@/components/ui/StatusChip";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";
import {
  deliveryPlanReviewViewSchema,
  type DeliveryPlanReviewView,
} from "@/lib/specs/delivery-plan-review";

export default function SpecPlanReaffirmation({
  review,
  projectName,
  slug,
  readOnly,
}: {
  review: DeliveryPlanReviewView;
  projectName: string;
  slug: string;
  readOnly: boolean;
}): React.JSX.Element | null {
  const client = useQueryClient();
  const reaffirm = useSpecActionMutation<
    { expectedDraftRevision: number; criterionElementIds: string[] },
    DeliveryPlanReviewView
  >(projectName, slug, "plan-reaffirm-batch", deliveryPlanReviewViewSchema);
  const [selection, setSelection] = useState({
    revision: review.attempt.draftRevision,
    ids: new Set<string>(),
  });
  if (selection.revision !== review.attempt.draftRevision) {
    setSelection({ revision: review.attempt.draftRevision, ids: new Set() });
  }
  function applyReview(updated: DeliveryPlanReviewView) {
    client.setQueryData(specKeys.planReview(projectName, slug), updated);
    setSelection({ revision: updated.attempt.draftRevision, ids: new Set() });
  }
  const reaffirmAll = useMutation({
    mutationFn: async (criterionElementIds: string[]) => {
      let expectedDraftRevision = review.attempt.draftRevision;
      // Each request is bounded by the API's batch limit and guards the
      // revision returned by the preceding batch against concurrent edits.
      for (let offset = 0; offset < criterionElementIds.length; offset += 500) {
        const updated = await reaffirm.mutateAsync({
          expectedDraftRevision,
          criterionElementIds: criterionElementIds.slice(offset, offset + 500),
        });
        expectedDraftRevision = updated.attempt.draftRevision;
        applyReview(updated);
      }
    },
  });
  const busy = reaffirm.isPending || reaffirmAll.isPending;
  const error = reaffirmAll.error ?? reaffirm.error;
  const pending = review.criteria.filter(
    ({ disposition }) => disposition === "pending_reaffirmation",
  );
  const editable = !readOnly && review.attempt.status === "draft";
  const detailHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;

  if (pending.length === 0 && !reaffirm.isSuccess) return null;

  return (
    <section
      aria-label="Acceptance criteria reaffirmation"
      className="mt-lg grid min-w-0 gap-md rounded-md border border-solid border-border-default bg-bg-base p-lg [overflow-wrap:anywhere]"
    >
      {pending.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-sm">
            <h4 className="m-0 font-mono text-[0.82rem] font-semibold text-text-primary">
              Acceptance criteria need reaffirmation
            </h4>
            <StatusChip tone="amber">Pending · {pending.length}</StatusChip>
          </div>
          <p className="m-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
            Requirements or design changed after these criteria were delivered.
            Review the updated spec, then confirm which criteria are still
            satisfied by that earlier delivery. The plan cannot be proposed or
            started until these are resolved.
          </p>
          <div className="flex flex-wrap gap-md font-mono text-[0.72rem]">
            <Link
              href={`${detailHref}?view=requirements`}
              className={reviewLinkClass}
            >
              Review current requirements
            </Link>
            <Link
              href={`${detailHref}?view=design`}
              className={reviewLinkClass}
            >
              Review current design
            </Link>
          </div>
          {editable ? (
            <>
              <div className="flex flex-wrap items-center gap-sm">
                <Button
                  size="sm"
                  touch
                  disabled={busy}
                  onClick={() =>
                    setSelection({
                      revision: review.attempt.draftRevision,
                      ids: new Set(
                        pending
                          .slice(0, 500)
                          .map(({ criterionElementId }) => criterionElementId),
                      ),
                    })
                  }
                >
                  {pending.length > 500
                    ? "Select next 500"
                    : `Select all pending (${pending.length})`}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  touch
                  disabled={busy || selection.ids.size === 0}
                  onClick={() =>
                    setSelection({
                      revision: review.attempt.draftRevision,
                      ids: new Set(),
                    })
                  }
                >
                  Clear selection
                </Button>
              </div>
              <ul className="m-0 grid max-h-[360px] list-none gap-md overflow-y-auto p-xs">
                {pending.map((criterion) => (
                  <li key={criterion.criterionElementId}>
                    <CheckboxField
                      touch
                      aria-label={`Select ${criterion.handle}: ${criterion.text}`}
                      label={
                        <>
                          <span className="mr-sm text-text-secondary">
                            {criterion.handle}
                          </span>
                          <span>{criterion.text}</span>
                        </>
                      }
                      description={
                        criterion.deliveredByExecutionId
                          ? `Earlier delivery · ${criterion.deliveredByExecutionId}`
                          : undefined
                      }
                      checked={selection.ids.has(criterion.criterionElementId)}
                      disabled={
                        busy ||
                        (selection.ids.size >= 500 &&
                          !selection.ids.has(criterion.criterionElementId))
                      }
                      onCheckedChange={(checked) =>
                        setSelection((current) => {
                          const ids = new Set(current.ids);
                          if (checked === true)
                            ids.add(criterion.criterionElementId);
                          else ids.delete(criterion.criterionElementId);
                          return { ...current, ids };
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
              <div className="grid gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-md">
                <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
                  Reaffirming confirms the earlier delivery still satisfies the
                  selected criteria. For criteria that need more work, ask the
                  agent to include them in this delivery plan.
                </p>
                <div className="flex flex-wrap gap-sm">
                  <Button
                    variant="primary"
                    size="sm"
                    touch
                    layoutClassName="justify-self-start"
                    loading={reaffirm.isPending && !reaffirmAll.isPending}
                    disabled={busy || selection.ids.size === 0}
                    onClick={() => {
                      reaffirmAll.reset();
                      reaffirm.mutate(
                        {
                          expectedDraftRevision: review.attempt.draftRevision,
                          criterionElementIds: [...selection.ids],
                        },
                        {
                          onSuccess: applyReview,
                        },
                      );
                    }}
                  >
                    {reaffirm.isPending && !reaffirmAll.isPending
                      ? "Reaffirming…"
                      : selection.ids.size > 0
                        ? `Reaffirm selected (${selection.ids.size})`
                        : "Reaffirm selected"}
                  </Button>
                  <Button
                    size="sm"
                    touch
                    loading={reaffirmAll.isPending}
                    disabled={busy}
                    onClick={() =>
                      reaffirmAll.mutate(
                        pending.map(
                          ({ criterionElementId }) => criterionElementId,
                        ),
                      )
                    }
                  >
                    {reaffirmAll.isPending
                      ? "Reaffirming all…"
                      : `Reaffirm all (${pending.length})`}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="m-0 font-mono text-[0.72rem] text-text-secondary">
              {readOnly
                ? "This spec is abandoned. Its delivery plan is read-only."
                : "Reopen this plan as a draft in Workflow Builder to reaffirm criteria."}
            </p>
          )}
        </>
      )}
      {reaffirm.isSuccess && !busy && !error && (
        <p
          role="status"
          className="m-0 font-mono text-[0.72rem] leading-relaxed text-green"
        >
          {reaffirmAll.isSuccess
            ? "All pending criteria reaffirmed."
            : "Selected criteria reaffirmed."}
          {pending.length === 0
            ? " Continue plan review in Workflow Builder. Plan approval is still required before execution."
            : " Review the remaining pending criteria."}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="m-0 font-mono text-[0.72rem] leading-relaxed text-red"
        >
          {error.message}
        </p>
      )}
    </section>
  );
}

const reviewLinkClass =
  "text-cyan underline underline-offset-2 hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";
