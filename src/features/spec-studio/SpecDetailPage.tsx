"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import AnnotatedMarkdown, {
  type CreateCommentInput,
  type ResolvedComment,
} from "@/components/document-viewer/AnnotatedMarkdown";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import CopyTicketReferenceButton from "@/components/references/CopyTicketReferenceButton";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { tryReanchorExact } from "@/lib/document-comments/anchor";
import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  type SpecElementMentionAttrs,
  type SpecMentionAttrs,
  type SpecReferenceType,
} from "@/lib/prompt-editor/spec-reference-contract";
import { parseElementHandle, toDeepLinkElementId } from "@/lib/specs/handles";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import {
  useSpecDetailQuery,
  useSpecLintQuery,
  type SpecDetailView,
} from "@/lib/specs/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  SpecApprovalRow,
  SpecAssumptionDisposition,
  SpecAuthoringStage,
  SpecCommentRow,
  SpecRevisionElement,
} from "@/lib/specs/schemas";
import { specCommentRowSchema } from "@/lib/specs/schemas";
import {
  specAssumptionViewSchema,
  type SpecAssumptionView,
} from "@/lib/specs/queries";
import type { RequirementStatus, TaskWorkStatus } from "@/lib/specs/phase";
import type { SpecPhasePrimary } from "@/lib/specs/phase";
import { cn } from "@/lib/ui/cn";

import SpecDetailViews, {
  initialDetailViewForDeepLink,
  type DetailView,
} from "./SpecDetailViews";
import SpecPhaseFacets from "./SpecPhaseFacets";
import SpecPhaseStepper from "./SpecPhaseStepper";

const logger = createClientLogger("spec-studio-detail");

export interface RailItem {
  elementId: string;
  handle: string;
  kind:
    | "requirement"
    | "criterion"
    | "decision"
    | "question"
    | "assumption"
    | "task";
  name: string;
  status: string;
  statusTone: StatusChipTone;
  approval: string;
  approvalTone: StatusChipTone;
  nested: boolean;
  criteria?: RailCriterion[];
  details?: Array<{ label: string; text: string }>;
}

export interface RailCriterion {
  elementId: string;
  handle: string;
  name: string;
  status: string;
  statusTone: StatusChipTone;
}

export interface RailGroup {
  id: "requirements" | "decisions" | "questions" | "tasks";
  label: string;
  items: RailItem[];
}

export default function SpecDetailPage(): React.JSX.Element {
  return (
    <Suspense>
      <SpecDetailPageInner />
    </Suspense>
  );
}

