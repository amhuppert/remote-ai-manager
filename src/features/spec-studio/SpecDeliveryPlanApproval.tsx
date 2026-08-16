"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import { apiFetch } from "@/lib/api/fetcher";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import { deliveryPlanMutationViewSchema } from "@/lib/specs/delivery-plan-views";
import type {
  DeliveryPlanCriterionDisposition,
  FinalizedDeliveryPlanCandidateIdentity,
} from "@/lib/specs/delivery-plan";
import { specMutationPaths } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";

/**
 * The one human approval in the flow: plan sign-off. It states the exact
 * candidate identity it is about to bind and sends that identity to the
 * production candidate-bound route, so an approval can never land on bytes
 * other than the ones displayed (`exact-approval`). There is no second
 * approval path — the launch reads what this act approved.
 */

const DISPOSITION_LABEL: Record<DeliveryPlanCriterionDisposition, string> = {
  in_scope: "in scope",
  deferred: "deferred",
  waived: "waived",
  delivered_elsewhere: "delivered elsewhere",
  reaffirmed: "reaffirmed",
  pending_reaffirmation: "pending reaffirmation",
};

function HashLine({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-baseline gap-xs">
      <span className="font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
        {label}
      </span>
      <code className="font-mono text-[0.7rem] [overflow-wrap:anywhere] text-text-primary">
        {value}
      </code>
    </div>
  );
}

export default function SpecDeliveryPlanApproval({
  projectName,
  review,
  candidate,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
  /**
   * The identity the surface displayed, read off the same preview the graph
   * came from. Null while nothing is frozen. Passing it in rather than reading
   * it off the review is what keeps the approval on the bytes on screen.
   */
  candidate: FinalizedDeliveryPlanCandidateIdentity | null;
}): React.JSX.Element | null {
  const slug = review.attempt.specSlug;
  const queryClient = useQueryClient();
  const { approval } = review;
  const [signOffStarted, setSignOffStarted] = useState(false);

  const signOff = useMutation({
    mutationFn: (candidate: { candidateId: string; candidateHash: string }) =>
      apiFetch(
        specMutationPaths.specAction(projectName, slug, "plan-sign-off"),
        // The act answers with the plan mutation view. The panel does not
        // render it: it invalidates the review projection and re-reads, so one
        // owner stays the source of everything this surface shows.
        deliveryPlanMutationViewSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(candidate),
        },
      ),
    // A refusal means the candidate moved underneath the panel, so the panel
    // re-reads rather than leaving a stale hash on screen next to a refusal
    // about it.
    onSettled: () => {
      setSignOffStarted(false);
      void queryClient.invalidateQueries({
        queryKey: specKeys.planReview(projectName, slug),
      });
    },
  });

  // Nothing is frozen, so there is nothing to approve. The draft's own next act
  // (rendered by the attempt header) is what moves it forward.
  if (candidate === null) return null;

  const alreadyApproved =
    approval !== null && approval.candidateHash === candidate.candidateHash;
  const supersededApproval =
    approval !== null && approval.candidateHash !== candidate.candidateHash;

  const selected = review.criteria.filter(
    (criterion) => criterion.disposition === "in_scope",
  ).length;

  return (
    <section
      aria-label="Plan sign-off"
      className="rounded-md border border-solid border-border-subtle bg-bg-raised p-md"
    >
      <HashLine
        label="Approving candidate hash"
        value={candidate.candidateHash}
      />
      <HashLine label="Candidate" value={candidate.candidateId} />

      {supersededApproval && (
        <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-amber">
          A previous approval bound <code>{approval.candidateHash}</code>. The
          attempt was reopened and re-proposed, so that approval no longer
          stands and this candidate needs its own.
        </p>
      )}

      <p className="mt-sm mb-xs font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        Selected criteria: {selected}
      </p>
      <ul className="m-0 mb-sm flex list-none flex-wrap gap-xs p-0">
        {review.dispositionCounts.map((entry) => (
          <li key={entry.disposition}>
            <StatusChip tone="neutral">
              {DISPOSITION_LABEL[entry.disposition]} {entry.count}
            </StatusChip>
          </li>
        ))}
      </ul>

      {alreadyApproved ? (
        <p className="m-0 font-mono text-[0.7rem] text-green">
          This candidate is signed off; nothing else is owed before launch.
        </p>
      ) : (
        <div className="flex flex-col gap-xs">
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={signOffStarted || signOff.isPending}
            onClick={() => {
              setSignOffStarted(true);
              signOff.mutate(candidate);
            }}
          >
            Sign off this candidate
          </Button>
          {(signOffStarted || signOff.isPending) && (
            <span
              role="status"
              className="font-mono text-[0.68rem] text-text-tertiary"
            >
              Recording sign-off…
            </span>
          )}
          {signOff.isError && (
            <span className="font-mono text-[0.68rem] leading-relaxed text-red">
              {signOff.error instanceof Error
                ? signOff.error.message
                : "The sign-off was not recorded."}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
