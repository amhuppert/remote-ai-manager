"use client";

import { useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { parseElementHandle } from "@/lib/specs/handles";
import {
  specQueries,
  type SpecDetailView,
  type SpecElementGetResponse,
} from "@/lib/specs/queries";
import type {
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

import {
  SpecEvidencePanel,
  SpecLintPanel,
  TraceabilityGraph,
  type CriterionProofView,
  type TraceabilityInput,
} from "./SpecEvidenceLintTrace";
import SpecControlsPanel, { SpecIntegrityPanel } from "./SpecControls";
import SpecDeliveryDeltaPanel from "./SpecDeliveryDeltaPanel";
import SpecDeliveryPlanReview from "./SpecDeliveryPlanReview";
import { SpecElementReader } from "./SpecElementReader";
import SpecHistoryPanel from "./SpecHistoryPanel";
import SpecQuestionsAssumptionsPanel from "./SpecQuestionsAssumptions";
import SpecReviewMode, { reviewAttentionCount } from "./SpecReviewMode";

export type DetailView =
  | "overview"
  | "history"
  | "plan"
  | "evidence"
  | "lint"
  | "traceability"
  | "questions"
  | "integrity"
  | "review"
  | "execution"
  | "gate"
  | "requirements"
  | "decisions"
  | "tasks";

interface CriterionDescriptor {
  elementId: string;
  handle: string;
  text: string;
  validationStrategy: Extract<
    SpecRevisionElement["version"]["payload"],
    { kind: "criterion" }
  >["validationStrategy"];
}

export interface EvidenceRevisionTarget {
  snapshot: SpecRevisionSnapshot;
  source: "pinned" | "approved";
  executionId: string | null;
}

const detailTabClass =
  "inline-flex cursor-pointer items-center gap-xs whitespace-nowrap border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-0 py-xs font-mono text-[0.7rem] font-semibold text-text-tertiary transition-colors duration-150 ease-[ease] outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 aria-[current=page]:border-cyan aria-[current=page]:text-text-primary max-768:min-h-[44px] max-768:px-sm";

type PrimaryView =
  | "overview"
  | "review"
  | "questions"
  | "plan"
  | "execution"
  | "gate"
  | "history";

const primaryViews: ReadonlyArray<{ view: PrimaryView; label: string }> = [
  { view: "overview", label: "Overview" },
  { view: "review", label: "Review" },
  { view: "questions", label: "Questions & assumptions" },
  { view: "plan", label: "Delivery plan" },
  { view: "execution", label: "Execution" },
  { view: "gate", label: "Gate policy" },
  { view: "history", label: "History" },
];

type InspectionView =
  | "requirements"
  | "decisions"
  | "tasks"
  | "evidence"
  | "traceability"
  | "lint"
  | "integrity";

const inspectionPresentation: Record<
  Exclude<InspectionView, "requirements" | "decisions" | "tasks">,
  { title: string; description: string; layoutClassName: string }
> = {
  evidence: {
    title: "Evidence by acceptance criterion",
    description:
      "Proof is evaluated against each criterion's approved validation strategy.",
    layoutClassName: "max-w-[1080px]",
  },
  traceability: {
    title: "Traceability",
    description: "Requirement → criteria → tasks",
    layoutClassName: "max-w-[1300px]",
  },
  lint: {
    title: "Deterministic lint",
    description: "Inspect the exact findings that gate proposal and sign-off.",
    layoutClassName: "max-w-[1000px]",
  },
  integrity: {
    title: "Spec integrity",
    description:
      "Approved revisions are re-hashed and compared with their immutable approval hashes.",
    layoutClassName: "max-w-[900px]",
  },
};

export default function SpecDetailViews({
  detail,
  projectName,
  view,
  onViewChange,
  overviewHeader,
  overviewBanner,
  highlightedChangeId = null,
  addressedRevisionId = null,
  onReviewComplete,
  children,
}: {
  detail: SpecDetailView;
  projectName: string;
  /**
   * The active surface, owned by the URL. Keeping it a prop rather than local
   * state is what makes every in-page deep link land: a navigation selection and an
   * `?el=`/`?view=` link are the same operation, so neither can go stale
   * against the other.
   */
  view: DetailView;
  onViewChange(view: DetailView): void;
  overviewHeader?: ReactNode;
  overviewBanner?: ReactNode;
  highlightedChangeId?: string | null;
  /** The proposal a History or lifecycle link addressed (`?revision=`). */
  addressedRevisionId?: string | null;
  onReviewComplete?(message: string): void;
  children: ReactNode;
}): React.JSX.Element {
  const evidenceTarget = useMemo(
    () => selectEvidenceRevision(detail),
    [detail],
  );
  const traceSnapshot = evidenceTarget?.snapshot ?? detail.currentRevision;
  const criteria = useMemo(
    () => criterionDescriptors(evidenceTarget?.snapshot ?? null),
    [evidenceTarget],
  );
  const needsEvidence = view === "evidence" || view === "traceability";
  const needsLint = view === "lint" || view === "traceability";
  const elementQueries = useQueries({
    queries: criteria.map((criterion) => ({
      ...specQueries.element(
        projectName,
        detail.spec.slug,
        criterion.handle,
        undefined,
        evidenceTarget?.snapshot.revision.id,
      ),
      enabled: needsEvidence,
    })),
  });
  const lintQuery = useQuery({
    ...specQueries.lint(projectName, detail.spec.slug),
    enabled: needsLint,
  });
  const proofViews = criteria.map((criterion, index) =>
    toCriterionProofView(criterion, elementQueries[index]),
  );
  const lintFindings = lintQuery.data?.findings ?? [];
  const traceabilityInput = buildTraceabilityInput(
    detail,
    traceSnapshot,
    projectName,
    proofViews,
    lintFindings,
  );

  return (
    <>
      {overviewHeader}
      <PrimaryViewNavigation
        detail={detail}
        view={view}
        onViewChange={onViewChange}
      />
      <InspectionNavigation view={view} onViewChange={onViewChange} />

      {view === "overview" && (
        <div className="mt-md">
          {overviewBanner}
          {children}
        </div>
      )}
      {view === "review" && (
        <div className="mt-lg">
          <SpecReviewMode
            detail={detail}
            projectName={projectName}
            highlightedChangeId={highlightedChangeId}
            addressedRevisionId={addressedRevisionId}
            onComplete={onReviewComplete}
          />
        </div>
      )}
      {view === "questions" && (
        <div className="mx-auto mt-lg max-w-[1100px]">
          <SurfaceIntro
            title="Questions & assumptions"
            description="Resolve open questions and explicitly confirm, reject, or defer assumptions."
          />
          <SpecQuestionsAssumptionsPanel
            detail={detail}
            projectName={projectName}
          />
        </div>
      )}
      {view === "plan" && (
        <div className="mt-lg">
          <SurfaceIntro
            title="Delivery plan"
            description="The attempt that becomes this execution's graph: its contexts, the criteria each one owns, and the exact candidate a sign-off approves."
          />
          <SpecDeliveryPlanReview
            projectName={projectName}
            slug={detail.spec.slug}
          />
        </div>
      )}
      {view === "execution" && (
        <div className="mt-lg">
          <SpecControlsPanel
            detail={detail}
            projectName={projectName}
            surface="execution"
          />
          <div className="mt-lg">
            <SurfaceIntro
              title="Delivery delta"
              description="What the last delivery no longer covers: element and criterion classes computed at read time against that execution's pinned revision. This is the authoring input for the next execution's delivery plan."
            />
            <SpecDeliveryDeltaPanel
              projectName={projectName}
              slug={detail.spec.slug}
            />
          </div>
        </div>
      )}
      {view === "gate" && (
        <div className="mt-lg">
          <SpecControlsPanel
            detail={detail}
            projectName={projectName}
            surface="gate"
          />
        </div>
      )}
      {view === "history" && (
        <div className="mx-auto mt-lg max-w-[1000px]">
          <SurfaceIntro
            title="History"
            description="Human decisions are recorded separately from policy admissions and execution lifecycle events."
          />
          <SpecHistoryPanel
            detail={detail}
            projectName={projectName}
            showHeading={false}
          />
        </div>
      )}
      {view === "evidence" && (
        <InspectionSurface view="evidence">
          <SpecEvidencePanel
            criteria={proofViews}
            dispositions={detail.criterionDispositions.filter(
              (row) =>
                evidenceTarget?.executionId !== null &&
                row.execution_id === evidenceTarget?.executionId,
            )}
            // The delivery projection names these over the current approved
            // revision, so they only describe the criteria on screen while that
            // is the revision being read; an execution-pinned older one is
            // outside what the projection speaks for.
            deliveredExternallyCriterionIds={
              evidenceTarget?.snapshot.revision.id ===
              detail.currentApprovedRevision?.revision.id
                ? detail.status.delivery.deliveredExternallyCriterionIds
                : []
            }
            revisionLabel={
              evidenceTarget === null
                ? null
                : `${evidenceTarget.source === "pinned" ? "Pinned" : "Approved"} revision ${evidenceTarget.snapshot.revision.number}`
            }
            emptyMessage={
              evidenceTarget === null
                ? "No approved revision is available for proof evaluation."
                : undefined
            }
            showHeading={false}
          />
        </InspectionSurface>
      )}
      {view === "traceability" && (
        <InspectionSurface view="traceability">
          <TraceabilityGraph input={traceabilityInput} showHeading={false} />
        </InspectionSurface>
      )}
      {view === "lint" && (
        <InspectionSurface view="lint" hideIntro>
          <SpecLintPanel
            projectName={projectName}
            slug={detail.spec.slug}
            revisionId={lintQuery.data?.revisionId ?? null}
            findings={lintFindings}
            isPending={lintQuery.isPending || lintQuery.isFetching}
            error={
              lintQuery.error instanceof Error ? lintQuery.error.message : null
            }
          />
        </InspectionSurface>
      )}
      {view === "integrity" && (
        <InspectionSurface view="integrity">
          <SpecIntegrityPanel detail={detail} projectName={projectName} />
        </InspectionSurface>
      )}
      {(view === "requirements" ||
        view === "decisions" ||
        view === "tasks") && (
        <div className="mt-lg">
          <SpecElementReader
            detail={detail}
            kind={view}
            projectName={projectName}
          />
        </div>
      )}
    </>
  );
}

function SurfaceIntro({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <header className="mb-lg border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
      <h2 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
        {title}
      </h2>
      <p className="mt-xs mb-0 max-w-[760px] font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
        {description}
      </p>
    </header>
  );
}

function InspectionSurface({
  view,
  hideIntro = false,
  children,
}: {
  view: Exclude<InspectionView, "requirements" | "decisions" | "tasks">;
  hideIntro?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const presentation = inspectionPresentation[view];
  return (
    <section className={cn("mx-auto mt-lg", presentation.layoutClassName)}>
      {!hideIntro && (
        <SurfaceIntro
          title={presentation.title}
          description={presentation.description}
        />
      )}
      {children}
    </section>
  );
}

function primaryViewFor(view: DetailView): PrimaryView | null {
  return primaryViews.some((item) => item.view === view)
    ? (view as PrimaryView)
    : null;
}

function questionAttentionCount(detail: SpecDetailView): number {
  if (detail.spec.abandonedAt !== null) return 0;
  return (
    detail.questions.filter((question) => question.status === "open").length +
    detail.assumptions.filter(
      (assumption) => assumption.disposition === "proposed",
    ).length
  );
}

function PrimaryViewNavigation({
  detail,
  view,
  onViewChange,
}: {
  detail: SpecDetailView;
  view: DetailView;
  onViewChange(view: DetailView): void;
}): React.JSX.Element {
  const activeView = primaryViewFor(view);
  const attentionCounts: Partial<Record<PrimaryView, number>> = {
    review: reviewAttentionCount(detail),
    questions: questionAttentionCount(detail),
  };

  return (
    <nav
      aria-label="Spec views"
      data-appearance="underline"
      className="flex items-center gap-lg pt-sm max-768:w-full max-768:gap-xs max-768:overflow-x-auto"
    >
      {primaryViews.map((item) => {
        const attentionCount = attentionCounts[item.view] ?? 0;
        const attentionId = `spec-view-${item.view}-attention`;
        return (
          <button
            key={item.view}
            type="button"
            aria-label={item.label}
            aria-describedby={attentionCount > 0 ? attentionId : undefined}
            aria-current={activeView === item.view ? "page" : undefined}
            onClick={() => onViewChange(item.view)}
            className={detailTabClass}
          >
            {item.label}
            {attentionCount > 0 && (
              <span
                id={attentionId}
                className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-amber-glow px-2xs text-[0.6rem] font-bold text-amber"
              >
                <span aria-hidden="true">{attentionCount}</span>
                <span className="sr-only">
                  {attentionCount}{" "}
                  {attentionCount === 1
                    ? "item needs attention"
                    : "items need attention"}
                </span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

const inspectionLinkClass =
  "min-h-[28px] cursor-pointer rounded-sm border border-solid border-transparent bg-transparent px-sm font-mono text-[0.66rem] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 aria-[current=page]:border-border-default aria-[current=page]:bg-bg-raised aria-[current=page]:text-text-primary max-768:min-h-[44px]";

function InspectionNavigation({
  view,
  onViewChange,
}: {
  view: DetailView;
  onViewChange(view: DetailView): void;
}): React.JSX.Element {
  const items: Array<{ view: InspectionView; label: string }> = [
    { view: "requirements", label: "Requirements" },
    { view: "decisions", label: "Decisions" },
    { view: "tasks", label: "Tasks" },
    { view: "evidence", label: "Evidence" },
    { view: "traceability", label: "Traceability" },
    { view: "lint", label: "Lint" },
    { view: "integrity", label: "Integrity" },
  ];
  return (
    <nav
      aria-label="Spec inspection"
      className="flex items-center gap-xs overflow-x-auto border-x-0 border-t border-b-0 border-solid border-border-dim py-xs"
    >
      <span className="shrink-0 px-xs font-mono text-[0.62rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Inspect
      </span>
      {items.map((item) => (
        <button
          key={item.view}
          type="button"
          aria-current={view === item.view ? "page" : undefined}
          className={inspectionLinkClass}
          onClick={() => onViewChange(item.view)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

// Q/A records render only in the focused Questions surface, so a
// ?el=Q1/?el=A1 deep link must open it or its scroll/focus target never mounts.
export function initialDetailViewForDeepLink(
  rawHandle: string | null,
  slug: string | undefined,
): DetailView {
  if (rawHandle === "execution_start") return "execution";
  // The delivery-approval deep link (notification rows, halt cards, banner,
  // phase CTA) must open Execution or its merge-gate target never mounts.
  if (rawHandle === "delivery") return "execution";
  if (rawHandle === null || slug === undefined) return "overview";
  try {
    const kind = parseElementHandle(rawHandle, slug).kind;
    if (kind === "question" || kind === "assumption") return "questions";
    if (kind === "requirement" || kind === "criterion") return "requirements";
    if (kind === "decision") return "decisions";
    if (kind === "task") return "tasks";
    return "overview";
  } catch {
    return "overview";
  }
}

export function selectEvidenceRevision(
  detail: SpecDetailView,
): EvidenceRevisionTarget | null {
  const snapshots = [
    detail.currentRevision,
    detail.baseRevision,
    detail.currentApprovedRevision,
    ...detail.executionRevisionSnapshots,
  ].filter((snapshot): snapshot is SpecRevisionSnapshot => snapshot !== null);
  const activeExecution = detail.executions.find(
    (execution) =>
      execution.state === "definition_review" || execution.state === "running",
  );
  if (activeExecution !== undefined) {
    const pinned = snapshots.find(
      (snapshot) => snapshot.revision.id === activeExecution.revisionId,
    );
    if (pinned?.revision.state === "approved") {
      return {
        snapshot: pinned,
        source: "pinned",
        executionId: activeExecution.id,
      };
    }
  }
  if (detail.currentApprovedRevision === null) return null;
  return {
    snapshot: detail.currentApprovedRevision,
    source: "approved",
    executionId: null,
  };
}

function criterionDescriptors(
  snapshot: SpecRevisionSnapshot | null,
): CriterionDescriptor[] {
  if (snapshot === null) return [];
  const requirements = new Map(
    snapshot.elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "requirement" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [[entry.element.id, `R${entry.element.number}`] as const];
    }),
  );

  return snapshot.elements.flatMap((entry): CriterionDescriptor[] => {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      return [];
    }
    const requirementHandle = requirements.get(entry.element.parentElementId);
    if (requirementHandle === undefined) return [];
    return [
      {
        elementId: entry.element.id,
        handle: `${requirementHandle}.${entry.element.number}`,
        text: entry.version.payload.text,
        validationStrategy: entry.version.payload.validationStrategy,
      },
    ];
  });
}

function toCriterionProofView(
  descriptor: CriterionDescriptor,
  query:
    | {
        data?: SpecElementGetResponse;
        isPending: boolean;
        isFetching: boolean;
        error: unknown;
      }
    | undefined,
): CriterionProofView {
  // Criterion handles always resolve to revision elements; the Q/A branch of
  // the union carries no evidence state.
  const state =
    query?.data !== undefined && "evidenceState" in query.data
      ? query.data.evidenceState.find(
          (candidate) => candidate.criterionElementId === descriptor.elementId,
        )
      : undefined;
  return {
    ...descriptor,
    evidence: state?.evidence ?? [],
    verdicts: state?.verdicts ?? [],
    waiver: state?.waiver ?? null,
    isPending: query?.isPending === true || query?.isFetching === true,
    error: query?.error instanceof Error ? query.error.message : null,
  };
}

function buildTraceabilityInput(
  detail: SpecDetailView,
  snapshot: SpecRevisionSnapshot | null,
  projectName: string,
  criteria: CriterionProofView[],
  findings: TraceabilityInput["findings"],
): TraceabilityInput {
  const elements = snapshot?.elements ?? [];
  const criteriaByRequirement = new Map<string, string[]>();
  for (const criterion of elements) {
    if (
      criterion.version.payload.kind !== "criterion" ||
      criterion.element.parentElementId === null
    ) {
      continue;
    }
    const ids =
      criteriaByRequirement.get(criterion.element.parentElementId) ?? [];
    ids.push(criterion.element.id);
    criteriaByRequirement.set(criterion.element.parentElementId, ids);
  }

  return {
    projectName,
    slug: detail.spec.slug,
    requirements: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "requirement" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `R${entry.element.number}`,
          label: entry.version.payload.statement,
          criterionElementIds:
            criteriaByRequirement.get(entry.element.id) ?? [],
          approval:
            detail.elementStatuses.requirements.find(
              (status) => status.elementId === entry.element.id,
            )?.status.approval ?? "unapproved",
        },
      ];
    }),
    decisions: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "decision" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `D${entry.element.number}`,
          label: entry.version.payload.title,
          tracedRequirementElementIds:
            entry.version.payload.tracedRequirementElementIds,
        },
      ];
    }),
    tasks: elements.flatMap((entry) => {
      if (
        entry.version.payload.kind !== "task" ||
        entry.element.number === null
      ) {
        return [];
      }
      return [
        {
          elementId: entry.element.id,
          handle: `T${entry.element.number}`,
          label: entry.version.payload.title,
          tracedRequirementElementIds:
            entry.version.payload.tracedRequirementElementIds,
          tracedDecisionElementIds:
            entry.version.payload.tracedDecisionElementIds,
          coveredCriterionElementIds:
            entry.version.payload.coveredCriterionElementIds,
          isNewInRevision:
            entry.version.elementVersion === 1 &&
            snapshot?.revision.basedOnRevisionId !== null,
          revisionNumber: snapshot?.revision.number ?? 1,
        },
      ];
    }),
    executions: detail.executions,
    criteria,
    findings,
  };
}
