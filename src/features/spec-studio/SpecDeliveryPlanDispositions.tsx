"use client";

import type { ReactNode } from "react";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  CriterionDeliveryClass,
  CriterionStalenessReason,
  DeliveryDeltaBasisElement,
} from "@/lib/specs/delivery-delta";
import type { DeliveryPlanDisposition } from "@/lib/specs/delivery-plan";
import type {
  DeliveryPlanReviewCriterion,
  DeliveryPlanReviewView,
} from "@/lib/specs/delivery-plan-review";

/**
 * The dispositions table and the candidate panel: what the plan says about
 * every pinned criterion, and the exact bytes an approval would bind. Both read
 * the server review projection and classify nothing — the delivery class and
 * the freshness basis below are the delta's own verdicts, rendered.
 */

const DISPOSITION_LABEL: Record<DeliveryPlanDisposition, string> = {
  selected: "selected",
  deferred: "deferred",
  waived: "waived",
  delivered_elsewhere: "delivered elsewhere",
  reaffirmed: "reaffirmed",
  pending_reaffirmation: "pending reaffirmation",
};

const DISPOSITION_TONE: Record<DeliveryPlanDisposition, StatusChipTone> = {
  selected: "cyan",
  deferred: "neutral",
  waived: "violet",
  delivered_elsewhere: "green",
  reaffirmed: "green",
  pending_reaffirmation: "amber",
};

const DELIVERY_CLASS_LABEL: Record<CriterionDeliveryClass, string> = {
  delivered_and_fresh: "delivered & fresh",
  soft_stale: "soft-stale",
  hard_stale: "hard-stale",
  never_delivered: "never delivered",
  deferred: "deferred",
  waived: "waived",
};

const DELIVERY_CLASS_TONE: Record<CriterionDeliveryClass, StatusChipTone> = {
  delivered_and_fresh: "green",
  soft_stale: "amber",
  hard_stale: "red",
  never_delivered: "cyan",
  deferred: "neutral",
  waived: "violet",
};

const STALENESS_REASON_LABEL: Record<CriterionStalenessReason, string> = {
  criterion_text: "criterion text",
  criterion_validation_strategy: "validation strategy",
  criterion_payload: "criterion payload",
  parent_requirement: "parent requirement",
  governing_decision: "governing decision",
};

const FRESHNESS_SUMMARY = {
  fresh: "Fresh against the compared delivery.",
  soft_stale:
    "Soft-stale: the criterion is unchanged, so one reaffirmation settles it.",
  hard_stale:
    "Hard-stale: the old proof proved different words, so re-prove it.",
} as const;

function basisSentence(basis: DeliveryDeltaBasisElement): string {
  return `${STALENESS_REASON_LABEL[basis.reason]} ${basis.handle} changed (${
    basis.baseHash ?? "absent"
  } → ${basis.currentHash ?? "absent"})`;
}