function SpecDetailPageInner(): React.JSX.Element {
  const params = useParams<{ projectName: string; slug: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectName = params.projectName;
  const requestedSlug = params.slug;
  const detailQuery = useSpecDetailQuery(projectName, requestedSlug);
  const detail = detailQuery.data;
  const deepLinkId = useMemo(
    () => resolveDeepLinkId(searchParams.get("el"), detail?.spec.slug),
    [detail?.spec.slug, searchParams],
  );

  // Surface selections write the URL instead of a local state slot, so the
  // address bar stays the only description of what is on screen. `replace`
  // keeps routine tab changes out of the browser's back stack.
  function selectView(nextView: DetailView): void {
    const detailPath = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(requestedSlug)}`;
    router.replace(
      nextView === "overview" ? detailPath : `${detailPath}?view=${nextView}`,
      { scroll: false },
    );
  }

  useEffect(() => {
    if (detail === undefined || deepLinkId === null) return;
    const target = document.getElementById(deepLinkId);
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [deepLinkId, detail]);

  return (
    <div className="app" data-page="specs">
      <Topbar
        page="specs"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: projectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: "specs",
            href: `/specs?project=${encodeURIComponent(projectName)}`,
          },
          { label: detail?.spec.slug ?? requestedSlug },
        ]}
      />
      <main className="main">
        {detailQuery.isPending ? (
          <div className="px-xl py-lg font-mono text-[0.72rem] text-text-tertiary max-768:px-md">
            Loading spec…
          </div>
        ) : detailQuery.isError || detail === undefined ? (
          <EmptyState>
            <EmptyStateTitle>Couldn&apos;t load spec</EmptyStateTitle>
            <EmptyStateDesc>
              {detailQuery.error instanceof Error
                ? detailQuery.error.message
                : "The requested spec is unavailable."}
            </EmptyStateDesc>
          </EmptyState>
        ) : (
          <SpecDetailContent
            detail={detail}
            projectName={projectName}
            requestedSlug={requestedSlug}
            view={resolveRequestedDetailView(
              searchParams.get("view"),
              searchParams.get("el"),
              detail.spec.slug,
            )}
            highlightedChangeId={searchParams.get("change")}
            onViewChange={selectView}
          />
        )}
      </main>
    </div>
  );
}

function LinkedTicketChips({
  tickets,
}: {
  tickets: SpecDetailView["linkedTickets"];
}): React.JSX.Element {
  return (
    <section
      aria-label="Linked tickets"
      className="flex flex-wrap items-center gap-sm"
    >
      <span className="w-[110px] shrink-0 font-mono text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        Tickets
      </span>
      {tickets.length === 0 ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          none linked
        </span>
      ) : (
        tickets.map((ticket) => {
          const identifier = formatTicketIdentifier(
            ticket.projectName,
            ticket.number,
          );
          return (
            <div
              key={identifier}
              className="inline-flex min-w-0 items-center rounded-full border border-solid border-border-subtle"
            >
              <Link
                href={ticketDetailHref(ticket.projectName, ticket.number)}
                aria-label={`${identifier} · ${ticket.title}`}
                title={ticket.title}
                className="min-w-0 truncate py-2xs pr-xs pl-sm font-mono text-[0.7rem] text-text-secondary no-underline hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {identifier} · {ticket.title}
              </Link>
              <span className="inline-flex shrink-0 border-x-0 border-y-0 border-solid border-border-default">
                <CopyTicketReferenceButton
                  projectName={ticket.projectName}
                  ticketNumber={ticket.number}
                  title={ticket.title}
                  layoutClassName="shrink-0"
                />
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

export function SpecDetailContent({
  detail,
  projectName,
  requestedSlug,
  view,
  highlightedChangeId = null,
  onViewChange,
}: {
  detail: SpecDetailView;
  projectName: string;
  requestedSlug: string;
  view: DetailView;
  highlightedChangeId?: string | null;
  onViewChange(view: DetailView): void;
}): React.JSX.Element {
  const [completionMessage, setCompletionMessage] = useState<string | null>(
    null,
  );
  const snapshot = detail.currentRevision;
  const readOnly = detail.spec.abandonedAt !== null;
  const revision = snapshot?.revision.number ?? latestRevisionNumber(detail);
  const sections =
    snapshot?.elements.filter(
      (entry) => entry.version.payload.kind === "section",
    ) ?? [];
  const railGroups = snapshot === null ? [] : buildRailGroups(detail);
  const statePresentation = detailStatePresentation(
    detail.status.phase.primary,
    detail.status.pendingApprovals,
    detail.status.phase.authoringStage ??
      detail.currentRevision?.revision.authoringStage ??
      detail.currentApprovedRevision?.revision.authoringStage,
  );
  const detailHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`;
  const gateHref = `${detailHref}?view=gate`;
  const reviewHref = `${detailHref}?view=review`;
  const primaryActionHref =
    statePresentation.view === null
      ? null
      : statePresentation.el !== undefined
        ? `${detailHref}?el=${statePresentation.el}`
        : statePresentation.view === "review"
          ? reviewHref
          : `${detailHref}?view=${statePresentation.view}`;
  // An execution running over a proposed revision projects as `executing` with
  // an `in_review` authoring facet, so the state-driven primary action points at
  // evidence and would otherwise leave review mode with no entry point at all.
  const showSecondaryReviewLink =
    statePresentation.view !== "review" &&
    detail.status.phase.authoringFacet === "in_review";
  const lintQuery = useSpecLintQuery(projectName, detail.spec.slug);
  const specReferenceAttrs: SpecMentionAttrs = {
    projectName,
    slug: detail.spec.slug,
    name: detail.spec.name,
    revision: String(revision),
    readCommand: buildSpecReadCommand(projectName, detail.spec.slug),
  };

  return (
    <>
      <SpecPhaseStepper detail={detail} />
      <div className="px-xl pt-sm pb-3xl max-768:px-md">
        <SpecDetailViews
          detail={detail}
          projectName={projectName}
          view={view}
          onViewChange={onViewChange}
          highlightedChangeId={highlightedChangeId}
          onReviewComplete={(message) => {
            setCompletionMessage(message);
            onViewChange("overview");
          }}
          overviewHeader={
            <header className="border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
              <div className="flex flex-wrap items-start justify-between gap-md">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-sm">
                    <h1 className="m-0 font-display text-[1.25rem] leading-none font-extrabold text-text-primary">
                      {detail.spec.name}
                    </h1>
                    <SpecReferenceCopyButton
                      referenceType="spec"
                      attrs={specReferenceAttrs}
                      appearance="handle"
                    />
                    <SpecPhaseFacets status={detail.status} />
                    <Link
                      href={`${gateHref}#gate-policy`}
                      aria-label="Open gate policy from preset"
                      title="Gate preset — open gate policy"
                      className="inline-flex items-center rounded-full border border-solid border-border-default px-sm py-2xs font-mono text-[0.64rem] font-semibold tracking-[0.06em] text-text-secondary uppercase no-underline hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                    >
                      {gatePresetLabel(detail.spec.gatePolicy.preset)}
                    </Link>
                  </div>
                  {requestedSlug !== detail.spec.slug && (
                    <p className="mt-xs mb-0 font-mono text-[0.68rem] text-text-tertiary">
                      Opened from alias {requestedSlug}
                    </p>
                  )}
                  <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
                    {revisionLine(detail, revision)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-sm">
                  <a
                    href={`/api/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}/export`}
                    download={`${detail.spec.slug}.spec.json`}
                    title="Export a portable, tamper-evident representation"
                    className="inline-flex h-[28px] items-center rounded-sm px-sm font-mono text-[0.72rem] font-medium text-text-tertiary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                  >
                    Export
                  </a>
                  <Link
                    href={`${detailHref}?view=integrity`}
                    title="Verify approved revision integrity"
                    className="inline-flex h-[28px] items-center rounded-sm px-sm font-mono text-[0.72rem] font-medium text-text-tertiary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                  >
                    Verify
                  </Link>
                  {showSecondaryReviewLink && (
                    <Link
                      href={reviewHref}
                      title="Review the proposed revision"
                      className="inline-flex h-[28px] items-center rounded-sm px-sm font-mono text-[0.72rem] font-medium text-text-tertiary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                    >
                      Review revision
                    </Link>
                  )}
                  <Link
                    href={`${gateHref}#gate-policy`}
                    className="inline-flex h-[28px] items-center rounded-sm border border-solid border-border-default bg-bg-raised px-md font-mono text-[0.72rem] font-medium text-text-secondary no-underline transition-colors hover:border-border-strong hover:bg-bg-elevated hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                  >
                    Gate policy
                  </Link>
                  {primaryActionHref !== null &&
                    statePresentation.action !== null && (
                      <Link
                        href={primaryActionHref}
                        className={cn(
                          "inline-flex h-[28px] items-center rounded-sm border border-solid px-md font-mono text-[0.72rem] font-semibold no-underline transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
                          statePresentation.tone === "green"
                            ? "border-green-dim bg-green-glow text-green hover:border-green"
                            : statePresentation.tone === "amber"
                              ? "border-amber-dim bg-amber-glow text-amber hover:border-amber"
                              : "border-cyan-dim bg-cyan-glow text-cyan hover:border-cyan",
                        )}
                      >
                        {statePresentation.action}
                      </Link>
                    )}
                </div>
              </div>
            </header>
          }
          overviewBanner={
            <>
              {completionMessage !== null && (
                <div
                  role="status"
                  className="mb-md rounded-md border border-solid border-green-dim bg-green-glow px-lg py-sm font-mono text-[0.72rem] text-green"
                >
                  {completionMessage}
                </div>
              )}
              <SpecRevisionBanner
                detail={detail}
                presentation={statePresentation}
                detailHref={detailHref}
              />
            </>
          }
        >
          {snapshot === null ? (
            <div className="mt-lg rounded-md border border-dashed border-border-default px-lg py-xl font-mono text-[0.72rem] text-text-tertiary">
              This spec does not have a current revision to display.
            </div>
          ) : (
            <div className="mt-lg grid grid-cols-2 items-start gap-xl max-1180:grid-cols-1">
              <section
                aria-label="Spec narrative"
                className="min-w-0 overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-base px-lg"
              >
                {sections.length === 0 ? (
                  <div className="py-lg">
                    <NarrativeSectionHeading>Intent</NarrativeSectionHeading>
                    <p className="mt-sm mb-0 font-mono text-[0.72rem] text-text-tertiary">
                      No prose sections authored. Structured elements remain
                      available in the rail.
                    </p>
                  </div>
                ) : (
                  sections.map((section) => (
                    <SpecProseSection
                      key={section.element.id}
                      section={section}
                      comments={detail.comments.filter(
                        (comment) => comment.element_id === section.element.id,
                      )}
                      projectName={projectName}
                      slug={detail.spec.slug}
                      specId={detail.spec.id}
                      revisionId={snapshot.revision.id}
                      readOnly={readOnly}
                    />
                  ))
                )}
                <SpecInlineLint
                  findings={lintQuery.data?.findings ?? []}
                  isPending={lintQuery.isPending || lintQuery.isFetching}
                  error={
                    lintQuery.error instanceof Error
                      ? lintQuery.error.message
                      : null
                  }
                  detailHref={detailHref}
                />
                <SpecLinkedContext detail={detail} />
              </section>
              <SpecStructureRail
                groups={railGroups}
                specId={detail.spec.id}
                projectName={projectName}
                slug={detail.spec.slug}
                revision={revision}
                readOnly={readOnly}
              />
            </div>
          )}
        </SpecDetailViews>
      </div>
    </>
  );
}

export interface DetailStatePresentation {
  tone: "cyan" | "amber" | "green" | "red";
  banner: string;
  description: string;
  action: string | null;
  view: "review" | "evidence" | "execution" | "gate" | null;
  /**
   * Focused deep-link target. When present the CTA navigates with `?el=` —
   * the retrying contract that lands on the focused control after the page
   * loads — instead of the bare `?view=` top of the surface.
   */
  el?: "delivery";
}

const bannerLineClass = {
  cyan: "bg-[linear-gradient(90deg,var(--color-cyan),transparent_65%)]",
  amber: "bg-[linear-gradient(90deg,var(--color-amber),transparent_65%)]",
  green: "bg-[linear-gradient(90deg,var(--color-green),transparent_65%)]",
  red: "bg-[linear-gradient(90deg,var(--color-red),transparent_65%)]",
} as const;

const bannerDotClass = {
  cyan: "bg-cyan shadow-[0_0_8px_var(--color-cyan)]",
  amber: "bg-amber shadow-[0_0_8px_var(--color-amber)]",
  green: "bg-green shadow-[0_0_8px_var(--color-green)]",
  red: "bg-red shadow-[0_0_8px_var(--color-red)]",
} as const;

const bannerTextClass = {
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
} as const;

const bannerApprovalsLinkClass =
  "text-[0.68rem] text-text-secondary no-underline underline-offset-2 hover:text-text-primary hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

/**
 * The pending-approvals summary is a control, not a statistic: a pending
 * delivery approval names itself and links straight to the approval control
 * (`?el=delivery`, the retrying deep-link contract); other pending gates link
 * to the surface that hosts their decision (F15).
 */
function BannerApprovalsSummary({
  pendingApprovals,
  detailHref,
}: {
  pendingApprovals: SpecDetailView["status"]["pendingApprovals"];
  detailHref: string;
}): React.JSX.Element {
  if (pendingApprovals.some((pending) => pending.gate === "delivery")) {
    return (
      <Link
        href={`${detailHref}?el=delivery`}
        className={bannerApprovalsLinkClass}
      >
        Delivery approval pending — open Execution
      </Link>
    );
  }
  if (pendingApprovals.length > 0) {
    const target =
      pendingApprovals[0]?.gate === "execution_start"
        ? `${detailHref}?view=execution`
        : `${detailHref}?view=review`;
    return (
      <Link href={target} className={bannerApprovalsLinkClass}>
        {pendingApprovals.length} pending approval
        {pendingApprovals.length === 1 ? "" : "s"} — review
      </Link>
    );
  }
  return <>0 pending approvals</>;
}

export function SpecRevisionBanner({
  detail,
  presentation,
  detailHref,
}: {
  detail: SpecDetailView;
  presentation: DetailStatePresentation;
  detailHref: string;
}): React.JSX.Element {
  const description =
    detail.status.phase.primary === "abandoned"
      ? (detail.spec.abandonedReason ?? "This spec is read-only.")
      : presentation.description;

  return (
    <section
      aria-label="Spec status"
      className="relative flex flex-wrap items-center gap-md overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base px-lg py-sm font-mono"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0 right-0 left-0 h-[2px] opacity-80",
          bannerLineClass[presentation.tone],
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "h-[7px] w-[7px] shrink-0 animate-pulse-dot rounded-full",
          bannerDotClass[presentation.tone],
        )}
      />
      <span
        className={cn(
          "shrink-0 text-[0.68rem] font-bold tracking-[0.07em] uppercase",
          bannerTextClass[presentation.tone],
        )}
      >
        {presentation.banner}
      </span>
      <span className="min-w-[220px] flex-1 truncate text-[0.72rem] text-text-secondary max-768:order-4 max-768:w-full max-768:whitespace-normal">
        {description}
      </span>
      <span className="shrink-0 text-[0.68rem] text-text-tertiary">
        <BannerApprovalsSummary
          pendingApprovals={detail.status.pendingApprovals}
          detailHref={detailHref}
        />{" "}
        · {detail.status.openQuestions.length} open questions
      </span>
    </section>
  );
}

