"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import AnnotatedMarkdown, {
  type CreateCommentInput,
  type ResolvedComment,
} from "@/components/document-viewer/AnnotatedMarkdown";
import CopyTicketReferenceButton from "@/components/references/CopyTicketReferenceButton";
import { CopyReferenceControl } from "@/components/references/SpecRefChips";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { tryReanchorExact } from "@/lib/document-comments/anchor";
import { commentAnchorSchema } from "@/lib/document-comments/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import { buildSpecReadCommand } from "@/lib/prompt-editor/spec-reference-contract";
import { parseElementHandle, toDeepLinkElementId } from "@/lib/specs/handles";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import { useSpecDetailQuery, type SpecDetailView } from "@/lib/specs/queries";
import { ticketDetailHref } from "@/lib/tickets/hrefs";
import { formatTicketIdentifier } from "@/lib/tickets/references";
import type {
  SpecApprovalRow,
  SpecCommentRow,
  SpecRevisionElement,
} from "@/lib/specs/schemas";
import { specCommentRowSchema } from "@/lib/specs/schemas";
import type { RequirementStatus, TaskWorkStatus } from "@/lib/specs/phase";
import { cn } from "@/lib/ui/cn";
import { pushToast } from "@/stores/toast.store";

import {
  RenameSpecDialog,
  renameSpecResultSchema,
  type RenameSpecResultView,
} from "./SpecControls";
import SpecDetailViews, {
  initialDetailViewForDeepLink,
  type DetailView,
} from "./SpecDetailViews";
import SpecPhaseFacets from "./SpecPhaseFacets";
import SpecReviewMode from "./SpecReviewMode";

const logger = createClientLogger("spec-studio-detail");

