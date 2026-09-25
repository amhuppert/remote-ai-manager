"use client";

import { useMemo, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";

import { parseElementHandle } from "@/lib/specs/handles";
import {
  specQueries,
  type SpecDetailView,
  type SpecElementGetResponse,
} from "@/lib/specs/queries";
import type {
  SpecEvidenceRow,
  SpecProofVerdictRow,
  SpecRevisionSnapshot,
  SpecWaiverRow,
} from "@/lib/specs/schemas";
import { useSpecLintQuery, useSpecPlanReviewQuery } from "@/lib/specs/queries";

import SpecControlsPanel, { SpecGatePolicyPanel } from "./SpecControls";
import SpecCriterionEvidence from "./SpecCriterionEvidence";
import SpecDeliveryBridge from "./SpecDeliveryBridge";
import SpecDeliveryReviewPanel from "./SpecDeliveryReviewPanel";
import SpecDeliveryDeltaPanel from "./SpecDeliveryDeltaPanel";
import { SpecElementReader } from "./SpecElementReader";
import SpecHistoryPanel from "./SpecHistoryPanel";
import SpecLintSummary from "./SpecLintSummary";
import SpecPostLaunchCapture from "./SpecPostLaunchCapture";
import SpecQuestionsAssumptionsPanel, {
  blockingAssumptionIdsFromLint,
} from "./SpecQuestionsAssumptions";
import SpecReviewMode from "./SpecReviewMode";

export type DetailView =
  | "overview"
  | "requirements"
  | "design"
  | "delivery"
  | "gate-policy"
  | "history";

const views: ReadonlyArray<{ view: DetailView; label: string }> = [
  { view: "overview", label: "Overview" },
  { view: "requirements", label: "Requirements" },
  { view: "design", label: "Design" },
  { view: "delivery", label: "Delivery" },
  { view: "gate-policy", label: "Gate policy" },
  { view: "history", label: "History" },
];

const detailTabClass =
  "inline-flex min-h-[36px] cursor-pointer items-center whitespace-nowrap border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-0 font-mono text-[0.7rem] font-semibold text-text-tertiary outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 aria-[current=page]:border-cyan aria-[current=page]:text-text-primary max-768:min-h-[44px] max-768:px-sm";

export default function SpecDetailViews({
  detail,
  projectName,
  view,
  onViewChange,
  overviewHeader,
  overviewBanner,
  highlightedChangeId = null,
  targetHandle = null,
  onReviewComplete,
  children,
}: {
  detail: SpecDetailView;
  projectName: string;
  view: DetailView;
  onViewChange(view: DetailView): void;
  overviewHeader?: ReactNode;
  overviewBanner?: ReactNode;
  highlightedChangeId?: string | null;
  targetHandle?: string | null;
  onReviewComplete?(message: string): void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <>
      {overviewHeader}
      <nav
        aria-label="Spec views"
        data-appearance="underline"
        className="flex items-center gap-lg overflow-x-auto border-x-0 border-t-0 border-b border-solid border-border-dim pt-sm max-768:gap-xs"
      >
        {views.map((item) => (
          <button
            key={item.view}
            type="button"
            aria-label={item.label}
            aria-current={view === item.view ? "page" : undefined}
            onClick={() => onViewChange(item.view)}
            className={detailTabClass}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view === "overview" && (
        <div className="mt-md">
          {overviewBanner}
          {children}
          <div className="mt-xl">
            <SpecControlsPanel detail={detail} projectName={projectName} />
          </div>
        </div>
      )}
      {view === "requirements" && (
        <RequirementsSurface
          detail={detail}
          projectName={projectName}
          highlightedChangeId={highlightedChangeId}
          targetHandle={targetHandle}
          onReviewComplete={onReviewComplete}
        />
      )}
      {view === "design" && (
        <DesignSurface
          detail={detail}
          projectName={projectName}
          highlightedChangeId={highlightedChangeId}
          onReviewComplete={onReviewComplete}
        />
      )}
      {view === "delivery" && (
        <div className="mt-lg grid gap-xl">
          <SurfaceIntro
            title="Delivery"
            description="Review acceptance, choose how to finish the work, and approve delivery."
          />
          <SpecDeliveryDeltaPanel
            plan={
              <SpecDeliveryBridge detail={detail} projectName={projectName} />
            }
            detail={detail}
            projectName={projectName}
            slug={detail.spec.slug}
          />
          <SpecDeliveryReviewPanel
            projectName={projectName}
            slug={detail.spec.slug}
          />
          <SpecPostLaunchCapture detail={detail} projectName={projectName} />
        </div>
      )}
      {view === "gate-policy" && (
        <div className="mt-lg grid gap-xl">
          <SurfaceIntro
            title="Gate policy"
            description="Set the review requirements for authoring, execution, and delivery."
          />
          <SpecGatePolicyPanel detail={detail} projectName={projectName} />
        </div>
      )}
      {view === "history" && (
        <div className="mx-auto mt-lg max-w-[1000px]">
          <SurfaceIntro
            title="History"
            description="Revision, approval, withdrawn attempt, delivery candidate, and execution history."
          />
          <SpecHistoryPanel
            detail={detail}
            projectName={projectName}
            showHeading={false}
          />
        </div>
      )}
    </>
  );
}

function RequirementsSurface({
  detail,
  projectName,
  highlightedChangeId,
  targetHandle,
  onReviewComplete,
}: {
  detail: SpecDetailView;
  projectName: string;
  highlightedChangeId: string | null;
  targetHandle: string | null;
  onReviewComplete?: (message: string) => void;
}): React.JSX.Element {
  const lint = useSpecLintQuery(projectName, detail.spec.slug);
  const plan = useSpecPlanReviewQuery(projectName, detail.spec.slug);
  const snapshot = detail.currentRevision ?? detail.currentApprovedRevision;
  const criteria = useMemo(() => criterionDescriptors(snapshot), [snapshot]);
  const evidence = useQueries({
    queries: criteria.map((criterion) => ({
      ...specQueries.element(
        projectName,
        detail.spec.slug,
        criterion.handle,
        undefined,
        snapshot?.revision.id,
      ),
      enabled: snapshot !== null,
    })),
  });
  const proofById = new Map(
    criteria.map((criterion, index) => [
      criterion.elementId,
      elementProof(evidence[index]?.data),
    ]),
  );
  const activeExecution = detail.executions.find(
    (execution) =>
      execution.revisionId === snapshot?.revision.id &&
      (execution.state === "definition_review" ||
        execution.state === "running"),
  );
  const dispositions = new Map(
    detail.criterionDispositions
      .filter(
        (row) =>
          activeExecution !== undefined &&
          row.execution_id === activeExecution.id,
      )
      .map((row) => [row.criterion_element_id, row]),
  );
  const claims = new Map(
    (plan.data?.criteria ?? []).map((criterion) => [
      criterion.criterionElementId,
      criterion.accountabilitySourceIds,
    ]),
  );

  return (
    <div className="mt-lg grid gap-xl">
      {draftReviewView(detail) === "requirements" && (
        <SpecReviewMode
          detail={detail}
          projectName={projectName}
          highlightedChangeId={highlightedChangeId}
          onComplete={onReviewComplete}
        />
      )}
      <SpecLintSummary
        projectName={projectName}
        slug={detail.spec.slug}
        findings={lint.data?.findings ?? []}
        isPending={lint.isPending || lint.isFetching}
        error={lint.error instanceof Error ? lint.error.message : null}
      />
      <SpecElementReader
        detail={detail}
        kind="requirements"
        projectName={projectName}
        criterionEvidence={(criterion) => {
          if (criterion.version.payload.kind !== "criterion") return null;
          const proof = proofById.get(criterion.element.id);
          const disposition = dispositions.get(criterion.element.id);
          const owners = claims.get(criterion.element.id) ?? [];
          return (
            <div className="grid gap-xs">
              <SpecCriterionEvidence
                revisionApproved={snapshot?.revision.state === "approved"}
                disposition={disposition?.disposition ?? null}
                evidence={(proof?.evidence ?? []).map((record) => record.id)}
                currentVerdictCount={
                  proof?.verdicts.filter((verdict) => verdict.stale_at === null)
                    .length ?? 0
                }
                waiverCurrent={proof?.waiver?.stale === 0}
                validationKinds={
                  criterion.version.payload.validationStrategy.kinds
                }
                validationNote={
                  criterion.version.payload.validationStrategy.note
                }
              />
              {owners.length > 0 && (
                <p className="m-0 font-mono text-[0.68rem] text-text-tertiary">
                  Owned by workflow {owners.join(", ")}
                </p>
              )}
            </div>
          );
        }}
      />
      <div id="attention-register" className="mx-auto w-full max-w-[1100px]">
        <SpecQuestionsAssumptionsPanel
          detail={detail}
          projectName={projectName}
          targetHandle={targetHandle}
          blockingAssumptionIds={blockingAssumptionIdsFromLint(
            detail.assumptions,
            lint.data?.findings ?? [],
          )}
        />
      </div>
    </div>
  );
}

function DesignSurface({
  detail,
  projectName,
  highlightedChangeId,
  onReviewComplete,
}: {
  detail: SpecDetailView;
  projectName: string;
  highlightedChangeId: string | null;
  onReviewComplete?: (message: string) => void;
}): React.JSX.Element {
  const lint = useSpecLintQuery(projectName, detail.spec.slug);
  return (
    <div className="mt-lg grid gap-xl">
      {draftReviewView(detail) === "design" && (
        <SpecReviewMode
          detail={detail}
          projectName={projectName}
          highlightedChangeId={highlightedChangeId}
          onComplete={onReviewComplete}
        />
      )}
      <SpecLintSummary
        projectName={projectName}
        slug={detail.spec.slug}
        findings={lint.data?.findings ?? []}
        isPending={lint.isPending || lint.isFetching}
        error={lint.error instanceof Error ? lint.error.message : null}
      />
      <SpecElementReader
        detail={detail}
        kind="decisions"
        projectName={projectName}
      />
    </div>
  );
}

/**
 * The view that hosts review of the open draft: the one named by the draft's
 * authoring stage. An abandoned spec is read-only history, so it hosts none.
 */
function draftReviewView(
  detail: SpecDetailView,
): "requirements" | "design" | null {
  if (detail.spec.abandonedAt !== null || detail.draftReview === null) {
    return null;
  }
  const stage = detail.draftReview.snapshot.revision.authoringStage;
  return stage === "requirements" || stage === "design" ? stage : null;
}

function SurfaceIntro({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <header className="border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
      <h2 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
        {title}
      </h2>
      <p className="mt-xs mb-0 max-w-[760px] font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
        {description}
      </p>
    </header>
  );
}

interface CriterionDescriptor {
  elementId: string;
  handle: string;
}

function criterionDescriptors(
  snapshot: SpecRevisionSnapshot | null,
): CriterionDescriptor[] {
  if (snapshot === null) return [];
  const requirements = new Map(
    snapshot.elements.flatMap((entry) =>
      entry.version.payload.kind === "requirement" &&
      entry.element.number !== null
        ? [[entry.element.id, `R${entry.element.number}`] as const]
        : [],
    ),
  );
  return snapshot.elements.flatMap((entry) => {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      return [];
    }
    const parent = requirements.get(entry.element.parentElementId);
    return parent
      ? [
          {
            elementId: entry.element.id,
            handle: `${parent}.${entry.element.number}`,
          },
        ]
      : [];
  });
}

function elementProof(data: SpecElementGetResponse | undefined): {
  evidence: SpecEvidenceRow[];
  verdicts: SpecProofVerdictRow[];
  waiver: SpecWaiverRow | null;
} | null {
  if (!data || !("evidenceState" in data)) return null;
  return data.evidenceState[0] ?? null;
}

export function initialDetailViewForDeepLink(
  rawHandle: string | null,
  slug: string | undefined,
): DetailView {
  if (
    rawHandle === "execution_start" ||
    rawHandle === "delivery" ||
    rawHandle === "launch"
  ) {
    return "delivery";
  }
  if (rawHandle === null || slug === undefined) return "overview";
  try {
    const kind = parseElementHandle(rawHandle, slug).kind;
    if (
      kind === "question" ||
      kind === "assumption" ||
      kind === "requirement" ||
      kind === "criterion"
    ) {
      return "requirements";
    }
    if (kind === "decision") return "design";
    if (kind === "task") return "history";
    return "overview";
  } catch {
    return "overview";
  }
}
