"use client";

import { createClientLogger } from "@/lib/logging/client-logger";

import Link from "next/link";

import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/Collapsible";
import { Button } from "@/components/ui/Button";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";
import { useSpecPlanReviewQuery } from "@/lib/specs/queries";
import {
  deliveryPlanMutationViewSchema,
  type DeliveryPlanMutationView,
} from "@/lib/specs/delivery-plan-views";
import SpecPlanReaffirmation from "./SpecPlanReaffirmation";

const logger = createClientLogger("spec-studio-delivery-plan");

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
  launched: "cyan",
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
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg"
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
            touch
            onClick={() => {
              logger.info("spec_studio.delivery.plan_open_requested", {
                specId: detail.spec.id,
              });
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
              );
            }}
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
  const needsReaffirmation = review.criteria.some(
    ({ disposition }) => disposition === "pending_reaffirmation",
  );
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
  const pinnedRevision = detail.revisions.find(
    (revision) => revision.id === review.attempt.pinnedRevisionId,
  );
  return (
    <section
      aria-label="Delivery plan"
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg"
    >
      <div className="flex flex-wrap items-start justify-between gap-lg">
        <div className="grid gap-sm">
          <div className="flex flex-wrap items-center gap-sm">
            <h3 className="m-0 font-display text-[1.05rem] font-bold text-text-primary">
              Delivery plan
            </h3>
            <StatusChip
              tone={
                launchedExecution?.state === "delivered"
                  ? "green"
                  : launchedExecution?.state === "abandoned" ||
                      launchedExecution?.state === "abandoning"
                    ? "neutral"
                    : lifecycleTone[review.attempt.status]
              }
            >
              {launchedExecution
                ? launchedExecution.state.replaceAll("_", " ")
                : review.attempt.status === "proposed"
                  ? "In review"
                  : review.attempt.status}
            </StatusChip>
          </div>
          <p className="m-0 font-mono text-[0.78rem] leading-relaxed text-text-secondary">
            {launchedExecution?.state === "running"
              ? "Execution is running with its pinned scope."
              : needsReaffirmation
                ? "Reaffirm pending acceptance criteria below before plan review."
                : review.attempt.status === "launched"
                  ? "Inspect execution outcomes and remaining scope below."
                  : "Configure and review this plan in Workflow Builder."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          {executionHref !== null && (
            <Link href={executionHref} className={planLinkClass}>
              Open execution
            </Link>
          )}
          <Link
            href={review.workflowDefinition.builderHref}
            className={planLinkClass}
          >
            Open in Workflow Builder
          </Link>
        </div>
      </div>
      <dl className="mt-xl mb-0 grid grid-cols-4 gap-lg max-768:grid-cols-2">
        <PlanFact
          label="Pinned revision"
          value={
            pinnedRevision ? `Revision ${pinnedRevision.number}` : "Pinned"
          }
        />
        <PlanFact label="Criteria planned" value={String(totalScope)} />
        <PlanFact
          label="Plan blockers"
          value={String(review.health.blocking)}
          warning={review.health.blocking > 0}
        />
        <PlanFact
          label="Plan review · advisory"
          value={
            review.reviewStatus.state === "unreviewed"
              ? "Not reviewed"
              : review.reviewStatus.state.replaceAll("_", " ")
          }
        />
      </dl>
      <SpecPlanReaffirmation
        key={review.attempt.id}
        review={review}
        projectName={projectName}
        slug={detail.spec.slug}
        readOnly={detail.spec.abandonedAt !== null}
      />
      <Collapsible asChild>
        <div className="mt-lg border-x-0 border-t border-b-0 border-solid border-border-dim pt-md font-mono text-[0.7rem] text-text-secondary">
          <CollapsibleTrigger asChild>
            <Button size="sm" touch>
              Plan details
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-md grid gap-sm leading-relaxed [overflow-wrap:anywhere]">
              <span>
                Pinned revision {review.attempt.pinnedRevisionId} · definition
                revision {review.workflowDefinition.revision}
              </span>
              {review.attempt.launchedExecutionId && (
                <span>
                  Execution {review.attempt.launchedExecutionId}
                  {launchedExecution ? ` · ${launchedExecution.state}` : ""}
                </span>
              )}
              {review.attempt.launchedExecutionId && executionHref === null && (
                <span>Open it from the project execution list.</span>
              )}
              {review.reviewStatus.state !== "unreviewed" && (
                <span>
                  Reviewed by {review.reviewStatus.reviewerConversationId} ·{" "}
                  {review.reviewStatus.reviewedAt}
                </span>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
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

const planLinkClass =
  "inline-flex min-h-[36px] items-center rounded-md border border-solid border-border-default bg-bg-surface px-md font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]";

function PlanFact({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string;
  warning?: boolean;
}): React.JSX.Element {
  return (
    <div className="grid gap-sm">
      <dt className="text-[0.7rem] text-text-tertiary">{label}</dt>
      <dd
        data-warning={warning}
        className="m-0 font-mono text-[0.82rem] font-semibold text-text-primary data-[warning=true]:text-amber"
      >
        {value}
      </dd>
    </div>
  );
}