function NarrativeSectionHeading({
  children,
}: {
  children: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-sm">
      <h2 className="m-0 shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        {children}
      </h2>
      <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
    </div>
  );
}

interface InlineLintFinding {
  ruleId: string;
  severity: "blocks_propose" | "blocks_claim" | "blocks_signoff" | "advisory";
  elementHandle: string;
  message: string;
}

const lintDotClass: Record<InlineLintFinding["severity"], string> = {
  blocks_propose: "bg-red",
  blocks_claim: "bg-red",
  blocks_signoff: "bg-red",
  advisory: "bg-amber",
};

const lintSeverityClass: Record<InlineLintFinding["severity"], string> = {
  blocks_propose: "text-red",
  blocks_claim: "text-red",
  blocks_signoff: "text-red",
  advisory: "text-amber",
};

function SpecInlineLint({
  findings,
  isPending,
  error,
  detailHref,
}: {
  findings: InlineLintFinding[];
  isPending: boolean;
  error: string | null;
  detailHref: string;
}): React.JSX.Element {
  const blocking = findings.filter(
    (finding) => finding.severity !== "advisory",
  ).length;
  const advisory = findings.length - blocking;
  const meta = isPending
    ? "checking"
    : error !== null
      ? "unavailable"
      : findings.length === 0
        ? "clean"
        : `${blocking} blocking · ${advisory} advisory`;

  return (
    <section className="border-x-0 border-t border-b-0 border-solid border-border-dim py-lg">
      <div className="flex items-center gap-sm">
        <h2 className="m-0 shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Lint
        </h2>
        <span className="truncate font-mono text-[0.68rem] text-text-tertiary">
          {meta}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
      </div>
      {error !== null ? (
        <p className="mt-sm mb-0 font-mono text-[0.72rem] text-red">{error}</p>
      ) : findings.length === 0 ? (
        <p className="mt-sm mb-0 font-mono text-[0.72rem] text-text-tertiary">
          {isPending
            ? "Checking the current revision…"
            : "No findings — the relationship graph is clean."}
        </p>
      ) : (
        <div className="mt-sm grid">
          {findings.map((finding) => {
            const href = finding.elementHandle
              ? `${detailHref}?${new URLSearchParams({ el: finding.elementHandle }).toString()}`
              : `${detailHref}?view=lint`;
            return (
              <Link
                key={`${finding.ruleId}:${finding.elementHandle}`}
                href={href}
                className="flex items-baseline gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-2xs py-sm font-mono text-inherit no-underline last:border-b-0 hover:bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-[6px] w-[6px] shrink-0 self-center rounded-full",
                    lintDotClass[finding.severity],
                  )}
                />
                <span
                  className={cn(
                    "shrink-0 text-[0.64rem] font-bold tracking-[0.06em] uppercase",
                    lintSeverityClass[finding.severity],
                  )}
                >
                  {lintSeverityLabel(finding.severity)}
                </span>
                <span className="min-w-0 flex-1 text-[0.74rem] leading-relaxed text-text-secondary">
                  {finding.message}
                </span>
                {finding.elementHandle && (
                  <span className="inline-flex shrink-0 items-center gap-xs text-[0.7rem] text-cyan-dim">
                    {finding.elementHandle}
                    <ForwardIcon />
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SpecLinkedContext({
  detail,
}: {
  detail: SpecDetailView;
}): React.JSX.Element {
  return (
    <section className="border-x-0 border-t border-b-0 border-solid border-border-dim py-lg">
      <NarrativeSectionHeading>Linked context</NarrativeSectionHeading>
      <div className="mt-sm grid gap-sm">
        <LinkedTicketChips tickets={detail.linkedTickets} />
        <div className="flex flex-wrap items-center gap-sm font-mono">
          <span className="w-[110px] shrink-0 text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
            Conversations
          </span>
          <span className="text-[0.7rem] text-text-tertiary">none linked</span>
        </div>
        <div className="flex flex-wrap items-center gap-sm font-mono">
          <span className="w-[110px] shrink-0 text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
            Executions
          </span>
          {detail.executions.length === 0 ? (
            <span className="text-[0.7rem] text-text-tertiary">none yet</span>
          ) : (
            detail.executions.map((execution) => (
              <span
                key={execution.id}
                className="inline-flex items-center gap-xs rounded-full border border-solid border-border-subtle px-sm py-2xs text-[0.7rem] text-text-secondary"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-[6px] w-[6px] rounded-full",
                    execution.state === "running"
                      ? "animate-pulse-dot bg-cyan"
                      : execution.state === "delivered"
                        ? "bg-green"
                        : execution.state === "abandoned"
                          ? "bg-red"
                          : "bg-amber",
                  )}
                />
                {execution.id} · {execution.state.replaceAll("_", " ")}
              </span>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function SpecReferenceCopyButton({
  referenceType,
  attrs,
  appearance,
}: {
  referenceType: SpecReferenceType;
  attrs: SpecMentionAttrs | SpecElementMentionAttrs;
  appearance: "handle" | "icon";
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const target =
    "handle" in attrs ? `${attrs.slug}/${attrs.handle}` : attrs.slug;

  async function copyReference(): Promise<void> {
    try {
      await navigator.clipboard.writeText(
        buildSpecReferenceXml(referenceType, { ...attrs }),
      );
      setCopied(true);
      logger.info("spec_studio.reference_copy.completed", {
        referenceType,
        target,
      });
    } catch (error) {
      logger.warn("spec_studio.reference_copy.failed", {
        referenceType,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <WithTooltip
      label={copied ? "Reference copied" : `Copy reference — ${target}`}
    >
      <button
        type="button"
        aria-label={copied ? "Reference copied" : "Copy reference"}
        onClick={() => void copyReference()}
        className={cn(
          "cursor-pointer border-0 font-mono transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
          appearance === "handle"
            ? "inline-flex items-center gap-xs rounded-sm bg-cyan-glow px-sm py-2xs text-[0.72rem] text-cyan-dim hover:bg-bg-hover hover:text-cyan"
            : "flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-sm bg-transparent p-0 text-text-tertiary hover:bg-bg-hover hover:text-text-primary max-768:h-[44px] max-768:w-[44px]",
        )}
      >
        {appearance === "handle" && attrs.slug}
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </WithTooltip>
  );
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
    >
      <rect
        x="5"
        y="5"
        width="8"
        height="8"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function CheckIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="m3 8 3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function ForwardIcon(): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="M3 8h10m-3.5-3.5L13 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function lintSeverityLabel(severity: InlineLintFinding["severity"]): string {
  switch (severity) {
    case "blocks_propose":
      return "Blocks propose";
    case "blocks_claim":
      return "Blocks claim";
    case "blocks_signoff":
      return "Blocks sign-off";
    case "advisory":
      return "Advisory";
  }
}

function revisionLine(detail: SpecDetailView, revision: number): string {
  const snapshot = detail.currentRevision;
  if (snapshot === null) return `rev ${revision} unavailable`;
  const current = snapshot.revision;
  const stateDate =
    current.state === "approved"
      ? current.approvedAt
      : current.state === "proposed"
        ? current.proposedAt
        : current.createdAt;
  const base = detail.baseRevision?.revision;
  const baseDate = base?.approvedAt;
  const baseSummary =
    base === undefined || baseDate === null || baseDate === undefined
      ? ""
      : ` · rev ${base.number} approved ${formatDate(baseDate)}`;
  return `rev ${revision} ${current.state}${stateDate === null ? "" : ` ${formatDate(stateDate)}`}${baseSummary}`;
}

function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function detailStatePresentation(
  phase: SpecPhasePrimary,
  pendingApprovals: SpecDetailView["status"]["pendingApprovals"],
  authoringStage?: SpecAuthoringStage,
): DetailStatePresentation {
  switch (phase) {
    case "draft":
      return {
        tone: "amber",
        banner: "Draft contract",
        description: "Resolve lint and human decisions before proposal.",
        action: "Open gate policy",
        view: "gate",
      };
    case "in_review":
      return {
        tone: "amber",
        banner: "Revision awaits sign-off",
        description:
          "Review semantic changes and satisfy sign-off preconditions.",
        action: "Review revision",
        view: "review",
      };
    case "approved":
      if (authoringStage === "requirements") {
        return {
          tone: "green",
          banner: "Requirements approved",
          description:
            "The requirements are frozen. Design is next; execution stays locked until the Plan is approved.",
          action: null,
          view: null,
        };
      }
      if (authoringStage === "design") {
        return {
          tone: "green",
          banner: "Design approved",
          description:
            "The design is frozen. Plan is next; execution stays locked until the Plan is approved.",
          action: null,
          view: null,
        };
      }
      if (authoringStage !== "plan") {
        return {
          tone: "green",
          banner: "Revision approved",
          description:
            "The approved revision is frozen, but execution requires an approved Plan.",
          action: null,
          view: null,
        };
      }
      return {
        tone: "green",
        banner: "Ready to execute",
        description:
          "The approved Plan revision can anchor an execution scope.",
        action: "Start execution",
        view: "execution",
      };
    case "executing":
      // A run parked on the delivery gate needs its human, not its evidence:
      // the CTA targets the pending approval control when one exists (F16).
      if (pendingApprovals.some((pending) => pending.gate === "delivery")) {
        return {
          tone: "amber",
          banner: "Execution active — approval needed",
          description:
            "The delivery gate is waiting on a human approval; proof continues against the pinned revision.",
          action: "Approve delivery",
          view: "execution",
          el: "delivery",
        };
      }
      return {
        tone: "cyan",
        banner: "Execution active",
        description: "Delivery proof is evaluated against the pinned revision.",
        action: "Open evidence",
        view: "evidence",
      };
    case "delivered":
      return {
        tone: "green",
        banner: "Delivery proven",
        description: "Every in-scope criterion is proven or explicitly waived.",
        action: null,
        view: null,
      };
    case "abandoned":
      return {
        tone: "red",
        banner: "Spec abandoned",
        description: "This contract is retained as read-only history.",
        action: null,
        view: null,
      };
  }
}

function resolveRequestedDetailView(
  rawView: string | null,
  rawHandle: string | null,
  slug: string,
): DetailView {
  if (
    rawView === "overview" ||
    rawView === "traceability" ||
    rawView === "history" ||
    rawView === "evidence" ||
    rawView === "lint" ||
    rawView === "questions" ||
    rawView === "integrity" ||
    rawView === "review" ||
    rawView === "execution" ||
    rawView === "gate" ||
    rawView === "requirements" ||
    rawView === "decisions" ||
    rawView === "tasks"
  ) {
    return rawView;
  }
  return initialDetailViewForDeepLink(rawHandle, slug);
}

function gatePresetLabel(
  preset: SpecDetailView["spec"]["gatePolicy"]["preset"],
): string {
  switch (preset) {
    case "contract-bearing":
      return "Contract-bearing";
    case "exploratory":
      return "Exploratory";
    case "fast-path":
      return "Fast-path";
  }
}

function SpecProseSection({
  section,
  comments,
  projectName,
  slug,
  specId,
  revisionId,
  readOnly,
}: {
  section: SpecRevisionElement;
  comments: SpecCommentRow[];
  projectName: string;
  slug: string;
  specId: string;
  revisionId: string;
  readOnly: boolean;
}): React.JSX.Element | null {
  const [commentFeedback, setCommentFeedback] = useState<string | null>(null);
  const comment = useSpecActionMutation<
    {
      revisionId: string;
      elementId: string;
      threadId: string;
      parentCommentId: null;
      anchor: CreateCommentInput["anchor"];
      body: string;
      blocking: boolean;
    },
    SpecCommentRow
  >(projectName, slug, "comment", specCommentRowSchema, {
    specId,
    eventTypes: ["spec-attention-changed"],
  });
  if (section.version.payload.kind !== "section") return null;
  const payload = section.version.payload;
  const resolvedComments = comments
    .map((comment) => resolveComment(comment, payload.body, projectName, slug))
    .filter((comment): comment is ResolvedComment => comment !== null);

  function createComment(input: CreateCommentInput): void {
    setCommentFeedback("Recording comment…");
    comment.mutate(
      {
        revisionId,
        elementId: section.element.id,
        threadId: createClientId(),
        parentCommentId: null,
        anchor: input.anchor,
        body: input.note,
        blocking: false,
      },
      {
        onSuccess: () => {
          setCommentFeedback("Comment recorded");
          logger.info("spec_studio.prose_comment.completed", {
            specId,
            revisionId,
            elementId: section.element.id,
            immediateSendRequested: input.send,
          });
        },
        onError: (error) => {
          setCommentFeedback(error.message);
          logger.warn("spec_studio.prose_comment.failed", {
            specId,
            revisionId,
            elementId: section.element.id,
            error: error.message,
          });
        },
      },
    );
  }

  return (
    <section
      className="border-x-0 border-t-0 border-b border-solid border-border-dim py-lg"
      data-spec-section={payload.role}
    >
      <NarrativeSectionHeading>{payload.title}</NarrativeSectionHeading>
      <div
        data-testid={`spec-prose-body-${payload.role}`}
        className="mt-sm min-w-0 overflow-hidden [&_[data-markdown-intent=document]]:px-0 [&_[data-markdown-intent=document]]:py-0 [&_[data-markdown-intent=document]]:text-[0.875rem] [&_[data-markdown-intent=document]]:leading-[1.65] [&_[data-markdown-viewport]>div]:pl-0"
      >
        <AnnotatedMarkdown
          docRef={{
            projectName,
            sessionName: `spec-${slug}`,
            docPath: `specs/${slug}/sections/${section.element.id}.md`,
            title: payload.title,
          }}
          content={payload.body}
          isLoading={false}
          comments={resolvedComments}
          onCreateComment={readOnly ? undefined : createComment}
        />
      </div>
      {(commentFeedback !== null || resolvedComments.length > 0) && (
        <div
          role="group"
          aria-label={`${payload.title} comments`}
          className="mt-md grid content-start gap-sm"
        >
          {commentFeedback !== null && (
            <span
              aria-live="polite"
              className={
                comment.isError
                  ? "rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.7rem] text-red"
                  : "rounded-md border border-solid border-border-dim px-md py-sm font-mono text-[0.7rem] text-cyan"
              }
            >
              {commentFeedback}
            </span>
          )}
          {resolvedComments.map((comment) => (
            <article
              key={comment.id}
              className="rounded-md border border-solid border-border-default bg-bg-raised px-md py-sm"
            >
              <div className="mb-xs flex items-center justify-between gap-sm">
                <span className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
                  Inline comment
                </span>
                <StatusChip tone={comment.stale ? "amber" : "cyan"}>
                  {comment.stale ? "Stale anchor" : "Anchored"}
                </StatusChip>
              </div>
              <p className="m-0 font-mono text-[0.76rem] leading-relaxed text-text-secondary">
                {comment.note}
              </p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function SpecStructureRail({
  groups,
  specId,
  projectName,
  slug,
  revision,
  readOnly,
}: {
  groups: RailGroup[];
  specId: string;
  projectName: string;
  slug: string;
  revision: number;
  readOnly: boolean;
}): React.JSX.Element {
  const [dispositionError, setDispositionError] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const itemIds = groups.flatMap((group) =>
    group.items.map((item) => item.elementId),
  );
  const allExpanded =
    itemIds.length > 0 && itemIds.every((itemId) => expandedItems.has(itemId));
  const disposeAssumption = useSpecActionMutation<
    {
      assumptionId: string;
      disposition: Exclude<SpecAssumptionDisposition, "proposed">;
    },
    SpecAssumptionView
  >(projectName, slug, "dispose-assumption", specAssumptionViewSchema, {
    specId,
    eventTypes: ["spec-attention-changed"],
  });

  function setAssumptionDisposition(
    item: RailItem,
    disposition: Exclude<SpecAssumptionDisposition, "proposed">,
  ): void {
    disposeAssumption.mutate(
      { assumptionId: item.elementId, disposition },
      {
        onSuccess: () => {
          setDispositionError(null);
          logger.info("spec_studio.assumption_disposition.completed", {
            specId,
            assumptionId: item.elementId,
            disposition,
          });
        },
        onError: (error) => {
          setDispositionError(error.message);
          logger.warn("spec_studio.assumption_disposition.failed", {
            specId,
            assumptionId: item.elementId,
            disposition,
            error: error.message,
          });
        },
      },
    );
  }

  function toggleItem(itemId: string): void {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <aside
      aria-label="Spec structure"
      className="sticky top-[calc(var(--topbar-height)+var(--space-lg))] flex max-h-[calc(100vh-var(--topbar-height)-var(--space-xl))] flex-col gap-md overflow-y-auto pr-xs max-1180:static max-1180:max-h-none max-1180:pr-0"
    >
      <div className="flex items-center justify-between gap-sm px-xs">
        <span className="font-mono text-[0.64rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Structure
        </span>
        <button
          type="button"
          aria-label={
            allExpanded
              ? "Collapse all structure items"
              : "Expand all structure items"
          }
          onClick={() =>
            setExpandedItems(allExpanded ? new Set() : new Set(itemIds))
          }
          className="min-h-[28px] cursor-pointer rounded-sm border border-solid border-border-default bg-bg-base px-sm font-mono text-[0.64rem] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {groups.map((group) => (
        <section
          key={group.id}
          aria-labelledby={`spec-rail-${group.id}`}
          className="shrink-0 overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface"
        >
          <div className="flex items-center justify-between gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
            <h3
              id={`spec-rail-${group.id}`}
              className="m-0 font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-secondary uppercase"
            >
              {group.label}
            </h3>
            <div className="flex items-center gap-sm">
              <span className="font-mono text-[0.66rem] text-text-tertiary">
                {group.items.length}
              </span>
              <Link
                href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=${railGroupView(group.id)}`}
                aria-label={`Open ${group.label}`}
                className="font-mono text-[0.64rem] font-semibold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                Open
              </Link>
            </div>
          </div>
          {group.items.length === 0 ? (
            <p className="m-sm rounded-sm border border-dashed border-border-dim px-sm py-sm font-mono text-[0.68rem] text-text-tertiary">
              None recorded
            </p>
          ) : (
            <div>
              {group.id === "questions" && dispositionError !== null && (
                <p
                  role="alert"
                  className="m-0 border-x-0 border-t-0 border-b border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.68rem] text-red"
                >
                  {dispositionError}
                </p>
              )}
              {group.items.map((item) => {
                const expanded = expandedItems.has(item.elementId);
                return (
                  <div
                    key={item.elementId}
                    id={item.handle}
                    data-spec-element={item.handle}
                    tabIndex={-1}
                    className="flex flex-wrap items-start gap-xs border-x-0 border-t-0 border-b border-solid border-border-dim px-sm py-xs transition-colors last:border-b-0 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[52px] max-768:py-sm"
                  >
                    <button
                      type="button"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${item.handle}`}
                      aria-expanded={expanded}
                      onClick={() => toggleItem(item.elementId)}
                      className="flex min-h-[32px] min-w-0 flex-1 cursor-pointer items-start gap-sm rounded-sm border-0 bg-transparent px-xs py-2xs text-left focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
                    >
                      <span className="w-[32px] shrink-0 pt-[1px] font-mono text-[0.68rem] font-semibold text-text-tertiary">
                        {item.handle}
                      </span>
                      <span className="line-clamp-2 min-w-0 flex-1 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
                        {item.name}
                      </span>
                      <span
                        aria-hidden="true"
                        className="shrink-0 pt-[1px] font-mono text-[0.68rem] text-text-tertiary"
                      >
                        {expanded ? "−" : "+"}
                      </span>
                    </button>
                    {(item.kind === "question" ||
                      item.kind === "assumption" ||
                      item.kind === "task") && (
                      <span
                        className={cn(
                          "mt-xs shrink-0 font-mono text-[0.62rem] font-semibold tracking-[0.05em] uppercase",
                          railToneTextClass[item.statusTone],
                        )}
                      >
                        {item.status}
                      </span>
                    )}
                    {item.kind !== "question" && item.kind !== "assumption" && (
                      <span className="mt-xs">
                        <RailApprovalIcon
                          tone={item.approvalTone}
                          label={item.approval}
                        />
                      </span>
                    )}
                    <SpecReferenceCopyButton
                      referenceType={referenceType(item.kind)}
                      attrs={{
                        projectName,
                        slug,
                        handle: item.handle,
                        name: item.name,
                        revision: String(revision),
                        readCommand: buildSpecReadCommand(
                          projectName,
                          slug,
                          item.handle,
                        ),
                      }}
                      appearance="icon"
                    />
                    <span className="sr-only">
                      {item.status}; {item.approval}
                    </span>
                    {expanded && (
                      <div className="basis-full border-x-0 border-t border-b-0 border-solid border-border-dim px-[44px] pt-sm pb-xs">
                        <div className="min-w-0">
                          <CompactMarkdown content={item.name} />
                        </div>
                        {item.criteria !== undefined &&
                          item.criteria.length > 0 && (
                            <div
                              role="group"
                              aria-label={`${item.handle} criteria`}
                              className="mt-sm grid gap-xs"
                            >
                              {item.criteria.map((criterion) => (
                                <div
                                  key={criterion.elementId}
                                  id={criterion.handle}
                                  data-spec-element={criterion.handle}
                                  tabIndex={-1}
                                  className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-sm rounded-sm border border-solid border-border-dim bg-bg-base px-sm py-xs focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                                >
                                  <span className="font-mono text-[0.64rem] font-semibold text-cyan-dim">
                                    {criterion.handle}
                                  </span>
                                  <div className="min-w-0">
                                    <CompactMarkdown content={criterion.name} />
                                  </div>
                                  <span
                                    className={cn(
                                      "font-mono text-[0.6rem] font-semibold tracking-[0.05em] uppercase",
                                      railToneTextClass[criterion.statusTone],
                                    )}
                                  >
                                    {criterion.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        {item.details?.map((detail) => (
                          <div key={detail.label} className="mt-sm">
                            <span className="font-mono text-[0.62rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                              {detail.label}
                            </span>
                            <div className="mt-2xs min-w-0">
                              <CompactMarkdown content={detail.text} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {!readOnly && item.kind === "assumption" && (
                      <AssumptionDispositionControls
                        item={item}
                        pending={disposeAssumption.isPending}
                        onSelect={(disposition) =>
                          setAssumptionDisposition(item, disposition)
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </aside>
  );
}

type AssumptionDispositionChoice = Exclude<
  SpecAssumptionDisposition,
  "proposed"
>;

const assumptionDispositionButtonClass: Record<
  AssumptionDispositionChoice,
  string
> = {
  confirmed:
    "border-green-dim text-green hover:border-green hover:bg-green-glow",
  rejected: "border-red-dim text-red hover:border-red hover:bg-red-glow",
  deferred:
    "border-border-default text-text-tertiary hover:border-border-strong hover:bg-bg-hover hover:text-text-primary",
};

function AssumptionDispositionControls({
  item,
  pending,
  onSelect,
}: {
  item: RailItem;
  pending: boolean;
  onSelect(disposition: AssumptionDispositionChoice): void;
}): React.JSX.Element {
  const choices: Array<{
    disposition: AssumptionDispositionChoice;
    action: string;
    label: string;
  }> = [
    { disposition: "confirmed", action: "Confirm", label: "confirm" },
    { disposition: "rejected", action: "Reject", label: "reject" },
    { disposition: "deferred", action: "Defer", label: "defer" },
  ];

  return (
    <div
      role="group"
      aria-label={`Dispose ${item.handle}`}
      className="flex basis-full items-center gap-xs pl-[38px]"
    >
      <span className="mr-xs font-mono text-[0.6rem] text-text-tertiary">
        dispose:
      </span>
      {choices.map((choice) => (
        <button
          key={choice.disposition}
          type="button"
          aria-label={`${choice.action} ${item.handle}`}
          aria-pressed={item.status.toLowerCase() === choice.disposition}
          disabled={pending}
          onClick={() => onSelect(choice.disposition)}
          className={cn(
            "h-[20px] cursor-pointer rounded-sm border border-solid bg-transparent px-sm font-mono text-[0.6rem] transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 disabled:cursor-wait disabled:opacity-50",
            assumptionDispositionButtonClass[choice.disposition],
          )}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

const railToneTextClass: Record<StatusChipTone, string> = {
  neutral: "text-text-tertiary",
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
  violet: "text-violet",
};

function RailApprovalIcon({
  tone,
  label,
}: {
  tone: StatusChipTone;
  label: string;
}): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "flex h-[16px] w-[16px] shrink-0 items-center justify-center",
        railToneTextClass[tone],
      )}
    >
      {tone === "green" ? (
        <CheckIcon />
      ) : tone === "amber" ? (
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M12.5 5.5V2.8l-1 1A5 5 0 1 0 13 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
          />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle cx="8" cy="8" r="4.5" stroke="currentColor" />
        </svg>
      )}
    </span>
  );
}

export function buildRailGroups(detail: SpecDetailView): RailGroup[] {
  const structuralItems = buildRailItems(detail);
  const questions: RailItem[] = detail.questions.map((question) => ({
    elementId: question.id,
    handle: question.handle,
    kind: "question",
    name: question.text,
    status: question.status === "open" ? "Open" : "Answered",
    statusTone: question.status === "open" ? "amber" : "green",
    approval: question.status === "open" ? "Needs decision" : "Resolved",
    approvalTone: question.status === "open" ? "amber" : "green",
    nested: false,
    details:
      question.answer === null
        ? []
        : [{ label: "Answer", text: question.answer }],
  }));
  const assumptions: RailItem[] = detail.assumptions.map((assumption) => ({
    elementId: assumption.id,
    handle: assumption.handle,
    kind: "assumption",
    name: assumption.text,
    status: assumptionDispositionLabel(assumption.disposition),
    statusTone:
      assumption.disposition === "confirmed"
        ? "green"
        : assumption.disposition === "rejected"
          ? "red"
          : "amber",
    approval:
      assumption.disposition === "proposed"
        ? "Needs decision"
        : "Disposition recorded",
    approvalTone: assumption.disposition === "proposed" ? "amber" : "neutral",
    nested: false,
  }));

  return [
    {
      id: "requirements",
      label: "Requirements",
      items: structuralItems.filter(
        (item) => item.kind === "requirement" || item.kind === "criterion",
      ),
    },
    {
      id: "decisions",
      label: "Decisions",
      items: structuralItems.filter((item) => item.kind === "decision"),
    },
    {
      id: "questions",
      label: "Questions & assumptions",
      items: [...questions, ...assumptions],
    },
    {
      id: "tasks",
      label: "Tasks",
      items: structuralItems.filter((item) => item.kind === "task"),
    },
  ];
}

function buildRailItems(detail: SpecDetailView): RailItem[] {
  const snapshot = detail.currentRevision;
  if (snapshot === null) return [];
  const criteriaByRequirement = new Map<string, SpecRevisionElement[]>();
  const tasks = snapshot.elements.filter(
    (entry) => entry.version.payload.kind === "task",
  );
  for (const entry of snapshot.elements) {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.parentElementId === null
    ) {
      continue;
    }
    const siblings =
      criteriaByRequirement.get(entry.element.parentElementId) ?? [];
    siblings.push(entry);
    criteriaByRequirement.set(entry.element.parentElementId, siblings);
  }

  return snapshot.elements.flatMap((entry): RailItem[] => {
    const payload = entry.version.payload;
    const number = entry.element.number;
    if (payload.kind === "section" || number === null) return [];

    if (payload.kind === "requirement") {
      const handle = `R${number}`;
      const criteria = criteriaByRequirement.get(entry.element.id) ?? [];
      const covered = new Set(
        tasks.flatMap((task) =>
          task.version.payload.kind === "task"
            ? task.version.payload.coveredCriterionElementIds
            : [],
        ),
      );
      const approval = approvalPresentation(
        detail.elementStatuses.requirements.find(
          (candidate) => candidate.elementId === entry.element.id,
        )?.status.approval ?? "unapproved",
        entry.element.id,
        detail,
      );
      const requirementStatus = detail.elementStatuses.requirements.find(
        (candidate) => candidate.elementId === entry.element.id,
      )?.status;
      const requirementPresentation =
        requirementStatusPresentation(requirementStatus);
      const requirement: RailItem = {
        elementId: entry.element.id,
        handle,
        kind: "requirement",
        name: payload.statement,
        status: requirementPresentation.status,
        statusTone: requirementPresentation.statusTone,
        ...approval,
        nested: false,
        criteria: criteria.flatMap((criterion): RailCriterion[] => {
          if (criterion.version.payload.kind !== "criterion") return [];
          const criterionNumber = criterion.element.number;
          if (criterionNumber === null) return [];
          return [
            {
              elementId: criterion.element.id,
              handle: `${handle}.${criterionNumber}`,
              name: criterion.version.payload.text,
              status: covered.has(criterion.element.id)
                ? "Covered"
                : "Uncovered",
              statusTone: covered.has(criterion.element.id) ? "green" : "amber",
            },
          ];
        }),
      };
      return [requirement];
    }

    if (payload.kind === "criterion") return [];

    if (payload.kind === "decision") {
      return [
        {
          elementId: entry.element.id,
          handle: `D${number}`,
          kind: "decision",
          name: payload.title,
          status:
            snapshot.revision.state === "proposed" ? "Proposed" : "Current",
          statusTone:
            snapshot.revision.state === "proposed" ? "amber" : "green",
          ...approvalPresentation(
            latestApprovalValidity(
              detail.approvals,
              entry.element.id,
              "decision",
            ),
            entry.element.id,
            detail,
          ),
          nested: false,
          details: [
            { label: "Chosen approach", text: payload.chosenApproach },
            { label: "Rationale", text: payload.reason },
            ...payload.rejectedAlternatives.map((alternative) => ({
              label: `Rejected · ${alternative.label}`,
              text: alternative.reason,
            })),
          ],
        },
      ];
    }

    const taskStatus = detail.elementStatuses.tasks.find(
      (candidate) => candidate.elementId === entry.element.id,
    )?.status;
    const taskPresentation = taskStatusPresentation(taskStatus);
    return [
      {
        elementId: entry.element.id,
        handle: `T${number}`,
        kind: "task",
        name: payload.title,
        status: taskPresentation.status,
        statusTone: taskPresentation.statusTone,
        ...planApprovalPresentation(detail),
        nested: false,
        details: [{ label: "Instructions", text: payload.instructions }],
      },
    ];
  });
}

function approvalPresentation(
  validity: SpecApprovalRow["validity"] | "unapproved",
  elementId: string,
  detail: SpecDetailView,
): Pick<RailItem, "approval" | "approvalTone"> {
  if (validity === "valid") {
    return { approval: "Approved", approvalTone: "green" };
  }
  if (validity === "stale") {
    return { approval: "Approval stale", approvalTone: "amber" };
  }
  if (validity === "closed") {
    return { approval: "Approval closed", approvalTone: "neutral" };
  }
  if (
    detail.status.pendingApprovals.some(
      (pending) => pending.elementId === elementId,
    )
  ) {
    return { approval: "Pending", approvalTone: "amber" };
  }
  return { approval: "Not approved", approvalTone: "neutral" };
}

function planApprovalPresentation(
  detail: SpecDetailView,
): Pick<RailItem, "approval" | "approvalTone"> {
  const validity = latestApprovalValidity(detail.approvals, null, "plan");
  if (validity === "valid") {
    return { approval: "Plan approved", approvalTone: "green" };
  }
  if (validity === "stale") {
    return { approval: "Plan approval stale", approvalTone: "amber" };
  }
  if (
    detail.status.pendingApprovals.some((pending) => pending.gate === "plan")
  ) {
    return { approval: "Pending", approvalTone: "amber" };
  }
  return { approval: "Plan not approved", approvalTone: "neutral" };
}

function latestApprovalValidity(
  approvals: SpecApprovalRow[],
  elementId: string | null,
  subjectKind: "requirement" | "decision" | "plan",
): SpecApprovalRow["validity"] | "unapproved" {
  return (
    approvals
      .filter(
        (candidate) =>
          candidate.element_id === elementId &&
          candidate.subject_kind === subjectKind,
      )
      .toSorted((left, right) =>
        left.granted_at === right.granted_at
          ? left.id.localeCompare(right.id)
          : left.granted_at.localeCompare(right.granted_at),
      )
      .at(-1)?.validity ?? "unapproved"
  );
}

function requirementStatusPresentation(
  status: RequirementStatus | undefined,
): Pick<RailItem, "status" | "statusTone"> {
  if (status?.proof === "proven") {
    return { status: "Proven", statusTone: "green" };
  }
  if (status?.proof === "waived") {
    return { status: "Waived", statusTone: "amber" };
  }
  if (status?.proof === "proven_and_waived") {
    return { status: "Proven + waived", statusTone: "green" };
  }
  if (status?.proof === "partial") {
    return { status: "Proof partial", statusTone: "amber" };
  }
  if (status?.coverage === "covered") {
    return { status: "Covered", statusTone: "green" };
  }
  if (status?.coverage === "partial") {
    return { status: "Partially covered", statusTone: "amber" };
  }
  return { status: "Uncovered", statusTone: "amber" };
}

function taskStatusPresentation(
  status: TaskWorkStatus | undefined,
): Pick<RailItem, "status" | "statusTone"> {
  switch (status?.status) {
    case "running":
      return { status: "Running", statusTone: "cyan" };
    case "completed":
      return { status: "Completed", statusTone: "green" };
    case "claimed":
      return { status: "Claimed", statusTone: "green" };
    case "reopened":
      return { status: "Reopened", statusTone: "amber" };
    case "interrupted":
      return { status: "Interrupted", statusTone: "amber" };
    case "failed":
      return { status: "Failed", statusTone: "red" };
    case "pending":
    case undefined:
      return { status: "Pending", statusTone: "neutral" };
  }
}

function resolveComment(
  row: SpecCommentRow,
  content: string,
  projectName: string,
  slug: string,
): ResolvedComment | null {
  let rawAnchor: unknown;
  try {
    rawAnchor = JSON.parse(row.anchor_json);
  } catch {
    return null;
  }
  const parsedAnchor = commentAnchorSchema.safeParse(rawAnchor);
  if (!parsedAnchor.success) return null;
  const reanchor = tryReanchorExact(content, parsedAnchor.data);
  return {
    id: row.id,
    projectPath: projectName,
    sessionName: `spec-${slug}`,
    docPath: `specs/${slug}/elements/${row.element_id}`,
    anchor: parsedAnchor.data,
    note: row.body,
    status: "sent",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.created_at,
    reanchor,
    stale: reanchor.status === "stale",
  };
}

export function resolveDeepLinkId(
  rawHandle: string | null,
  slug: string | undefined,
): string | null {
  // Gate-name literals are persisted in notification rows forever, so this
  // mapping is permanent: ?el=delivery focuses the merge-gate panel.
  if (rawHandle === "delivery") return "merge-gate";
  if (rawHandle === null || slug === undefined) return null;
  try {
    return toDeepLinkElementId(parseElementHandle(rawHandle, slug));
  } catch {
    return null;
  }
}

function latestRevisionNumber(detail: SpecDetailView): number {
  return Math.max(1, ...detail.revisions.map((revision) => revision.number));
}

function railGroupView(group: RailGroup["id"]): DetailView {
  return group === "questions" ? "questions" : group;
}

function referenceType(
  kind: RailItem["kind"],
): "requirement" | "decision" | "question" | "assumption" | "task" {
  if (kind === "criterion") return "requirement";
  return kind;
}

function assumptionDispositionLabel(
  disposition: SpecDetailView["assumptions"][number]["disposition"],
): string {
  switch (disposition) {
    case "proposed":
      return "Proposed";
    case "confirmed":
      return "Confirmed";
    case "rejected":
      return "Rejected";
    case "deferred":
      return "Deferred";
  }
}

function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `spec-comment-${Date.now()}`;
}
