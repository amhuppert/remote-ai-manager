"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import AnnotatedMarkdown, {
  type CommentComposerCapability,
  type MarkdownAnnotationSource,
  type PersistCommentInput,
  useLiveMarkdownAnchorResolution,
} from "@/components/document-viewer/AnnotatedMarkdown";
import { specSectionClipCapability } from "./spec-section-clip";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import CopyTicketReferenceButton from "@/components/references/CopyTicketReferenceButton";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import type { StatusChipTone } from "@/components/ui/StatusChip";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  type SpecElementMentionAttrs,
  type SpecMentionAttrs,
  type SpecReferenceType,
} from "@/lib/prompt-editor/spec-reference-contract";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import { parseElementHandle, toDeepLinkElementId } from "@/lib/specs/handles";
import {
  useSpecDetailQuery,
  useSpecPlanReviewQuery,
  type SpecDetailView,
} from "@/lib/specs/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  SpecApprovalRow,
  SpecAuthoringStage,
  SpecCommentRow,
  SpecRevisionElement,
} from "@/lib/specs/schemas";
import { specCommentRowSchema } from "@/lib/specs/schemas";
import type { RequirementStatus, TaskWorkStatus } from "@/lib/specs/phase";
import type { SpecPhasePrimary } from "@/lib/specs/phase";
import { cn } from "@/lib/ui/cn";

import { strandedProposals } from "./live-proposals";
import { revisionAdmittedByImport } from "./presentation";
import SpecCommentThreadList, {
  type SpecCommentThreadListHandle,
} from "./SpecCommentThreadList";
import SpecDetailViews, {
  initialDetailViewForDeepLink,
  type DetailView,
} from "./SpecDetailViews";
import SpecPhaseFacets from "./SpecPhaseFacets";
import SpecLifecycleLanes from "./SpecLifecycleLanes";
import {
  partitionSpecCommentThreads,
  type PlacedSpecCommentThread,
} from "./spec-comment-placement";
import { logSpecCommentReanchor } from "./spec-comment-observability";

