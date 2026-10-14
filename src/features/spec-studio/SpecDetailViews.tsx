"use client";

import { type ReactNode } from "react";

import { parseElementHandle } from "@/lib/specs/handles";
import { type SpecDetailView } from "@/lib/specs/queries";
import { useSpecLintQuery } from "@/lib/specs/queries";

import SpecControlsPanel, { SpecGatePolicyPanel } from "./SpecControls";
import { SpecElementReader } from "./SpecElementReader";
import SpecHistoryPanel from "./SpecHistoryPanel";
import SpecLintSummary from "./SpecLintSummary";
import SpecQuestionsAssumptionsPanel, {
  blockingAssumptionIdsFromLint,
} from "./SpecQuestionsAssumptions";
import SpecReviewMode from "./SpecReviewMode";

export type DetailView =
  | "overview"
  | "requirements"
  | "design"
  | "gate-policy"
  | "history";

const views: ReadonlyArray<{ view: DetailView; label: string }> = [
  { view: "overview", label: "Overview" },
  { view: "requirements", label: "Requirements" },
  { view: "design", label: "Design" },
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

      {view === "gate-policy" && (
        <div className="mt-lg grid gap-xl">
          <SurfaceIntro
            title="Gate policy"
            description="Set the review requirements for requirements and design."
          />
          <SpecGatePolicyPanel detail={detail} projectName={projectName} />
        </div>
      )}
      {view === "history" && (
        <div className="mx-auto mt-lg max-w-[1000px]">
          <SurfaceIntro
            title="History"
            description="Revision, approval, and withdrawn draft history."
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

export function initialDetailViewForDeepLink(
  rawHandle: string | null,
  slug: string | undefined,
): DetailView {
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
