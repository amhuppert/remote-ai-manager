"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type {
  DeliveryPlanContextChangeAspect,
  DeliveryPlanContextDiff,
  DeliveryPlanDocumentDiff,
} from "@/lib/specs/delivery-plan-diff";

/**
 * The semantic diff between two attempt snapshots, rendered. It shows what a
 * re-proposal moved in the plan's own vocabulary — contexts that appeared or
 * disappeared, the aspects a surviving context changed in, and every criterion
 * whose disposition moved — rather than a text diff a reviewer would have to
 * decode back into the same facts.
 */

const CONTEXT_CLASS_TONE: Record<
  DeliveryPlanContextDiff["class"],
  StatusChipTone
> = {
  added: "cyan",
  removed: "red",
  changed: "amber",
  unchanged: "neutral",
};

const ASPECT_LABEL: Record<DeliveryPlanContextChangeAspect, string> = {
  title: "title",
  context_type: "context type",
  acceptance_contract: "acceptance contract",
  criterion_ownership: "criterion ownership",
  proof_plan: "proof plan",
  tasks: "tasks",
  edges: "dependency edges",
};

export default function SpecDeliveryPlanDiff({
  diff,
  fromLabel,
  toLabel,
}: {
  diff: DeliveryPlanDocumentDiff;
  fromLabel: string;
  toLabel: string;
}): React.JSX.Element {
  const moved = diff.contexts.filter(
    (context) => context.class !== "unchanged",
  );
  return (
    <section aria-label="Snapshot diff">
      <p className="mt-0 mb-sm font-mono text-[0.7rem] text-text-tertiary">
        {fromLabel} → {toLabel}
      </p>

      <h4 className="mt-0 mb-xs font-display text-[0.78rem] font-extrabold text-text-primary">
        Contexts
      </h4>
      {moved.length === 0 ? (
        <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
          No context was added, removed, or changed.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {moved.map((context) => (
            <li
              key={context.contextId}
              data-diff-context={context.contextId}
              className="flex flex-wrap items-baseline gap-xs py-xs"
            >
              <StatusChip tone={CONTEXT_CLASS_TONE[context.class]}>
                {context.class}
              </StatusChip>
              <span className="font-mono text-[0.7rem] text-text-primary">
                {context.contextId}
              </span>
              <span className="font-mono text-[0.68rem] text-text-tertiary">
                {context.title}
              </span>
              {context.changed.length > 0 && (
                <span className="font-mono text-[0.66rem] text-text-tertiary">
                  changed:{" "}
                  {context.changed
                    .map((aspect) => ASPECT_LABEL[aspect])
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-md mb-xs font-display text-[0.78rem] font-extrabold text-text-primary">
        Dispositions
      </h4>
      {diff.dispositions.length === 0 ? (
        <p className="m-0 font-mono text-[0.7rem] text-text-tertiary">
          Every criterion carries the disposition it did before.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {diff.dispositions.map((change) => (
            <li
              key={change.criterionElementId}
              data-diff-criterion={change.criterionElementId}
              className="flex flex-wrap items-baseline gap-xs py-[2px] font-mono text-[0.7rem] text-text-tertiary"
            >
              <span className="text-text-primary">
                {change.criterionElementId}
              </span>
              <span>
                {change.from ?? "undisposed"} → {change.to ?? "undisposed"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