function FreshnessAdvisory({
  criterion,
}: {
  criterion: DeliveryPlanReviewCriterion;
}): React.JSX.Element {
  if (criterion.freshness === null) {
    return (
      <span className="font-mono text-[0.68rem] text-text-tertiary">
        No earlier delivery to compare.
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-[2px]">
      <span className="font-mono text-[0.68rem] text-text-secondary">
        {FRESHNESS_SUMMARY[criterion.freshness.grade]}
      </span>
      {criterion.freshness.basis.map((basis) => (
        <span
          key={`${basis.elementId}-${basis.reason}`}
          className="font-mono text-[0.66rem] text-text-tertiary"
        >
          {basisSentence(basis)}
        </span>
      ))}
    </div>
  );
}

const headerClass =
  "px-sm py-xs text-left font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase";
const cellClass =
  "border-x-0 border-b border-t-0 border-solid border-border-subtle px-sm py-sm align-top";

export function DeliveryPlanDispositionsTable({
  criteria,
  renderRowAction,
}: {
  criteria: readonly DeliveryPlanReviewCriterion[];
  /**
   * A per-criterion control the caller binds into the row. The table owns the
   * row identity so an act attaches to the same criterion the projection
   * classified, rather than to a second enumeration of the same list.
   */
  renderRowAction?: (criterion: DeliveryPlanReviewCriterion) => ReactNode;
}): React.JSX.Element {
  if (criteria.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        The pinned revision carries no criteria.
      </p>
    );
  }
  return (
    <section aria-label="Dispositions">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={headerClass}>Criterion</th>
            <th className={headerClass}>Disposition</th>
            <th className={headerClass}>Delivery</th>
            <th className={headerClass}>Owner</th>
            {renderRowAction !== undefined && (
              <th className={headerClass}>Act</th>
            )}
          </tr>
        </thead>
        <tbody>
          {criteria.map((criterion) => (
            <tr
              key={criterion.criterionElementId}
              data-criterion-row={criterion.criterionElementId}
            >
              <td className={cellClass}>
                <div className="flex flex-col gap-[2px]">
                  <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
                    {criterion.handle}
                  </span>
                  <span className="font-mono text-[0.68rem] leading-relaxed text-text-secondary">
                    {criterion.text}
                  </span>
                  {criterion.note !== null && (
                    <span className="font-mono text-[0.66rem] text-text-tertiary">
                      {criterion.note}
                    </span>
                  )}
                </div>
              </td>
              <td className={cellClass}>
                {criterion.effectiveDisposition === null ? (
                  <StatusChip tone="red">undisposed</StatusChip>
                ) : (
                  <StatusChip
                    tone={DISPOSITION_TONE[criterion.effectiveDisposition]}
                  >
                    {DISPOSITION_LABEL[criterion.effectiveDisposition]}
                  </StatusChip>
                )}
                {criterion.disposition !== null &&
                  criterion.disposition !== criterion.effectiveDisposition && (
                    <span className="mt-[2px] block font-mono text-[0.66rem] text-amber">
                      authored {DISPOSITION_LABEL[criterion.disposition]}, but
                      the basis that act judged has since moved
                    </span>
                  )}
                {criterion.reaffirmation !== null &&
                  criterion.disposition === criterion.effectiveDisposition && (
                    <span className="mt-[2px] block font-mono text-[0.66rem] text-text-tertiary">
                      reaffirmed against{" "}
                      {criterion.reaffirmation.basisRevisionId}
                    </span>
                  )}
              </td>
              <td className={cellClass}>
                <div className="flex flex-col gap-[4px]">
                  <StatusChip
                    tone={DELIVERY_CLASS_TONE[criterion.deliveryClass]}
                  >
                    {DELIVERY_CLASS_LABEL[criterion.deliveryClass]}
                  </StatusChip>
                  <FreshnessAdvisory criterion={criterion} />
                </div>
              </td>
              <td className={cellClass}>
                <span className="font-mono text-[0.7rem] text-text-tertiary">
                  {criterion.owningContextId ?? "unowned"}
                </span>
              </td>
              {renderRowAction !== undefined && (
                <td className={cellClass}>{renderRowAction(criterion)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function HashRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-baseline gap-xs py-[2px]">
      <span className="font-mono text-[0.65rem] tracking-wide text-text-tertiary uppercase">
        {label}
      </span>
      <code className="font-mono text-[0.7rem] [overflow-wrap:anywhere] text-text-primary">
        {value}
      </code>
    </li>
  );
}

export function DeliveryPlanCandidatePanel({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const { attempt, approval } = review;
  return (
    <section
      aria-label="Materialized candidate"
      className="rounded-md border border-solid border-border-subtle bg-bg-raised p-md"
    >
      {attempt.compiledDefinitionHash === null || attempt.planHash === null ? (
        <p className="m-0 font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
          This draft has frozen nothing, so there is no candidate to approve
          yet. Propose the plan with{" "}
          <code>cctl spec plan propose {attempt.specSlug}</code>.
        </p>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            <HashRow
              label="Compiled definition"
              value={attempt.compiledDefinitionHash}
            />
            <HashRow label="Plan" value={attempt.planHash} />
            {attempt.proposedSnapshotId !== null && (
              <HashRow label="Snapshot" value={attempt.proposedSnapshotId} />
            )}
          </ul>
          <p className="mt-sm mb-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
            {approval === null
              ? "No approval binds these bytes yet; a launch is refused until one does."
              : `Approved by a human operator at ${approval.approvedAt}, bound to candidate ${approval.candidateId}.`}
          </p>
        </>
      )}
    </section>
  );
}