interface RailItem {
  elementId: string;
  handle: string;
  kind: "requirement" | "criterion" | "decision" | "task";
  name: string;
  status: string;
  statusTone: StatusChipTone;
  approval: string;
  approvalTone: StatusChipTone;
  nested: boolean;
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
  const projectName = params.projectName;
  const requestedSlug = params.slug;
  const detailQuery = useSpecDetailQuery(projectName, requestedSlug);
  const detail = detailQuery.data;
  const deepLinkId = useMemo(
    () => resolveDeepLinkId(searchParams.get("el"), detail?.spec.slug),
    [detail?.spec.slug, searchParams],
  );

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
          <>
            <LinkedTicketChips tickets={detail.linkedTickets} />
            {searchParams.get("view") === "review" ? (
              <SpecReviewMode
                detail={detail}
                projectName={projectName}
                highlightedChangeId={searchParams.get("change")}
              />
            ) : (
              <SpecDetailContent
                detail={detail}
                projectName={projectName}
                requestedSlug={requestedSlug}
                initialView={initialDetailViewForDeepLink(
                  searchParams.get("el"),
                  detail.spec.slug,
                )}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function LinkedTicketChips({
  tickets,
}: {
  tickets: SpecDetailView["linkedTickets"];
}): React.JSX.Element | null {
  if (tickets.length === 0) return null;

  return (
    <section
      aria-label="Linked tickets"
      className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-xl py-sm max-768:px-md"
    >
      <span className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Linked tickets
      </span>
      {tickets.map((ticket) => {
        const identifier = formatTicketIdentifier(
          ticket.projectName,
          ticket.number,
        );
        return (
          <div
            key={identifier}
            className="inline-flex min-w-0 items-center rounded-md border border-solid border-border-default bg-bg-raised"
          >
            <Link
              href={ticketDetailHref(ticket.projectName, ticket.number)}
              aria-label={`${identifier} · ${ticket.title}`}
              title={ticket.title}
              className="min-w-0 truncate px-sm py-xs font-mono text-[0.72rem] text-text-primary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              {identifier} · {ticket.title}
            </Link>
            <span className="inline-flex shrink-0 border-x border-y-0 border-solid border-border-default">
              <CopyTicketReferenceButton
                projectName={ticket.projectName}
                ticketNumber={ticket.number}
                title={ticket.title}
                layoutClassName="shrink-0"
              />
            </span>
          </div>
        );
      })}
    </section>
  );
}

function SpecDetailContent({
  detail,
  projectName,
  requestedSlug,
  initialView,
}: {
  detail: SpecDetailView;
  projectName: string;
  requestedSlug: string;
  initialView: DetailView;
}): React.JSX.Element {
  const router = useRouter();
  const [renameError, setRenameError] = useState<string | null>(null);
  const rename = useSpecActionMutation<
    { slug: string; name?: string },
    RenameSpecResultView
  >(projectName, detail.spec.slug, "rename", renameSpecResultSchema);

  function handleRename(input: { slug: string; name?: string }): void {
    rename.mutate(input, {
      onSuccess: (result) => {
        setRenameError(null);
        logger.info("spec_studio.rename.completed", {
          specId: result.spec.id,
          toSlug: result.spec.slug,
        });
        pushToast(
          `Renamed to ${result.spec.slug}; ${result.alias.slug} now resolves as an alias`,
        );
        // The SSE spec-changed event carries the new slug, so the old-slug
        // route would never refresh itself: move to the canonical URL.
        router.replace(
          `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(result.spec.slug)}`,
        );
      },
      onError: (error) => {
        setRenameError(error.message);
        logger.warn("spec_studio.rename.failed", {
          specId: detail.spec.id,
          error: error.message,
        });
      },
    });
  }

  const snapshot = detail.currentRevision;
  const revision = snapshot?.revision.number ?? latestRevisionNumber(detail);
  const sections =
    snapshot?.elements.filter(
      (entry) => entry.version.payload.kind === "section",
    ) ?? [];
  const railItems = snapshot === null ? [] : buildRailItems(detail);

  return (
    <div className="px-xl py-lg max-768:px-md">
      <header className="border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
        <div className="flex flex-wrap items-start justify-between gap-md">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-sm">
              <h1 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
                {detail.spec.name}
              </h1>
              <StatusChip tone="cyan">{detail.spec.slug}</StatusChip>
              {requestedSlug !== detail.spec.slug && (
                <span className="font-mono text-[0.7rem] text-text-tertiary">
                  Opened from alias {requestedSlug}
                </span>
              )}
            </div>
            <div className="mt-sm">
              <SpecPhaseFacets status={detail.status} />
            </div>
          </div>
          <div className="flex items-center gap-sm">
            <RenameSpecDialog
              currentSlug={detail.spec.slug}
              currentName={detail.spec.name}
              pending={rename.isPending}
              error={renameError}
              onRename={handleRename}
            />
            {snapshot?.revision.state === "proposed" && (
              <Link
                href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}?view=review`}
                className="font-mono text-[0.72rem] font-medium text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                Review revision
              </Link>
            )}
            <CopyReferenceControl
              referenceType="spec"
              attrs={{
                projectName,
                slug: detail.spec.slug,
                name: detail.spec.name,
                revision: String(revision),
                readCommand: buildSpecReadCommand(
                  projectName,
                  detail.spec.slug,
                ),
              }}
            />
          </div>
        </div>
      </header>

      {snapshot === null ? (
        <EmptyState>
          <EmptyStateTitle>No authored content</EmptyStateTitle>
          <EmptyStateDesc>
            This spec does not have a current revision to display.
          </EmptyStateDesc>
        </EmptyState>
      ) : (
        <SpecDetailViews
          detail={detail}
          projectName={projectName}
          initialView={initialView}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-xl max-1180:grid-cols-1">
            <div className="grid min-w-0 gap-lg">
              {sections.length === 0 ? (
                <EmptyState>
                  <EmptyStateTitle>No prose sections authored</EmptyStateTitle>
                  <EmptyStateDesc>
                    Requirements, criteria, decisions, and tasks remain
                    available in the structure rail.
                  </EmptyStateDesc>
                </EmptyState>
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
                    revision={revision}
                  />
                ))
              )}
            </div>
            <SpecStructureRail
              items={railItems}
              projectName={projectName}
              slug={detail.spec.slug}
              revision={revision}
            />
          </div>
        </SpecDetailViews>
      )}
    </div>
  );
}

function SpecProseSection({
  section,
  comments,
  projectName,
  slug,
  specId,
  revisionId,
  revision,
}: {
  section: SpecRevisionElement;
  comments: SpecCommentRow[];
  projectName: string;
  slug: string;
  specId: string;
  revisionId: string;
  revision: number;
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
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface"
      data-spec-section={payload.role}
    >
      <div className="flex items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
        <div>
          <h2 className="m-0 font-display text-[0.95rem] font-bold text-text-primary">
            {payload.title}
          </h2>
          <span className="font-mono text-[0.66rem] tracking-[0.08em] text-text-tertiary uppercase">
            Revision {revision}
          </span>
        </div>
        {resolvedComments.length > 0 && (
          <StatusChip tone="amber">
            {resolvedComments.length} comment
            {resolvedComments.length === 1 ? "" : "s"}
          </StatusChip>
        )}
      </div>
      <div className="grid min-h-[220px] grid-cols-[minmax(0,1fr)_220px] gap-md p-md max-900:grid-cols-1">
        <div className="flex min-h-[180px] min-w-0 rounded-md border border-solid border-border-dim bg-bg-base">
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
            onCreateComment={createComment}
          />
        </div>
        <div
          aria-label={`${payload.title} comments`}
          className="grid content-start gap-sm"
        >
          {commentFeedback !== null && (
            <span
              aria-live="polite"
              className={
                comment.isError
                  ? "rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.68rem] text-red"
                  : "rounded-md border border-solid border-border-dim px-md py-sm font-mono text-[0.68rem] text-cyan"
              }
            >
              {commentFeedback}
            </span>
          )}
          {resolvedComments.length === 0 ? (
            <span className="rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.68rem] text-text-tertiary">
              No comments on this section
            </span>
          ) : (
            resolvedComments.map((comment) => (
              <article
                key={comment.id}
                className="rounded-md border border-solid border-border-default bg-bg-raised px-md py-sm"
              >
                <div className="mb-xs flex items-center justify-between gap-sm">
                  <span className="font-mono text-[0.64rem] tracking-[0.06em] text-text-tertiary uppercase">
                    Inline comment
                  </span>
                  <StatusChip tone={comment.stale ? "amber" : "cyan"}>
                    {comment.stale ? "Stale anchor" : "Anchored"}
                  </StatusChip>
                </div>
                <p className="m-0 text-[0.76rem] leading-relaxed text-text-secondary">
                  {comment.note}
                </p>
              </article>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function SpecStructureRail({
  items,
  projectName,
  slug,
  revision,
}: {
  items: RailItem[];
  projectName: string;
  slug: string;
  revision: number;
}): React.JSX.Element {
  return (
    <aside
      aria-label="Spec structure"
      className="sticky top-[calc(var(--topbar-height)+var(--space-lg))] max-h-[calc(100vh-var(--topbar-height)-var(--space-xl))] overflow-y-auto rounded-lg border border-solid border-border-subtle bg-bg-surface max-1180:static max-1180:max-h-none"
    >
      <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Requirements · decisions · tasks
      </div>
      <div className="grid gap-xs p-sm">
        {items.map((item) => (
          <div
            key={item.elementId}
            id={item.handle}
            data-spec-element={item.handle}
            tabIndex={-1}
            className={cn(
              "rounded-md border border-solid border-border-dim bg-bg-base p-sm focus-visible:[outline:2px_solid_var(--color-cyan)]",
              item.nested && "ml-md",
            )}
          >
            <div className="flex items-start justify-between gap-sm">
              <div className="min-w-0">
                <span className="font-mono text-[0.68rem] font-semibold text-cyan">
                  {item.handle}
                </span>
                <p className="mt-xs mb-0 line-clamp-2 text-[0.74rem] leading-snug text-text-secondary">
                  {item.name}
                </p>
              </div>
              <CopyReferenceControl
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
              />
            </div>
            <div className="mt-sm flex flex-wrap gap-xs">
              <StatusChip tone={item.statusTone}>{item.status}</StatusChip>
              <StatusChip tone={item.approvalTone}>{item.approval}</StatusChip>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
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
      };
      const criterionItems = criteria.flatMap((criterion): RailItem[] => {
        if (criterion.version.payload.kind !== "criterion") return [];
        const criterionNumber = criterion.element.number;
        if (criterionNumber === null) return [];
        return [
          {
            elementId: criterion.element.id,
            handle: `${handle}.${criterionNumber}`,
            kind: "criterion",
            name: criterion.version.payload.text,
            status: covered.has(criterion.element.id) ? "Covered" : "Uncovered",
            statusTone: covered.has(criterion.element.id) ? "green" : "amber",
            approval: approval.approval,
            approvalTone: approval.approvalTone,
            nested: true,
          },
        ];
      });
      return [requirement, ...criterionItems];
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

function resolveDeepLinkId(
  rawHandle: string | null,
  slug: string | undefined,
): string | null {
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

function referenceType(
  kind: RailItem["kind"],
): "requirement" | "decision" | "task" {
  if (kind === "criterion") return "requirement";
  return kind;
}

function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `spec-comment-${Date.now()}`;
}
