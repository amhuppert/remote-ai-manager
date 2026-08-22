"use client";

import "@/components/workflow-graph/workflow-graph.css";

import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import { StatusChip } from "@/components/ui/StatusChip";
import WorkflowDefinitionCanvas from "@/components/workflow-graph/WorkflowDefinitionCanvas";
import WorkflowFinalizedLaunchMetadata from "@/components/workflow-graph/WorkflowFinalizedLaunchMetadata";
import { useGlobalDefaults } from "@/hooks/use-global-defaults";
import { graphWorkflowLaunchName } from "@/lib/workflow-graph/launch-presentation";
import {
  deliveryPlanReviewViewSchema,
  type DeliveryPlanReviewView,
} from "@/lib/specs/delivery-plan-review";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { specKeys } from "@/lib/specs/query-keys";
import {
  useSpecPlanDiffQuery,
  useSpecPlanPreviewQuery,
  useSpecPlanReviewQuery,
} from "@/lib/specs/queries";
import type {
  DeliveryPlanPreviewStage,
  DeliveryPlanPreviewView,
} from "@/lib/specs/delivery-plan-views";

import SpecDeliveryPlanApproval from "./SpecDeliveryPlanApproval";
import SpecDeliveryPlanLaunch from "./SpecDeliveryPlanLaunch";
import SpecDeliveryPlanComments from "./SpecDeliveryPlanComments";

function AttemptHeader({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-xs">
        <StatusChip tone="cyan">{review.attempt.status}</StatusChip>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          attempt {review.attempt.id} · draft revision{" "}
          {review.attempt.draftRevision} · pinned revision{" "}
          {review.attempt.pinnedRevisionId}
        </span>
      </div>
      <p className="mt-xs mb-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
        Next: {review.nextAct.reason} <code>{review.nextAct.command}</code>
      </p>
    </header>
  );
}