const logger = createClientLogger("spec-studio-detail");
const commentsLogger = createClientLogger("spec-studio-comments");

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
    const focusTarget = (): boolean => {
      const target = document.getElementById(deepLinkId);
      if (target === null) return false;
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
      return true;
    };
    if (focusTarget()) return;
    // A target can mount a whole read later than `detail` — the launch control
    // waits on the plan preview — so resolving once against the detail would
    // land on nothing exactly when a human follows the CTA that named it.
    const observer = new MutationObserver(() => {
      if (focusTarget()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
            addressedRevisionId={searchParams.get("revision")}
            targetHandle={deepLinkId}
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
  addressedRevisionId = null,
  targetHandle = null,
  onViewChange,
}: {
  detail: SpecDetailView;
  projectName: string;
  requestedSlug: string;
  view: DetailView;
  highlightedChangeId?: string | null;
  /** The proposal a History or lifecycle link addressed (`?revision=`). */
  addressedRevisionId?: string | null;
  targetHandle?: string | null;
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
  const commentThreads = useMemo(
    () => assembleSpecCommentThreads(detail.comments),
    [detail.comments],
  );
  const overviewReviewHostAvailable =
    snapshot !== null &&
    !readOnly &&
    detail.liveProposals.some(
      (proposal) => proposal.snapshot.revision.id === snapshot.revision.id,
    );
  const overviewCommentPlacement = useMemo(
    () =>
      snapshot === null
        ? null
        : partitionSpecCommentThreads({
            surface: "overview",
            reviewHostAvailable: overviewReviewHostAvailable,
            viewedSnapshot: snapshot,
            threads: commentThreads,
          }),
    [commentThreads, overviewReviewHostAvailable, snapshot],
  );
  const railGroups = snapshot === null ? [] : buildRailGroups(detail);
  const planReviewQuery = useSpecPlanReviewQuery(projectName, detail.spec.slug);
  const statePresentation = detailStatePresentation(
    detail.status.phase.primary,
    detail.status.pendingApprovals,
    detail.status.phase.authoringStage ??
      detail.currentRevision?.revision.authoringStage ??
      detail.currentApprovedRevision?.revision.authoringStage,
    planReviewQuery.data,
    detail.status.delivery,
    revisionAdmittedByImport(
      detail.gateAdmissions,
      detail.currentApprovedRevision?.revision.id,
    ),
  );
  const detailHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`;
  const gateHref = `${detailHref}#gate-policy`;
  const reviewHref = `${detailHref}?view=${
    (detail.currentRevision ?? detail.currentApprovedRevision)?.revision
      .authoringStage === "design"
      ? "design"
      : "requirements"
  }`;
  // A proposal an approved revision forked past owes a human act nothing else
  // on this page offers, and the phase it projects into ("approved", say) has
  // a CTA that points somewhere else entirely. It takes the primary action for
  // the same reason a parked delivery gate does: the state is unreachable
  // until a human ends it (#50).
  const strandedProposal = strandedProposals(detail).at(-1) ?? null;
  const strandedActionHref =
    strandedProposal === null
      ? null
      : `${reviewHref}&revision=${encodeURIComponent(strandedProposal.revision.id)}`;
  const stateActionHref =
    statePresentation.view === null
      ? null
      : `${detailHref}?view=${statePresentation.view}`;
  const primaryActionHref = strandedActionHref ?? stateActionHref;
  const primaryActionLabel =
    strandedProposal === null
      ? statePresentation.action
      : `Dismiss stranded revision ${strandedProposal.revision.number}`;
  const primaryActionTone =
    strandedProposal === null ? statePresentation.tone : "amber";
  // An execution running over a proposed revision projects as `executing` with
  // an `in_review` authoring facet, so the state-driven primary action points at
  // evidence and would otherwise leave review mode with no entry point at all.
  const showSecondaryReviewLink =
    statePresentation.view !== "requirements" &&
    statePresentation.view !== "design" &&
    detail.status.phase.authoringFacet === "in_review";
  const specReferenceAttrs: SpecMentionAttrs = {
    projectName,
    slug: detail.spec.slug,
    name: detail.spec.name,
    revision: String(revision),
    readCommand: buildSpecReadCommand(projectName, detail.spec.slug),
  };

  return (
    <>
      <SpecLifecycleLanes detail={detail} deliveryPlan={planReviewQuery.data} />
      <div className="px-xl pt-sm pb-3xl max-768:px-md">
        <SpecDetailViews
          detail={detail}
          projectName={projectName}
          view={view}
          onViewChange={onViewChange}
          highlightedChangeId={highlightedChangeId}
          addressedRevisionId={addressedRevisionId}
          targetHandle={targetHandle}
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
                      href={gateHref}
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
                  {showSecondaryReviewLink && (
                    <Link
                      href={reviewHref}
                      title="Review the proposed revision"
                      className="inline-flex h-[28px] items-center rounded-sm px-sm font-mono text-[0.72rem] font-medium text-text-tertiary no-underline transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                    >
                      Review revision
                    </Link>
                  )}
                  {primaryActionHref !== null &&
                    primaryActionLabel !== null && (
                      <Link
                        href={primaryActionHref}
                        className={cn(
                          "inline-flex h-[28px] items-center rounded-sm border border-solid px-md font-mono text-[0.72rem] font-semibold no-underline transition-colors focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
                          primaryActionTone === "green"
                            ? "border-green-dim bg-green-glow text-green hover:border-green"
                            : primaryActionTone === "amber"
                              ? "border-amber-dim bg-amber-glow text-amber hover:border-amber"
                              : "border-cyan-dim bg-cyan-glow text-cyan hover:border-cyan",
                        )}
                      >
                        {primaryActionLabel}
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
                      placements={
                        overviewCommentPlacement?.coLocated.filter(
                          ({ thread }) =>
                            thread.root.elementId === section.element.id,
                        ) ?? []
                      }
                      projectName={projectName}
                      slug={detail.spec.slug}
                      specId={detail.spec.id}
                      revisionId={snapshot.revision.id}
                      revisionNumber={snapshot.revision.number}
                      revisionState={snapshot.revision.state}
                      specAbandoned={readOnly}
                    />
                  ))
                )}
                {overviewCommentPlacement !== null &&
                  overviewCommentPlacement.fallback.length > 0 && (
                    <section
                      aria-labelledby="overview-fallback-threads-heading"
                      className="border-x-0 border-t-0 border-b border-solid border-border-dim py-lg"
                    >
                      <NarrativeSectionHeading id="overview-fallback-threads-heading">
                        Review threads without inline placement
                      </NarrativeSectionHeading>
                      <div className="mt-md">
                        <SpecCommentThreadList
                          projectName={projectName}
                          slug={detail.spec.slug}
                          specId={detail.spec.id}
                          viewedRevisionId={snapshot.revision.id}
                          viewedRevisionState={snapshot.revision.state}
                          specAbandoned={readOnly}
                          humanTransport
                          placements={overviewCommentPlacement.fallback}
                          label="Review threads without inline placement"
                        />
                      </div>
                    </section>
                  )}
                <SpecLinkedContext detail={detail} />
              </section>
              <SpecStructureRail
                groups={railGroups}
                projectName={projectName}
                slug={detail.spec.slug}
                revision={revision}
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
  view: DetailView | null;
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
        Delivery approval pending — open Delivery
      </Link>
    );
  }
  if (pendingApprovals.length > 0) {
    const target = pendingApprovals.some(
      (pending) => pending.gate === "execution_start",
    )
      ? `${detailHref}?view=delivery`
      : `${detailHref}?view=requirements`;
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
  id,
}: {
  children: string;
  id?: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-sm">
      <h2
        id={id}
        className="m-0 shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
      >
        {children}
      </h2>
      <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
    </div>
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

export function revisionLine(detail: SpecDetailView, revision: number): string {
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
  // An imported revision is admitted on the source's word with no approval row
  // behind it, so it names the admission instead of reading like a human signed
  // it off. Each revision this line mentions answers for itself: an amendment
  // approved here and the imported revision it is based on can appear in the
  // same line, and only one of them is the import's.
  const approvedWord = (revisionId: string): string =>
    revisionAdmittedByImport(detail.gateAdmissions, revisionId)
      ? "admitted by import"
      : "approved";
  const baseSummary =
    base === undefined || baseDate === null || baseDate === undefined
      ? ""
      : ` · rev ${base.number} ${approvedWord(base.id)} ${formatDate(baseDate)}`;
  const stateLabel =
    current.state === "approved" ? approvedWord(current.id) : current.state;
  return `rev ${revision} ${stateLabel}${stateDate === null ? "" : ` ${formatDate(stateDate)}`}${baseSummary}`;
}

function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export function detailStatePresentation(
  phase: SpecPhasePrimary,
  pendingApprovals: SpecDetailView["status"]["pendingApprovals"],
  authoringStage?: SpecAuthoringStage,
  deliveryPlan?: DeliveryPlanReviewView | null,
  delivery?: SpecDetailView["status"]["delivery"],
  /**
   * Whether the frozen revision this banner speaks for — the current approved
   * one — is the revision an import admitted. Asked of that revision rather
   * than of the spec: an imported spec a human later amended is still imported,
   * while the revision the banner names was approved here.
   */
  frozenRevisionImported?: boolean,
): DetailStatePresentation {
  // An imported stage is frozen on the source's word with no approval row
  // behind it, so every banner names the admission instead of reading like a
  // human froze it.
  const frozenBanner = (subject: string): string =>
    frozenRevisionImported === true
      ? `${subject} admitted by import`
      : `${subject} approved`;
  switch (phase) {
    case "draft":
      return {
        tone: "amber",
        banner: "Draft contract",
        description: "Resolve lint and human decisions before proposal.",
        action: "Open gate policy",
        view: "overview",
      };
    case "in_review":
      return {
        tone: "amber",
        banner: "Revision awaits sign-off",
        description:
          "Review semantic changes and satisfy sign-off preconditions.",
        action: "Review revision",
        view: authoringStage === "design" ? "design" : "requirements",
      };
    case "approved":
      if (authoringStage === "requirements") {
        return {
          tone: "green",
          banner: frozenBanner("Requirements"),
          description:
            "The requirements are frozen. Design is next; delivery planning stays locked until design is approved.",
          action: null,
          view: null,
        };
      }
      if (authoringStage !== "design" && authoringStage !== "plan") {
        return {
          tone: "green",
          banner: frozenBanner("Revision"),
          description:
            frozenRevisionImported === true
              ? "The imported revision is frozen. Execution requires an approved delivery-plan candidate."
              : "The approved revision is frozen. Execution requires an approved delivery-plan candidate.",
          action: null,
          view: null,
        };
      }
      if (deliveryPlan === undefined) {
        return {
          tone: "green",
          banner: frozenBanner("Design"),
          description: "The design is frozen. Checking delivery-plan status.",
          action: null,
          view: null,
        };
      }
      if (deliveryPlan === null) {
        return {
          tone: "green",
          banner: frozenBanner("Design"),
          description:
            authoringStage === "plan"
              ? "The legacy Plan revision remains readable as history. Open a delivery plan attempt to author the executable graph."
              : "The design is frozen. Open a delivery plan attempt to author the executable graph.",
          action: "Open delivery plan",
          view: "delivery",
        };
      }
      if (
        deliveryPlan.approval !== null &&
        (deliveryPlan.attempt.status === "approved" ||
          deliveryPlan.attempt.status === "parked")
      ) {
        // The CTA names an act, so it must land on the control that performs
        // it. Addressing the surface alone resolved to the page a human
        // reading the plan was already on, which read as a dead button (#7).
        return {
          tone: "green",
          banner: "Ready to execute",
          description:
            "The approved delivery-plan candidate is the exact graph execution will launch.",
          action: "Open delivery",
          view: "delivery",
        };
      }
      if (deliveryPlan.attempt.status === "draft") {
        return {
          tone: "amber",
          banner: "Delivery plan in draft",
          description:
            "Configure the managed definition and resolve its blocking findings in Workflow Builder.",
          action: "Open delivery",
          view: "delivery",
        };
      }
      if (
        deliveryPlan.attempt.status === "proposed" ||
        deliveryPlan.attempt.status === "approved" ||
        deliveryPlan.attempt.status === "parked"
      ) {
        return {
          tone: "amber",
          banner: "Delivery plan awaits approval",
          description:
            "Review and approve the exact finalized candidate in Workflow Builder.",
          action: "Open delivery",
          view: "delivery",
        };
      }
      if (deliveryPlan.attempt.status === "launched") {
        return {
          tone: "cyan",
          banner: "Delivery plan launched",
          description:
            "The approved candidate has launched; open execution for its current state.",
          action: "Open execution",
          view: "delivery",
        };
      }
      return {
        tone: "amber",
        banner: "Delivery plan attempt abandoned",
        description:
          "Open a replacement attempt to continue delivery planning.",
        action: "Open delivery plan",
        view: "delivery",
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
          action: "Open delivery",
          view: "delivery",
        };
      }
      return {
        tone: "cyan",
        banner: "Execution active",
        description: "Delivery proof is evaluated against the pinned revision.",
        action: "Open requirements",
        view: "requirements",
      };
    case "delivered": {
      // `delivered` is reached either by proof taken here or by an import's
      // external testimony, and the rollup keeps `provenCount` apart from
      // `deliveredExternallyCriterionIds` precisely so this banner cannot
      // report testimony as proof it never took.
      if (
        delivery !== undefined &&
        delivery.deliveredExternallyCriterionIds.length > 0
      ) {
        const externalCount = delivery.deliveredExternallyCriterionIds.length;
        const noun = delivery.totalInScope === 1 ? "criterion" : "criteria";
        return {
          tone: "green",
          banner: "Delivered externally",
          description:
            delivery.provenCount === 0
              ? `${externalCount}/${delivery.totalInScope} in-scope ${noun} delivered externally, none proven here.`
              : `${delivery.provenCount}/${delivery.totalInScope} in-scope ${noun} proven, ${externalCount} delivered externally.`,
          action: null,
          view: null,
        };
      }
      return {
        tone: "green",
        banner: "Delivery proven",
        description: "Every in-scope criterion is proven or explicitly waived.",
        action: null,
        view: null,
      };
    }
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

export function resolveRequestedDetailView(
  rawView: string | null,
  rawHandle: string | null,
  slug: string,
): DetailView {
  if (
    rawView === "overview" ||
    rawView === "requirements" ||
    rawView === "design" ||
    rawView === "delivery" ||
    rawView === "history"
  ) {
    return rawView;
  }
  return rawView === null
    ? initialDetailViewForDeepLink(rawHandle, slug)
    : "overview";
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
  placements,
  projectName,
  slug,
  specId,
  revisionId,
  revisionNumber,
  revisionState,
  specAbandoned,
}: {
  section: SpecRevisionElement;
  placements: readonly PlacedSpecCommentThread[];
  projectName: string;
  slug: string;
  specId: string;
  revisionId: string;
  /** The revision on screen, named by a clip's reference. */
  revisionNumber: number;
  revisionState: "draft" | "proposed" | "approved" | "withdrawn";
  specAbandoned: boolean;
}): React.JSX.Element | null {
  const contentRef = useRef<HTMLDivElement>(null);
  const threadListRef = useRef<SpecCommentThreadListHandle>(null);
  const reanchorLogSignatureRef = useRef<string | null>(null);
  const comment = useSpecActionMutation<
    {
      revisionId: string;
      elementId: string;
      threadId: string;
      parentCommentId: null;
      anchor: PersistCommentInput["anchor"];
      body: string;
      blocking: boolean;
    },
    SpecCommentRow
  >(projectName, slug, "comment", specCommentRowSchema, {
    specId,
    eventTypes: ["spec-attention-changed"],
  });
  const annotationSources = useMemo<MarkdownAnnotationSource[]>(
    () =>
      placements.flatMap(({ thread }) => {
        if (thread.root.revisionId !== revisionId) return [];
        const parsedAnchor = commentAnchorSchema.safeParse(thread.root.anchor);
        if (!parsedAnchor.success) return [];
        return [
          {
            id: thread.threadId,
            anchor: parsedAnchor.data,
            tone: thread.open ? ("active" as const) : ("settled" as const),
            accessibleLabel: `Review thread ${thread.threadId}`,
          },
        ];
      }),
    [placements, revisionId],
  );
  const payload =
    section.version.payload.kind === "section" ? section.version.payload : null;
  const resolvedAnnotations = useLiveMarkdownAnchorResolution(
    annotationSources,
    payload?.body ?? null,
    contentRef,
  );
  const resolvedPlacements = useMemo(() => {
    const annotationsById = new Map(
      resolvedAnnotations.map((annotation) => [annotation.id, annotation]),
    );
    return placements.map((placement) => ({
      ...placement,
      anchorState:
        annotationsById.get(placement.thread.threadId)?.anchorState ??
        placement.anchorState,
    }));
  }, [placements, resolvedAnnotations]);

  useEffect(() => {
    if (annotationSources.length === 0) {
      reanchorLogSignatureRef.current = null;
      return;
    }
    const signature = `${specId}:${revisionId}:${resolvedAnnotations
      .map((annotation) => `${annotation.id}:${annotation.anchorState.status}`)
      .join("|")}`;
    if (reanchorLogSignatureRef.current === signature) return;
    reanchorLogSignatureRef.current = signature;
    logSpecCommentReanchor(commentsLogger, {
      specId,
      revisionId,
      anchorStates: resolvedAnnotations.map(
        (annotation) => annotation.anchorState,
      ),
    });
  }, [annotationSources.length, resolvedAnnotations, revisionId, specId]);

  async function createComment(
    input: Parameters<
      Extract<CommentComposerCapability, { kind: "persist-only" }>["submit"]
    >[0],
  ): Promise<void> {
    const threadId = createClientId();
    try {
      await comment.mutateAsync({
        revisionId,
        elementId: section.element.id,
        threadId,
        parentCommentId: null,
        anchor: input.anchor,
        body: input.note,
        blocking: false,
      });
      commentsLogger.info("spec_studio.comment.root.completed", {
        specId,
        revisionId,
        elementId: section.element.id,
        threadId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      commentsLogger.warn("spec_studio.comment.root.failed", {
        specId,
        revisionId,
        elementId: section.element.id,
        threadId,
        error: message,
      });
      throw error;
    }
  }

  if (payload === null) return null;
  const composer: CommentComposerCapability | undefined =
    revisionState === "proposed" && !specAbandoned
      ? { kind: "persist-only", submit: createComment }
      : undefined;
  // Clip is not gated the way commenting is: it writes to the reader's notepad,
  // not to the spec, so an approved or abandoned revision — exactly the prose
  // worth carrying into notes — stays clippable.
  const clip = specSectionClipCapability({
    projectName,
    slug,
    elementId: section.element.id,
    sectionTitle: payload.title,
    revision: revisionNumber,
  });

  return (
    <section
      className="border-x-0 border-t-0 border-b border-solid border-border-dim py-lg"
      data-spec-section={payload.role}
    >
      <NarrativeSectionHeading>{payload.title}</NarrativeSectionHeading>
      <div
        ref={contentRef}
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
          annotations={resolvedAnnotations}
          annotationNoun={{
            singular: "review thread",
            plural: "review threads",
          }}
          onActivateAnnotation={(target) =>
            threadListRef.current?.focus(target)
          }
          composer={composer}
          clip={clip}
        />
      </div>
      {resolvedPlacements.length > 0 ? (
        <div className="mt-md">
          <SpecCommentThreadList
            ref={threadListRef}
            projectName={projectName}
            slug={slug}
            specId={specId}
            viewedRevisionId={revisionId}
            viewedRevisionState={revisionState}
            specAbandoned={specAbandoned}
            humanTransport
            placements={resolvedPlacements}
            label={`${payload.title} review threads`}
          />
        </div>
      ) : null}
    </section>
  );
}

function SpecStructureRail({
  groups,
  projectName,
  slug,
  revision,
}: {
  groups: RailGroup[];
  projectName: string;
  slug: string;
  revision: number;
}): React.JSX.Element {
  const [expandedItems, setExpandedItems] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const itemIds = groups.flatMap((group) =>
    group.items.map((item) => item.elementId),
  );
  const allExpanded =
    itemIds.length > 0 && itemIds.every((itemId) => expandedItems.has(itemId));
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
  const questions: RailItem[] = detail.questions
    .filter(({ presentation }) => presentation.state === "current")
    .map((question) => ({
      elementId: question.id,
      handle: question.handle,
      kind: "question",
      name: question.text,
      status:
        question.status === "open"
          ? "Open"
          : question.status === "answered"
            ? "Answered"
            : "Withdrawn",
      statusTone:
        question.status === "open"
          ? "amber"
          : question.status === "answered"
            ? "green"
            : "neutral",
      approval: question.status === "open" ? "Needs decision" : "Resolved",
      approvalTone: question.status === "open" ? "amber" : "green",
      nested: false,
      details:
        question.answer === null
          ? []
          : [{ label: "Answer", text: question.answer }],
    }));
  const assumptions: RailItem[] = detail.assumptions
    .filter(({ presentation }) => presentation.state === "current")
    .map((assumption) => ({
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
            : assumption.disposition === "proposed"
              ? "amber"
              : "neutral",
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
  // Settled, but by an import's testimony rather than by proof taken here, so
  // it takes neither the green proof badge nor the amber unfinished ones.
  if (status?.proof === "delivered_externally") {
    return { status: "Delivered externally", statusTone: "neutral" };
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
    case "interrupted":
      return { status: "Interrupted", statusTone: "amber" };
    case "failed":
      return { status: "Failed", statusTone: "red" };
    case "pending":
    case undefined:
      return { status: "Pending", statusTone: "neutral" };
  }
}

export function resolveDeepLinkId(
  rawHandle: string | null,
  slug: string | undefined,
): string | null {
  // Gate-name literals are persisted in notification rows forever, so this
  // mapping is permanent: ?el=delivery focuses the merge-gate panel.
  if (rawHandle === "delivery") return "merge-gate";
  if (rawHandle === "launch") return "delivery-plan-launch";
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
  if (group === "decisions") return "design";
  if (group === "tasks") return "history";
  return "requirements";
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
    case "withdrawn":
      return "Withdrawn";
  }
}

function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `spec-comment-${Date.now()}`;
}
