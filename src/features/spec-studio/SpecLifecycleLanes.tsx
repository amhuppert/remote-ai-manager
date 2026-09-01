import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import type { SpecDetailView } from "@/lib/specs/queries";

const revisionTone: Record<
  "draft" | "proposed" | "approved" | "withdrawn",
  StatusChipTone
> = {
  draft: "cyan",
  proposed: "amber",
  approved: "green",
  withdrawn: "neutral",
};

const stateLabel = {
  draft: "Draft",
  proposed: "In review",
  approved: "Approved",
  withdrawn: "Withdrawn",
} as const;

export default function SpecLifecycleLanes({
  detail,
  deliveryPlan,
}: {
  detail: SpecDetailView;
  deliveryPlan: DeliveryPlanReviewView | null | undefined;
}): React.JSX.Element {
  const approved = detail.currentApprovedRevision?.revision ?? null;
  const current = detail.currentRevision?.revision ?? null;
  const extension =
    current && approved && current.id !== approved.id ? current : null;
  const execution = detail.executions.at(-1) ?? null;

  return (
    <section
      aria-label="Spec and delivery lifecycle"
      className="grid gap-2xs border-x-0 border-t-0 border-b border-solid border-border-dim bg-bg-base px-xl py-sm max-768:px-md"
    >
      <div
        role="group"
        aria-label="Spec lifecycle"
        className="flex min-h-[32px] flex-wrap items-center gap-sm"
      >
        <span className="w-[72px] font-mono text-[0.62rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
          Spec
        </span>
        {approved && (
          <span className="font-mono text-[0.7rem] text-text-secondary">
            Approved baseline · revision {approved.number}
          </span>
        )}
        {extension ? (
          <>
            <span className="text-text-tertiary" aria-hidden="true">
              →
            </span>
            <span className="font-mono text-[0.7rem] text-text-primary">
              {extension.authoringStage === "requirements"
                ? "Requirements extension"
                : "Design extension"}{" "}
              · revision {extension.number}
            </span>
            <StatusChip tone={revisionTone[extension.state]}>
              {stateLabel[extension.state]}
            </StatusChip>
          </>
        ) : current ? (
          <StatusChip tone={revisionTone[current.state]}>
            {stateLabel[current.state]}
          </StatusChip>
        ) : null}
      </div>

      <div
        role="group"
        aria-label="Delivery lifecycle"
        className="flex min-h-[32px] flex-wrap items-center gap-sm"
      >
        <span className="w-[72px] font-mono text-[0.62rem] font-semibold tracking-[0.1em] text-text-tertiary uppercase">
          Delivery
        </span>
        {deliveryPlan ? (
          <>
            <span className="font-mono text-[0.7rem] text-text-secondary">
              Candidate · pinned revision{" "}
              {deliveryPlan.attempt.pinnedRevisionId}
            </span>
            <StatusChip
              tone={
                deliveryPlan.attempt.status === "draft"
                  ? "cyan"
                  : deliveryPlan.attempt.status === "proposed"
                    ? "amber"
                    : deliveryPlan.attempt.status === "abandoned"
                      ? "neutral"
                      : "green"
              }
            >
              {deliveryPlan.attempt.status === "proposed"
                ? "In review"
                : deliveryPlan.attempt.status}
            </StatusChip>
          </>
        ) : (
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            No delivery candidate
          </span>
        )}
        {execution && (
          <>
            <span className="text-text-tertiary" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-[0.7rem] text-text-secondary">
              Execution {execution.id} · pinned revision {execution.revisionId}
            </span>
            <StatusChip
              tone={
                execution.state === "delivered"
                  ? "green"
                  : execution.state === "abandoned"
                    ? "neutral"
                    : "cyan"
              }
            >
              {execution.state}
            </StatusChip>
          </>
        )}
      </div>
    </section>
  );
}