function BindingTable({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  return (
    <section aria-label="Immutable delivery binding">
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Immutable delivery binding
      </h4>
      <ul className="m-0 list-none p-0">
        {review.criteria.map((criterion) => (
          <li
            key={criterion.criterionElementId}
            className="flex flex-wrap items-baseline gap-xs border-x-0 border-t-0 border-b border-solid border-border-subtle py-xs"
          >
            <code className="font-mono text-[0.68rem] text-text-primary">
              {criterion.handle}
            </code>
            <StatusChip tone="neutral">
              {criterion.disposition ?? "undisposed"}
            </StatusChip>
            <span className="font-mono text-[0.68rem] text-text-tertiary">
              accountability:{" "}
              {criterion.accountabilitySourceIds.join(", ") || "none"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LifecycleState({
  review,
}: {
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  return (
    <section aria-label="Plan lifecycle state">
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Lifecycle state
      </h4>
      <div className="flex flex-wrap items-center gap-xs">
        <StatusChip tone="cyan">{review.attempt.status}</StatusChip>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {review.health.blocking} blocking finding
          {review.health.blocking === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        {review.nextAct.reason}
      </p>
    </section>
  );
}

function CandidateChangeSummary({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const currentSnapshotIndex = review.snapshots.findIndex(
    (snapshot) => snapshot.id === review.attempt.proposedSnapshotId,
  );
  const currentSnapshot =
    currentSnapshotIndex >= 0
      ? review.snapshots[currentSnapshotIndex]
      : undefined;
  const previousSnapshot =
    currentSnapshotIndex > 0
      ? review.snapshots[currentSnapshotIndex - 1]
      : undefined;
  const diff = useSpecPlanDiffQuery(
    projectName,
    review.attempt.specSlug,
    previousSnapshot?.id ?? null,
    currentSnapshot?.id ?? null,
  );

  return (
    <section aria-label="Candidate change summary">
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Candidate change summary
      </h4>
      {previousSnapshot === undefined || currentSnapshot === undefined ? (
        <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary">
          No earlier finalized candidate is available for comparison.
        </p>
      ) : diff.isPending ? (
        <p
          role="status"
          className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-tertiary"
        >
          Comparing immutable candidates…
        </p>
      ) : diff.isError || diff.data === undefined ? (
        <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-amber">
          {diff.error instanceof Error
            ? diff.error.message
            : "The immutable candidate comparison could not be read."}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-xs">
          <StatusChip tone={diff.data.diff.launchChanged ? "amber" : "neutral"}>
            Launch {diff.data.diff.launchChanged ? "changed" : "unchanged"}
          </StatusChip>
          <StatusChip
            tone={diff.data.diff.bindingChanged ? "amber" : "neutral"}
          >
            Binding {diff.data.diff.bindingChanged ? "changed" : "unchanged"}
          </StatusChip>
        </div>
      )}
    </section>
  );
}

function BindingOutcomes({
  projectName,
  review,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
}): React.JSX.Element {
  const expectedDraftRevision = review.attempt.draftRevision;
  const waived = review.criteria.filter(
    (criterion) => criterion.disposition === "waived",
  );
  const externalDelivery = review.criteria.filter(
    (criterion) => criterion.disposition === "delivered_elsewhere",
  );
  const pendingReaffirmation = review.criteria.filter(
    (criterion) => criterion.disposition === "pending_reaffirmation",
  );
  const reaffirmed = review.criteria.filter(
    (criterion) => criterion.disposition === "reaffirmed",
  );
  // The act carries the draft revision this panel rendered, so a draft that
  // moved between the read and the click is refused rather than reaffirmed.
  const reaffirm = useSpecActionMutation<
    { criterionElementId: string; expectedDraftRevision: number },
    DeliveryPlanReviewView
  >(
    projectName,
    review.attempt.specSlug,
    "plan-reaffirm",
    deliveryPlanReviewViewSchema,
  );

  return (
    <>
      <section aria-label="Waivers">
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Waivers
        </h4>
        <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
          {waived.length === 0
            ? "No criteria are waived in this binding."
            : `Waived criteria: ${waived.map((criterion) => criterion.handle).join(", ")}.`}
        </p>
      </section>
      <section aria-label="External delivery">
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          External delivery
        </h4>
        {externalDelivery.length === 0 ? (
          <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            No criteria rely on an external delivery.
          </p>
        ) : (
          <ul className="m-0 list-none p-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            {externalDelivery.map((criterion) => (
              <li key={criterion.criterionElementId}>
                {criterion.handle} is attributed to{" "}
                {criterion.deliveredByExecutionId}.
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Pending reaffirmation">
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Pending reaffirmation
        </h4>
        {pendingReaffirmation.length === 0 ? (
          <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            No human reaffirmation is pending.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-xs p-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            {pendingReaffirmation.map((criterion) => {
              const isPending =
                reaffirm.isPending &&
                reaffirm.variables?.criterionElementId ===
                  criterion.criterionElementId;
              return (
                <li
                  key={criterion.criterionElementId}
                  className="flex flex-wrap items-center gap-xs"
                >
                  <span>
                    {criterion.handle} must reaffirm{" "}
                    {criterion.deliveredByExecutionId}.
                  </span>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    loading={isPending}
                    disabled={reaffirm.isPending}
                    onClick={() =>
                      reaffirm.mutate({
                        criterionElementId: criterion.criterionElementId,
                        expectedDraftRevision,
                      })
                    }
                  >
                    Reaffirm {criterion.handle}
                  </Button>
                  {isPending && (
                    <span role="status">Reaffirming {criterion.handle}…</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {reaffirm.isError && (
          <p className="mt-xs mb-0 font-mono text-[0.7rem] leading-relaxed text-red">
            {reaffirm.error instanceof Error
              ? reaffirm.error.message
              : "The criterion could not be reaffirmed."}
          </p>
        )}
      </section>
      <section aria-label="Reaffirmed delivery">
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Reaffirmed delivery
        </h4>
        {reaffirmed.length === 0 ? (
          <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            No external delivery has been reaffirmed in this draft.
          </p>
        ) : (
          <ul className="m-0 list-none p-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
            {reaffirmed.map((criterion) => (
              <li key={criterion.criterionElementId}>
                {criterion.handle} reaffirms {criterion.deliveredByExecutionId}.
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function PreviewStage({
  preview,
}: {
  preview: DeliveryPlanPreviewView;
}): React.JSX.Element {
  if (preview.stage === "draft") {
    return (
      <section aria-label="Authored draft">
        <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
          Authored draft
        </h4>
        <p className="m-0 font-mono text-[0.7rem] leading-relaxed text-text-secondary">
          Server finalization has not occurred. This launch has no candidate id
          or candidate hash.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Finalized candidate">
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        Finalized candidate
      </h4>
      <dl className="m-0 grid gap-xs font-mono text-[0.7rem] text-text-secondary">
        <div>
          <dt className="text-text-tertiary">candidate</dt>
          <dd className="m-0 break-all text-text-primary">
            {preview.candidateId}
          </dd>
        </div>
        <div>
          <dt className="text-text-tertiary">hash</dt>
          <dd className="m-0 break-all text-text-primary">
            {preview.candidateHash}
          </dd>
        </div>
      </dl>
      <WorkflowFinalizedLaunchMetadata launch={preview.launch} />
    </section>
  );
}

function previewStageFor(
  review: DeliveryPlanReviewView | null | undefined,
): DeliveryPlanPreviewStage | null {
  if (review === null || review === undefined) return null;
  return review.attempt.status === "draft" ||
    review.attempt.status === "abandoned"
    ? "draft"
    : "proposed";
}

/**
 * The two reads this surface composes must describe the same attempt state:
 * the graph and the finalized metadata come from the preview, while the
 * dispositions, comments, and lifecycle come from the review. A re-propose or
 * an edit landing between them would put a graph on screen that a sign-off is
 * not approving, so the mismatch is named rather than rendered.
 */
export function previewIdentityMismatch(
  review: DeliveryPlanReviewView,
  preview: DeliveryPlanPreviewView,
): string | null {
  if (preview.attemptId !== review.attempt.id) {
    return `The launch preview describes attempt ${preview.attemptId}, but the plan under review is attempt ${review.attempt.id}.`;
  }
  if (preview.draftRevision !== review.attempt.draftRevision) {
    return `The launch preview is at draft revision ${preview.draftRevision}, but the plan under review is at draft revision ${review.attempt.draftRevision}.`;
  }
  if (
    preview.candidateId !== review.attempt.candidateId ||
    preview.candidateHash !== review.attempt.candidateHash
  ) {
    return `The launch preview shows candidate ${preview.candidateId ?? "none"} at ${preview.candidateHash ?? "no hash"}, but the plan under review carries candidate ${review.attempt.candidateId ?? "none"} at ${review.attempt.candidateHash ?? "no hash"}.`;
  }
  return null;
}

function PlanConflict({
  projectName,
  slug,
  title,
  message,
}: {
  projectName: string;
  slug: string;
  title: string;
  message: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  return (
    <section
      aria-label="Delivery plan conflict"
      className="rounded-md border border-solid border-amber bg-bg-raised p-md"
    >
      <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
        {title}
      </h4>
      <p className="mt-0 mb-sm font-mono text-[0.7rem] leading-relaxed text-amber">
        {message}
      </p>
      <p className="mt-0 mb-sm font-mono text-[0.7rem] leading-relaxed text-text-secondary">
        Nothing was changed. Re-read the plan, then act on what you see.
      </p>
      <Button
        type="button"
        variant="default"
        size="sm"
        onClick={() => {
          void queryClient.invalidateQueries({
            queryKey: specKeys.detail(projectName, slug),
          });
        }}
      >
        Re-read the delivery plan
      </Button>
    </section>
  );
}

export function SpecDeliveryPlanReviewContent({
  projectName,
  review,
  preview,
}: {
  projectName: string;
  review: DeliveryPlanReviewView;
  preview: DeliveryPlanPreviewView;
}): React.JSX.Element {
  // The candidate is authored, not resolved: without the global tier its
  // contexts would show only the blocks they set themselves, and a workflow
  // that configures its crew once would preview with no crew at all.
  const { workflowDefaults } = useGlobalDefaults();
  const mismatch = previewIdentityMismatch(review, preview);
  if (mismatch !== null) {
    return (
      <div className="flex flex-col gap-lg">
        <AttemptHeader review={review} />
        <PlanConflict
          projectName={projectName}
          slug={review.attempt.specSlug}
          title="This plan moved while you were reading it"
          message={mismatch}
        />
      </div>
    );
  }

  // Sign-off binds the identity this surface displayed, read off the same
  // preview the graph and finalized metadata came from.
  const candidate =
    preview.candidateId === null || preview.candidateHash === null
      ? null
      : {
          candidateId: preview.candidateId,
          candidateHash: preview.candidateHash,
        };

  return (
    <div className="flex flex-col gap-lg">
      <AttemptHeader review={review} />
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)] gap-lg max-1180:grid-cols-1">
        <section
          aria-label="Graph launch"
          className="flex min-w-0 flex-col gap-sm"
        >
          <div>
            <h4 className="mt-0 mb-xs font-display text-[0.85rem] font-extrabold text-text-primary">
              Graph launch
            </h4>
            <p className="m-0 font-mono text-[0.7rem] text-text-secondary">
              {graphWorkflowLaunchName(preview.launch)}
            </p>
          </div>
          <WorkflowDefinitionCanvas
            launch={preview.launch}
            globalDefaults={workflowDefaults}
          />
        </section>
        <aside className="flex min-w-0 flex-col gap-lg">
          <PreviewStage preview={preview} />
          <LifecycleState review={review} />
          <CandidateChangeSummary projectName={projectName} review={review} />
          <SpecDeliveryPlanApproval
            projectName={projectName}
            review={review}
            candidate={candidate}
          />
          <SpecDeliveryPlanLaunch projectName={projectName} review={review} />
          <BindingTable review={review} />
          <BindingOutcomes projectName={projectName} review={review} />
          <SpecDeliveryPlanComments projectName={projectName} review={review} />
        </aside>
      </div>
    </div>
  );
}

export default function SpecDeliveryPlanReview({
  projectName,
  slug,
}: {
  projectName: string;
  slug: string;
}): React.JSX.Element {
  const query = useSpecPlanReviewQuery(projectName, slug);
  // The preview is read for the draft revision the review reported, so the
  // server refuses a preview of bytes this surface is not showing and a moved
  // draft re-reads instead of resolving from cache.
  const previewQuery = useSpecPlanPreviewQuery(
    projectName,
    slug,
    previewStageFor(query.data),
    query.data?.attempt.draftRevision ?? null,
  );
  if (query.isPending)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        Reading the delivery plan…
      </p>
    );
  if (query.isError || query.data === undefined)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        {query.error instanceof Error
          ? query.error.message
          : "The delivery plan could not be read."}
      </p>
    );
  if (query.data === null)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        This spec has no delivery plan attempt. Open one with cctl spec plan
        open {slug}.
      </p>
    );
  if (previewQuery.isPending)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        Reading the launch preview…
      </p>
    );
  // The preview is read for a stated draft revision, so its refusal is the
  // server's own stale-read conflict. It gets the re-read act rather than a
  // dead-end message.
  if (previewQuery.isError || previewQuery.data === undefined) {
    return (
      <PlanConflict
        projectName={projectName}
        slug={slug}
        title="The launch preview could not be read"
        message={
          previewQuery.error instanceof Error
            ? previewQuery.error.message
            : "The launch preview could not be read."
        }
      />
    );
  }
  return (
    <SpecDeliveryPlanReviewContent
      projectName={projectName}
      review={query.data}
      preview={previewQuery.data}
    />
  );
}
