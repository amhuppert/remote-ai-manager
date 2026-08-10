"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api/fetcher";
import {
  deliveryPlanReviewViewSchema,
  type DeliveryPlanReviewCriterion,
} from "@/lib/specs/delivery-plan-review";
import { specMutationPaths } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";

/**
 * The human reaffirm act on one soft-stale criterion. It is a control rather
 * than a plan edit because the plan lint refuses a `reaffirmed` disposition an
 * author asserted for themselves: this button reaches the production route
 * that records the actor, the basis revision, and the basis hashes the human
 * actually read.
 *
 * It renders only where it is legal — a soft-stale criterion still pending —
 * so the surface never offers an act the server would refuse.
 */
export function ReaffirmControl({
  projectName,
  slug,
  criterion,
}: {
  projectName: string;
  slug: string;
  criterion: DeliveryPlanReviewCriterion;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const reaffirm = useMutation({
    mutationFn: () =>
      apiFetch(
        specMutationPaths.specAction(projectName, slug, "plan-reaffirm"),
        deliveryPlanReviewViewSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            criterionElementId: criterion.criterionElementId,
          }),
        },
      ),
    onSuccess: (next) =>
      queryClient.setQueryData(specKeys.planReview(projectName, slug), next),
  });

  const pending =
    criterion.effectiveDisposition === "pending_reaffirmation" &&
    criterion.deliveryClass === "soft_stale";
  if (!pending) return null;

  return (
    <div className="flex flex-col gap-[2px]">
      <Button
        type="button"
        variant="default"
        size="sm"
        loading={reaffirm.isPending}
        onClick={() => reaffirm.mutate()}
      >
        Reaffirm {criterion.handle}
      </Button>
      {criterion.disposition === "reaffirmed" && (
        <span className="font-mono text-[0.66rem] text-amber">
          The earlier reaffirmation judged a basis that has since moved.
        </span>
      )}
      {reaffirm.isError && (
        <span className="font-mono text-[0.66rem] text-red">
          {reaffirm.error instanceof Error
            ? reaffirm.error.message
            : "The reaffirmation was not recorded."}
        </span>
      )}
    </div>
  );
}
