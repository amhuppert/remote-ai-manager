"use client";

import { useMemo, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/Button";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
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
import SpecHistoryPanel from "./SpecHistoryPanel";
import SpecQuestionsAssumptionsPanel from "./SpecQuestionsAssumptions";

export type DetailView =
  | "overview"
  | "history"
  | "evidence"
  | "lint"
  | "traceability"
  | "questions"
  | "integrity"
  | "controls";

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
  "cursor-pointer border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-0 py-xs font-mono text-[0.7rem] font-semibold text-text-tertiary transition-colors duration-150 ease-[ease] outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[state=active]:border-cyan data-[state=active]:text-text-primary max-768:min-h-[44px] max-768:px-sm";

type PrimarySubscreen = "evidence" | "traceability" | "history" | "controls";

const primarySubscreenPresentation: Record<
  PrimarySubscreen,
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
  history: {
    title: "History",
    description:
      "Human decisions are recorded separately from policy admissions and execution lifecycle events.",
    layoutClassName: "max-w-[1000px]",
  },
  controls: {
    title: "Controls",
    description:
      "Executions, approvals, gate policy, and the merge gate for this spec.",
    layoutClassName: "max-w-[1300px]",
  },
};

export default function SpecDetailViews({
  detail,
  projectName,
  view,
  onViewChange,
  overviewHeader,
  overviewBanner,
  children,
}: {
  detail: SpecDetailView;
  projectName: string;
  /**
   * The active surface, owned by the URL. Keeping it a prop rather than local
   * state is what makes every in-page deep link land: a tab click and an
   * `?el=`/`?view=` link are the same operation, so neither can go stale
   * against the other.
   */
  view: DetailView;
  onViewChange(view: DetailView): void;
  overviewHeader?: ReactNode;
  overviewBanner?: ReactNode;
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

  if (isFocusedView(view)) {
    return (
      <section className="mt-lg" aria-label={`${focusedViewTitle(view)} view`}>
        <div className="mb-lg flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
          <div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onViewChange("overview")}
            >
              Back to {detail.spec.slug}
            </Button>
            <h2 className="mt-sm mb-0 font-display text-[1rem] font-extrabold text-text-primary">
              {focusedViewTitle(view)}
            </h2>
            <p className="mt-xs mb-0 max-w-[680px] font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
              {focusedViewDescription(view)}
            </p>
          </div>
        </div>
        {view === "lint" && (
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
        )}
        {view === "questions" && (
          <SpecQuestionsAssumptionsPanel
            detail={detail}
            projectName={projectName}
          />
        )}
        {view === "integrity" && (
          <SpecIntegrityPanel detail={detail} projectName={projectName} />
        )}
      </section>
    );
  }

  return (
    <TabsRoot
      value={view}
      onValueChange={(value) => onViewChange(value as DetailView)}
    >
      {view === "overview" ? (
        <>
          {overviewHeader}
          <PrimaryViewNavigation />
        </>
      ) : isPrimarySubscreen(view) ? (
        <PrimarySubscreenHeader
          view={view}
          slug={detail.spec.slug}
          onBack={() => onViewChange("overview")}
        >
          <PrimaryViewNavigation />
        </PrimarySubscreenHeader>
      ) : null}

      <TabsContent value="overview" layoutClassName="mt-md">
        {overviewBanner}
        {children}
      </TabsContent>
      {view === "controls" && (
        <div className="mt-lg">
          <SpecControlsPanel detail={detail} projectName={projectName} />
        </div>
      )}
      {view === "evidence" && (
        <div className="mt-lg">
          <SpecEvidencePanel
            criteria={proofViews}
            dispositions={detail.criterionDispositions.filter(
              (row) =>
                evidenceTarget?.executionId !== null &&
                row.execution_id === evidenceTarget?.executionId,
            )}
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
        </div>
      )}
      <TabsContent value="traceability" layoutClassName="mt-lg">
        <TraceabilityGraph input={traceabilityInput} showHeading={false} />
      </TabsContent>
      <TabsContent value="history" layoutClassName="mt-lg">
        <SpecHistoryPanel
          detail={detail}
          projectName={projectName}
          showHeading={false}
        />
      </TabsContent>
    </TabsRoot>
  );
}

function PrimarySubscreenHeader({
  view,
  slug,
  onBack,
  children,
}: {
  view: PrimarySubscreen;
  slug: string;
  onBack(): void;
  children: ReactNode;
}): React.JSX.Element {
  const presentation = primarySubscreenPresentation[view];
  return (
    <header
      className={cn(
        "mx-auto border-x-0 border-t-0 border-b border-solid border-border-dim pt-sm",
        presentation.layoutClassName,
      )}
    >
      <Button size="sm" variant="ghost" touch onClick={onBack}>
        Back to {slug}
      </Button>
      <div className="mt-2xs flex flex-wrap items-baseline gap-sm">
        <h1 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
          {presentation.title}
        </h1>
        <p className="m-0 font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
          {presentation.description}
        </p>
      </div>
      {children}
    </header>
  );
}

function PrimaryViewNavigation(): React.JSX.Element {
  return (
    <TabsList asChild aria-label="Spec views">
      <div
        data-appearance="underline"
        className="flex items-center gap-lg pt-sm max-768:w-full max-768:gap-xs max-768:overflow-x-auto"
      >
        <TabsTrigger asChild value="overview">
          <button type="button" className={detailTabClass}>
            Overview
          </button>
        </TabsTrigger>
        <TabsTrigger asChild value="traceability">
          <button type="button" className={detailTabClass}>
            Traceability
          </button>
        </TabsTrigger>
        <TabsTrigger asChild value="history">
          <button type="button" className={detailTabClass}>
            History
          </button>
        </TabsTrigger>
        <TabsTrigger asChild value="controls">
          <button type="button" className={detailTabClass}>
            Controls
          </button>
        </TabsTrigger>
      </div>
    </TabsList>
  );
}

// Q/A records render only in the focused Questions surface, so a
// ?el=Q1/?el=A1 deep link must open it or its scroll/focus target never mounts.
export function initialDetailViewForDeepLink(
  rawHandle: string | null,
  slug: string | undefined,
): DetailView {
  if (rawHandle === "execution_start") return "controls";
  // The delivery-approval deep link (notification rows, halt cards, banner,
  // phase CTA) must open Controls or its merge-gate target never mounts.
  if (rawHandle === "delivery") return "controls";
  if (rawHandle === null || slug === undefined) return "overview";
  try {
    const kind = parseElementHandle(rawHandle, slug).kind;
    return kind === "question" || kind === "assumption"
      ? "questions"
      : "overview";
  } catch {
    return "overview";
  }
}

type FocusedView = "lint" | "questions" | "integrity";

function isFocusedView(view: DetailView): view is FocusedView {
  return view === "lint" || view === "questions" || view === "integrity";
}

function focusedViewTitle(view: FocusedView): string {
  switch (view) {
    case "lint":
      return "Deterministic lint";
    case "questions":
      return "Questions and assumptions";
    case "integrity":
      return "Spec integrity";
  }
}

function focusedViewDescription(view: FocusedView): string {
  switch (view) {
    case "lint":
      return "Inspect the exact findings that gate proposal and sign-off.";
    case "questions":
      return "Resolve the human decisions that keep the contract explicit.";
    case "integrity":
      return "Approved revisions are re-hashed and compared against the immutable hashes recorded at approval.";
  }
}

function isPrimarySubscreen(view: DetailView): view is PrimarySubscreen {
  return (
    view === "evidence" ||
    view === "traceability" ||
    view === "history" ||
    view === "controls"
  );
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
