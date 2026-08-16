"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { FormGroup, FormInput, FormLabel } from "@/components/ui/FormField";
import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import { StatusChip } from "@/components/ui/StatusChip";
import { apiFetch } from "@/lib/api/fetcher";
import {
  deliveryPlanReviewViewSchema,
  type DeliveryPlanReviewComment,
  type DeliveryPlanReviewView,
} from "@/lib/specs/delivery-plan-review";
import { specMutationPaths } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";

/**
 * Binding-anchored review notes stay attached to the opaque accountability
 * source the signed sidecar names.
 */

function CommentRow({
  comment,
}: {
  comment: DeliveryPlanReviewComment;
}): React.JSX.Element {
  return (
    <li
      data-comment-id={comment.id}
      data-orphaned={comment.orphaned}
      className="flex flex-col gap-[2px] py-xs"
    >
      <div className="flex flex-wrap items-baseline gap-xs">
        <StatusChip tone={comment.orphaned ? "amber" : "neutral"}>
          {comment.contextId}
        </StatusChip>
        {comment.orphaned && (
          <span className="font-mono text-[0.66rem] text-amber">
            orphan anchor — this binding no longer declares that source
          </span>
        )}
        <span className="font-mono text-[0.66rem] text-text-tertiary">
          {comment.author.kind === "human" ? "operator" : "agent"} ·{" "}
          {comment.createdAt}
        </span>
      </div>
      <span className="font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        {comment.body}
      </span>
    </li>
  );
}

export default function SpecDeliveryPlanComments({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const slug = review.attempt.specSlug;
  const queryClient = useQueryClient();
  const anchors = review.document.binding.claims.map((claim) => ({
    contextId: claim.contextId,
    title: claim.criterionElementIds.join(", ") || "No criterion claims",
  }));
  const [contextId, setContextId] = useState(anchors[0]?.contextId ?? "");
  const [body, setBody] = useState("");

  const addComment = useMutation({
    mutationFn: (input: { contextId: string; body: string }) =>
      apiFetch(
        specMutationPaths.specAction(projectName, slug, "plan-comment"),
        deliveryPlanReviewViewSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(specKeys.planReview(projectName, slug), next);
      setBody("");
    },
  });

  return (
    <section aria-label="Binding comments">
      <ul className="m-0 list-none p-0">
        {review.comments.length === 0 ? (
          <li className="font-mono text-[0.7rem] text-text-tertiary">
            No one has commented on this attempt.
          </li>
        ) : (
          review.comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))
        )}
      </ul>

      {anchors.length > 0 && (
        <form
          className="mt-sm flex flex-col gap-xs"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim().length === 0) return;
            addComment.mutate({ contextId, body: body.trim() });
          }}
        >
          <FormGroup>
            <span className="mb-sm block font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
              Accountability source
            </span>
            <RadioGroup
              aria-label="Accountability source"
              value={contextId}
              onValueChange={setContextId}
            >
              {anchors.map((anchor) => (
                <RadioGroupOption
                  key={anchor.contextId}
                  value={anchor.contextId}
                  label={anchor.contextId}
                  description={anchor.title}
                />
              ))}
            </RadioGroup>
          </FormGroup>
          <FormGroup>
            <FormLabel htmlFor="plan-comment-body">Comment</FormLabel>
            <FormInput
              id="plan-comment-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="What this accountability source has to change"
            />
          </FormGroup>
          <div className="flex items-center gap-sm">
            <Button
              type="submit"
              variant="default"
              size="sm"
              loading={addComment.isPending}
              disabled={body.trim().length === 0}
            >
              Comment
            </Button>
            {addComment.isPending && (
              <span
                role="status"
                className="font-mono text-[0.68rem] text-text-tertiary"
              >
                Saving comment…
              </span>
            )}
            {addComment.isError && (
              <span className="font-mono text-[0.68rem] text-red">
                {addComment.error instanceof Error
                  ? addComment.error.message
                  : "The comment was not saved."}
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
