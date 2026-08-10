"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  CriterionDeliveryClass,
  DeliveryDeltaElementClass,
  DeliveryDeltaProjection,
} from "@/lib/specs/delivery-delta";
import { useSpecDeltaQuery } from "@/lib/specs/queries";

/**
 * The delivery delta on the execution surface: what the last delivery no
 * longer covers, read from the same server projection `cctl spec delta`
 * renders. The panel computes no classification of its own — a second
 * derivation here is exactly how a Studio counter drifts from gate truth.
 */

const ELEMENT_CLASS_ORDER: readonly DeliveryDeltaElementClass[] = [
  "added",
  "amended",
  "removed",
  "unchanged",
];

const CRITERION_CLASS_ORDER: readonly CriterionDeliveryClass[] = [
  "hard_stale",
  "soft_stale",
  "never_delivered",
  "deferred",
  "waived",
  "delivered_and_fresh",
];

const ELEMENT_CLASS_TONE: Record<DeliveryDeltaElementClass, StatusChipTone> = {
  added: "cyan",
  amended: "amber",
  removed: "red",
  unchanged: "neutral",
};

const CRITERION_CLASS_TONE: Record<CriterionDeliveryClass, StatusChipTone> = {
  hard_stale: "red",
  soft_stale: "amber",
  never_delivered: "cyan",
  deferred: "neutral",
  waived: "violet",
  delivered_and_fresh: "green",
};

const CRITERION_CLASS_LABEL: Record<CriterionDeliveryClass, string> = {
  hard_stale: "hard-stale",
  soft_stale: "soft-stale",
  never_delivered: "never delivered",
  deferred: "deferred",
  waived: "waived",
  delivered_and_fresh: "delivered & fresh",
};

/** Studio shows every row; the 30-row cap is the CLI's readability bound. */
function ClassRow({
  label,
  tone,
  count,
  handles,
}: {
  label: string;
  tone: StatusChipTone;
  count: number;
  handles: readonly string[];
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-baseline gap-xs py-xs">
      <StatusChip tone={tone}>
        {label} {count}
      </StatusChip>
      <span className="font-mono text-[0.7rem] text-text-tertiary">
        {handles.length === 0 ? "none" : handles.join(", ")}
      </span>
    </li>
  );
}

function ComparisonHeader({
  projection,
}: {
  projection: DeliveryDeltaProjection;
}): React.JSX.Element {
  const compared = projection.comparedExecution;
  return (
    <p className="mt-0 mb-md font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
      {compared === null
        ? `Revision ${projection.current.revisionNumber} has no delivered execution to compare against, so every criterion is undelivered work.`
        : `Revision ${projection.current.revisionNumber} compared against execution ${compared.executionId}, which pinned revision ${projection.base?.revisionNumber ?? "unknown"}${
            compared.deliveredAt === null
              ? ""
              : ` and delivered ${compared.deliveredAt}`
          }.`}
    </p>
  );
}

export default function SpecDeliveryDeltaPanel({
  projectName,
  slug,
  sinceExecutionId,
}: {
  projectName: string;
  slug: string;
  sinceExecutionId?: string;
}): React.JSX.Element {
  const query = useSpecDeltaQuery(projectName, slug, sinceExecutionId);

  if (query.isPending) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        Reading the delivery delta…
      </p>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-red">
        The delivery delta could not be read. Reload this surface, or run{" "}
        <code>cctl spec delta {slug}</code> to see the server&apos;s reason.
      </p>
    );
  }

  const projection = query.data;
  return (
    <section aria-label="Delivery delta">
      <ComparisonHeader projection={projection} />

      <h3 className="mt-lg mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Criteria
      </h3>
      <ul className="m-0 list-none p-0">
        {CRITERION_CLASS_ORDER.map((criterionClass) => {
          const rows = projection.criteria.filter(
            (row) => row.class === criterionClass,
          );
          return (
            <ClassRow
              key={criterionClass}
              label={CRITERION_CLASS_LABEL[criterionClass]}
              tone={CRITERION_CLASS_TONE[criterionClass]}
              count={rows.length}
              handles={rows.map((row) => row.handle)}
            />
          );
        })}
      </ul>

      <h3 className="mt-lg mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Elements
      </h3>
      <ul className="m-0 list-none p-0">
        {ELEMENT_CLASS_ORDER.map((elementClass) => {
          const rows = projection.elements.filter(
            (row) => row.class === elementClass,
          );
          return (
            <ClassRow
              key={elementClass}
              label={elementClass}
              tone={ELEMENT_CLASS_TONE[elementClass]}
              count={rows.length}
              handles={rows.map((row) => row.handle)}
            />
          );
        })}
      </ul>

      {projection.advisories.length > 0 && (
        <>
          <h3 className="mt-lg mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
            Carry-forward advisories
          </h3>
          <ul className="m-0 list-none p-0">
            {projection.advisories.map((advisory) => (
              <li
                key={advisory.criterionElementId}
                className="flex flex-wrap items-baseline gap-xs py-xs"
              >
                <StatusChip
                  tone={
                    advisory.code === "delivered_elsewhere_refused"
                      ? "red"
                      : "amber"
                  }
                >
                  {advisory.handle}
                </StatusChip>
                <span className="font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
                  {advisory.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
