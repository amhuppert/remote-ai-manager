"use client";

import { planReviewFindingsCommand } from "@/lib/workflows/plan-review/status-schemas";

import Link from "next/link";

import { Button } from "@/components/ui/Button";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";
import { useSpecPlanReviewQuery } from "@/lib/specs/queries";
import {
  deliveryPlanMutationViewSchema,
  type DeliveryPlanMutationView,
} from "@/lib/specs/delivery-plan-views";

const lifecycleTone: Record<
  NonNullable<
    ReturnType<typeof useSpecPlanReviewQuery>["data"]
  >["attempt"]["status"],
  StatusChipTone
> = {
  draft: "cyan",
  proposed: "amber",
  approved: "green",
  parked: "amber",
  launched: "green",
  abandoned: "neutral",
};

function planBlocker(detail: SpecDetailView): string | null {
  const current = detail.currentRevision?.revision;
  const approved = detail.currentApprovedRevision?.revision;
  if (
    approved?.authoringStage !== "design" &&
    approved?.authoringStage !== "plan"
  ) {
    return "Delivery planning requires an approved Design revision.";
  }
  if (
    current &&
    current.number > approved.number &&
    (current.state === "draft" || current.state === "proposed")
  ) {
    return `${current.authoringStage} revision ${current.number} is ${current.state}. Settle or withdraw it before planning delivery.`;
  }
  return null;
}

export default function SpecDeliveryBridge({
  detail,
  projectName,
  onNavigate,
}: {
  detail: SpecDetailView;
  projectName: string;
  onNavigate?(href: string): void;
}): React.JSX.Element {
  const query = useSpecPlanReviewQuery(projectName, detail.spec.slug);
  const open = useSpecActionMutation<
    Record<string, never>,
    DeliveryPlanMutationView
  >(projectName, detail.spec.slug, "plan-open", deliveryPlanMutationViewSchema);
  const blocker = planBlocker(detail);

  if (query.isPending) {
    return <BridgeMessage>Reading delivery state…</BridgeMessage>;
  }
  if (query.isError) {
    return (
      <BridgeMessage tone="amber">
        {query.error instanceof Error
          ? query.error.message
          : "Delivery state could not be read."}
      </BridgeMessage>
    );
  }
  const review = query.data;
  if (review === null || review === undefined) {
    return (
      <section
        aria-label="Delivery plan"
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
      >
        <h3 className="m-0 font-display text-[0.95rem] font-bold text-text-primary">
          No delivery plan
        </h3>
        <p className="mt-xs mb-md font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
          {blocker ??
            "Create a delta-seeded delivery plan, then configure and review it in Workflow Builder."}
        </p>
        {blocker === null && (
          <Button
            variant="primary"
            size="sm"
            disabled={open.isPending}
            onClick={() =>
              open.mutate(
                {},
                {
                  onSuccess: (result) => {
                    if (onNavigate)
                      onNavigate(result.workflowDefinition.builderHref);
                    else
                      window.location.assign(
                        result.workflowDefinition.builderHref,
                      );
                  },
                },
              )
            }
          >
            {open.isPending ? "Creating…" : "Create delivery plan"}
          </Button>
        )}
        {open.error instanceof Error && (
          <p
            role="alert"
            className="mt-sm mb-0 font-mono text-[0.7rem] text-red"
          >
            {open.error.message}
          </p>
        )}
      </section>
    );
  }

  const totalScope = review.document.binding.dispositions.length;
  const launchedExecution =
    review.attempt.launchedExecutionId === null
      ? null
      : (detail.executions.find(
          (execution) => execution.id === review.attempt.launchedExecutionId,
        ) ?? null);
  const executionHref =
    launchedExecution?.sessionName === null || launchedExecution === null
      ? null
      : `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(launchedExecution.sessionName)}/workflow?execution=${encodeURIComponent(launchedExecution.id)}`;
  return (
    <section
      aria-label="Delivery plan"
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-lg"
    >
      <div className="flex flex-wrap items-center justify-between gap-md">
        <div>
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="m-0 font-display text-[0.95rem] font-bold text-text-primary">
              Delivery plan
            </h3>
            <StatusChip tone={lifecycleTone[review.attempt.status]}>
              {review.attempt.status === "proposed"
                ? "In review"
                : review.attempt.status}
            </StatusChip>
          </div>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            Pinned revision {review.attempt.pinnedRevisionId} · definition
            revision {review.workflowDefinition.revision} · {totalScope} scoped
            · {review.health.blocking} blocking
          </p>
          <p className="mt-xs mb-0 text-sm text-text-secondary">
            Plan review:{" "}
            {review.reviewStatus.state === "unreviewed"
              ? "none recorded for this revision"
              : review.reviewStatus.state.replaceAll("_", " ")}{" "}
            (advisory)
          </p>
          {review.reviewStatus.state !== "unreviewed" && (
            <p className="mt-xs mb-0 text-sm text-text-tertiary">
              {review.reviewStatus.reviewerConversationId} ·{" "}
              {review.reviewStatus.reviewedAt}
              <br />
              <code>{planReviewFindingsCommand()}</code>
            </p>
          )}
        </div>
        <Link
          href={review.workflowDefinition.builderHref}
          className="inline-flex h-[32px] items-center rounded-sm border border-solid border-cyan-dim bg-cyan-glow px-md font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:border-cyan"
        >
          Open in Workflow Builder
        </Link>
      </div>
      {review.attempt.status === "launched" &&
        review.attempt.launchedExecutionId !== null && (
          <div className="mt-md flex flex-wrap items-center justify-between gap-sm font-mono text-[0.7rem] text-text-secondary">
            <span>
              Execution {review.attempt.launchedExecutionId}
              {launchedExecution ? ` · ${launchedExecution.state}` : ""}
            </span>
            {executionHref === null ? (
              <span className="text-text-tertiary">
                Open it from the project execution list.
              </span>
            ) : (
              <Link
                href={executionHref}
                className="font-semibold text-cyan no-underline hover:underline"
              >
                Open execution
              </Link>
            )}
          </div>
        )}
    </section>
  );
}

function BridgeMessage({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "amber";
}): React.JSX.Element {
  return (
    <p
      className={
        tone === "amber"
          ? "m-0 font-mono text-[0.72rem] text-amber"
          : "m-0 font-mono text-[0.72rem] text-text-tertiary"
      }
    >
      {children}
    </p>
  );
}
