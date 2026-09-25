"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/AlertDialog";
import { MultilineInput } from "@/components/MultilineInput";
import {
  CompactMarkdown,
  CompactMarkdownDiff,
} from "@/components/markdown/Markdown";
import { CheckIcon, ChevronDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { CheckboxField } from "@/components/ui/Checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { Progress } from "@/components/ui/Progress";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
import {
  commentAnchorSchema,
  type CommentAnchor,
} from "@/lib/document-comments/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  COMBINED_APPROVAL_DIAL,
  authoringApprovalsCollapseIntoSignOff,
  resolveDial,
} from "@/lib/specs/policy";
import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";
import {
  diffRevisions,
  type RevisionElement,
  type RevisionDiffResult,
  type SemanticChange,
} from "@/lib/specs/revision-diff";
import {
  specApprovalRowSchema,
  specCommentRowSchema,
  specRevisionSchema,
  type SpecApprovalRow,
  type SpecRevision,
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

import { reanchorSpecThread, type SpecThreadAnchorState } from "./reanchor";
import SpecCommentThreadList from "./SpecCommentThreadList";
import {
  partitionSpecCommentThreads,
  type PlacedSpecCommentThread,
} from "./spec-comment-placement";
import SpecReadOnlyNotice from "./SpecReadOnlyNotice";

const logger = createClientLogger("spec-studio-review");
const commentsLogger = createClientLogger("spec-studio-comments");

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const signOffResponseSchema = z
  .object({
    revision: specRevisionSchema,
    approval: specApprovalRowSchema.nullable(),
  })
  .strict();

const combinedSignOffResponseSchema = signOffResponseSchema.extend({
  subjectApprovals: z.array(specApprovalRowSchema),
});

/**
 * What a review card renders: a semantic change, or an element the revision
 * carries unchanged while the server still owes its approval (#58).
 */
type ReviewCardChange = {
  elementId: string;
  kind: SpecRevisionElement["element"]["kind"];
  change: "added" | "modified" | "removed" | "unchanged";
  summary: string;
};

const changeTone: Record<ReviewCardChange["change"], StatusChipTone> = {
  added: "green",
  modified: "amber",
  removed: "red",
  unchanged: "neutral",
};

const criterionRailClass: Record<RequirementCriterionReview["change"], string> =
  {
    added: "border-green-dim",
    modified: "border-amber-dim",
    removed: "border-red-dim",
    unchanged: "border-border-default",
  };

interface ReviewElementView {
  entry: SpecRevisionElement;
  handle: string;
  body: string;
}

interface ApprovalTarget {
  subjectKind: "requirement" | "decision";
  elementId: string;
}

type BulkApprovalSubject =
  | ApprovalTarget
  | { subjectKind: "plan"; elementId: null };

interface ReviewChangeGroup {
  key: "sections" | "requirements" | "decisions" | "tasks";
  label: string;
  changes: ReviewCardChange[];
}

interface ReviewReadiness {
  /** Subjects a human approved — never the ones an import carried forward. */
  approved: number;
  /**
   * Subjects the server reports as settled by an import admission. They owe
   * nobody an act, and no human approved them, so they are counted here rather
   * than folded into `approved`.
   */
  importCarried: number;
  total: number;
  approvalsReady: boolean;
  combined: boolean;
  blockingThreadCount: number;
  signOffFindingCount: number;
  activeQuestionCount: number;
  activeAssumptionCount: number;
  /**
   * Everything except the subject approvals — the conditions the combined act
   * cannot supply for the reviewer, and so the only ones that disable it.
   */
  conditionsReady: boolean;
  ready: boolean;
}

interface RequirementCriterionReview {
  elementId: string;
  base: ReviewElementView | null;
  current: ReviewElementView | null;
  change: ReviewCardChange["change"];
}

const reviewGroupOrder: ReviewChangeGroup["key"][] = [
  "sections",
  "requirements",
  "decisions",
  "tasks",
];

const reviewGroupLabel: Record<ReviewChangeGroup["key"], string> = {
  sections: "Sections",
  requirements: "Requirements",
  decisions: "Decisions",
  tasks: "Tasks · plan",
};

const reviewQuestionStatus: Record<
  SpecDetailView["questions"][number]["status"],
  { label: string; tone: StatusChipTone }
> = {
  open: { label: "Open — active attention", tone: "amber" },
  answered: { label: "Answered", tone: "green" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

const reviewAssumptionStatus: Record<
  SpecDetailView["assumptions"][number]["disposition"],
  { label: string; tone: StatusChipTone }
> = {
  proposed: { label: "Proposed — active attention", tone: "amber" },
  confirmed: { label: "Confirmed", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  deferred: { label: "Deferred", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

/**
 * Review of the open draft. The author keeps editing it while a human reads,
 * so every act that approves content echoes the draft's review hash: the
 * server refuses an approval of content the reviewer has not seen.
 */
export default function SpecReviewMode({
  detail,
  projectName,
  highlightedChangeId,
  onComplete,
}: {
  detail: SpecDetailView;
  projectName: string;
  highlightedChangeId: string | null;
  onComplete?(message: string): void;
}): React.JSX.Element {
  const review = detail.draftReview;
  const baseSnapshot = review?.governanceBaseSnapshot ?? null;
  const currentSnapshot = review?.snapshot ?? null;
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signOffDialogOpen, setSignOffDialogOpen] = useState(false);
  const [signOffAcknowledged, setSignOffAcknowledged] = useState(false);

  const diff = useMemo(() => {
    if (currentSnapshot === null) return null;
    return diffRevisions(
      baseSnapshot === null ? [] : toDiffRows(baseSnapshot),
      toDiffRows(currentSnapshot),
      revisionCitationDiffContext(baseSnapshot, currentSnapshot),
    );
  }, [baseSnapshot, currentSnapshot]);
  const commentThreads = useMemo(
    () => assembleSpecCommentThreads(detail.comments),
    [detail.comments],
  );
  const reviewAnchorStates = useMemo(() => {
    const states = new Map<string, SpecThreadAnchorState>();
    if (currentSnapshot === null) return states;
    for (const thread of commentThreads) {
      const anchor = parseAnchor(thread.root.anchor);
      states.set(
        thread.threadId,
        anchor === null
          ? { status: "stale" }
          : reanchorSpecThread(
              anchor,
              bodyForElement(currentSnapshot, thread.root.elementId),
            ),
      );
    }
    return states;
  }, [commentThreads, currentSnapshot]);
  const reviewCommentPlacement = useMemo(
    () =>
      currentSnapshot === null
        ? null
        : partitionSpecCommentThreads({
            surface: "review",
            viewedSnapshot: currentSnapshot,
            threads: commentThreads,
            anchorStates: reviewAnchorStates,
          }),
    [commentThreads, currentSnapshot, reviewAnchorStates],
  );

  useEffect(() => {
    if (highlightedChangeId === null || diff === null) return;
    const target = document.getElementById(
      reviewChangeTargetId(highlightedChangeId),
    );
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [diff, highlightedChangeId]);

  // One act for the whole convergence: the server writes every subject the
  // revision still owes and the sign-off in a single transaction, so the review
  // can no longer come to rest between "everything approved" and "signed off".
  const signOff = useSpecActionMutation<
    { revisionId: string; expectedReviewHash: string },
    z.infer<typeof combinedSignOffResponseSchema>
  >(
    projectName,
    detail.spec.slug,
    "approve-remaining-and-sign-off",
    combinedSignOffResponseSchema,
    {
      specId: detail.spec.id,
      eventTypes: ["spec-revision-changed", "spec-approval-changed"],
    },
  );

  if (detail.spec.abandonedAt !== null) {
    return (
      <div className="mx-auto max-w-[1000px]">
        <SpecReadOnlyNotice reason={detail.spec.abandonedReason} />
      </div>
    );
  }

  if (
    review === null ||
    currentSnapshot === null ||
    diff === null ||
    reviewCommentPlacement === null
  ) {
    return (
      <EmptyState>
        <EmptyStateTitle>Nothing awaiting review</EmptyStateTitle>
        <EmptyStateDesc>
          There is no open draft. Changes become reviewable as soon as a draft
          is opened.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  const detailPath = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`;
  const currentRevision = currentSnapshot.revision;
  const revisionId = currentRevision.id;
  const reviewHash = review.reviewHash;

  function reportError(action: string, mutationError: Error): void {
    setError(mutationError.message);
    setFeedback(null);
    logger.warn("spec_studio.review_action.failed", {
      action,
      specId: detail.spec.id,
      revisionId,
      error: mutationError.message,
    });
  }

  function handleSignOff(): void {
    setError(null);
    setFeedback("Signing off revision…");
    signOff.mutate(
      { revisionId, expectedReviewHash: reviewHash },
      {
        onSuccess: ({ subjectApprovals }) => {
          const message = `Revision ${currentRevision.number} signed off`;
          setFeedback(message);
          logger.info("spec_studio.review_action.completed", {
            action: "approve-remaining-and-sign-off",
            specId: detail.spec.id,
            revisionId,
            approvalCount: subjectApprovals.length,
          });
          onComplete?.(message);
        },
        onError: (mutationError) =>
          reportError("approve-remaining-and-sign-off", mutationError),
      },
    );
  }

  const remainingSubjects = bulkApprovalSubjects(detail, "remaining");
  const outstanding = outstandingApprovalSubjects(detail);
  const changeGroups = groupReviewChanges(
    diff.changeList,
    currentSnapshot,
    baseSnapshot,
  );
  const readiness = reviewReadiness(detail);
  const outstandingElementIds = new Set(
    detail.status.pendingApprovals.flatMap((pending) =>
      pending.elementId === null ? [] : [pending.elementId],
    ),
  );
  // Absence from the outstanding set is not an approval on an imported spec:
  // these elements are settled by the import's admission, and every surface
  // that would otherwise read them as approved has to subtract them.
  const importCarriedElementIds = new Set(
    detail.status.importCarriedApprovals.map((carried) => carried.elementId),
  );
  const unchangedViews = unchangedElementViews(diff, currentSnapshot);
  const awaitingCards = awaitingApprovalCards(
    unchangedViews,
    outstandingElementIds,
  );
  const awaitingCardIds = new Set(awaitingCards.map((card) => card.elementId));
  const commentedElementIds = new Set(
    reviewCommentPlacement.coLocated.map(({ thread }) => thread.root.elementId),
  );
  for (const entry of currentSnapshot.elements) {
    if (
      entry.version.payload.kind === "criterion" &&
      commentedElementIds.has(entry.element.id) &&
      entry.element.parentElementId !== null
    ) {
      commentedElementIds.add(entry.element.parentElementId);
    }
  }
  const commentedCards = commentedUnchangedCards(
    unchangedViews,
    commentedElementIds,
    awaitingCardIds,
  );
  const commentedCardIds = new Set(
    commentedCards.map((card) => card.elementId),
  );
  const quietUnchangedViews = unchangedViews.filter(
    (view) =>
      !awaitingCardIds.has(view.entry.element.id) &&
      !commentedCardIds.has(view.entry.element.id),
  );

  return (
    <div
      data-testid="spec-review-mode"
      className="min-w-0 bg-bg-base pt-[14px] pb-[96px]"
    >
      <TabsRoot defaultValue="semantic">
        <header className="flex items-center justify-between gap-lg border-x-0 border-t-0 border-b border-solid border-border-dim pb-[12px] max-768:flex-col max-768:items-stretch">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-sm">
              <h1 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
                Review {currentSnapshot.revision.authoringStage}-stage revision{" "}
                {currentSnapshot.revision.number}
              </h1>
              <span className="font-mono text-[0.7rem] text-text-tertiary">
                open draft ·{" "}
                {baseSnapshot === null
                  ? "initial revision"
                  : `over approved revision ${baseSnapshot.revision.number}`}
              </span>
            </div>
            <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
              The author can keep editing while you review. An edited item needs
              approval again.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-sm max-768:justify-between">
            {/* State, not an act: the remaining subjects are approved by the
                sign-off act in the footer, so a second bulk button here would
                reopen the gap between "all approved" and "signed off". */}
            {readiness.combined ? (
              <StatusChip tone="green">Sign-off approves all items</StatusChip>
            ) : remainingSubjects.length === 0 ? (
              // "All approved" would credit a human with the subjects the
              // import carried, which no human read.
              readiness.importCarried > 0 ? (
                <StatusChip tone="green">
                  {readiness.importCarried} carried from import
                </StatusChip>
              ) : (
                <StatusChip tone="green">All approved</StatusChip>
              )
            ) : (
              <StatusChip tone="amber">
                {remainingSubjects.length} awaiting approval
              </StatusChip>
            )}
            <TabsList asChild layoutClassName="max-768:grow">
              <div className="flex shrink-0 items-center rounded-md border border-solid border-border-subtle bg-bg-surface p-[2px]">
                <TabsTrigger
                  value="semantic"
                  asChild
                  layoutClassName="max-768:grow max-768:basis-0"
                >
                  <button
                    type="button"
                    className="h-6 cursor-pointer rounded-sm border-0 bg-transparent px-[12px] font-mono text-[0.7rem] font-semibold whitespace-nowrap text-text-tertiary transition-colors outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[state=active]:bg-bg-elevated data-[state=active]:text-text-primary max-768:h-11"
                  >
                    Semantic changes
                  </button>
                </TabsTrigger>
                <TabsTrigger
                  value="raw"
                  asChild
                  layoutClassName="max-768:grow max-768:basis-0"
                >
                  <button
                    type="button"
                    className="h-6 cursor-pointer rounded-sm border-0 bg-transparent px-[12px] font-mono text-[0.7rem] font-semibold whitespace-nowrap text-text-tertiary transition-colors outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 data-[state=active]:bg-bg-elevated data-[state=active]:text-text-primary max-768:h-11"
                  >
                    Raw diff
                  </button>
                </TabsTrigger>
              </div>
            </TabsList>
          </div>
        </header>

        {feedback !== null && (
          <div
            aria-live="polite"
            className="pt-sm font-mono text-[0.7rem] text-cyan"
          >
            {feedback}
          </div>
        )}
        {error !== null && (
          <p
            role="alert"
            className="mb-md rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.72rem] text-red"
          >
            {error}
          </p>
        )}

        <ReviewRequestNotes notes={review.notes} />
        <RevisionPremises
          snapshot={currentSnapshot}
          baseSnapshot={baseSnapshot}
        />

        <TabsContent value="semantic">
          <section
            aria-label="Semantic changes"
            className="mt-[14px] rounded-lg border border-solid border-border-subtle bg-bg-base px-[20px] py-[18px] max-768:px-md max-768:py-md"
          >
            {diff.changeList.length === 0 &&
            awaitingCards.length === 0 &&
            commentedCards.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No semantic changes</EmptyStateTitle>
                <EmptyStateDesc>The draft matches its base.</EmptyStateDesc>
              </EmptyState>
            ) : (
              <>
                {diff.changeList.length === 0 ? (
                  <p className="m-0 font-mono text-[0.76rem] font-semibold text-text-primary">
                    No semantic changes — the draft matches its base.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-md max-768:flex-col max-768:items-stretch">
                      <div className="min-w-0">
                        <p className="m-0 font-mono text-[0.76rem] font-semibold text-text-primary">
                          {diff.changeList.length}{" "}
                          {pluralize(diff.changeList.length, "change")} across{" "}
                          {changeGroups.length}{" "}
                          {pluralize(changeGroups.length, "kind")}
                        </p>
                        <p className="mt-xs mb-0 truncate font-mono text-[0.7rem] text-text-tertiary">
                          Approved unchanged elements carry forward quietly.
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-md font-mono text-[0.7rem] text-text-tertiary">
                        <span className="inline-flex items-center gap-xs">
                          <span className="h-[10px] w-[10px] rounded-sm border border-solid border-green-dim bg-green-glow" />
                          Added
                        </span>
                        <span className="inline-flex items-center gap-xs">
                          <span className="h-[10px] w-[10px] rounded-sm border border-solid border-red-dim bg-red-glow" />
                          Removed
                        </span>
                      </div>
                    </div>

                    <div className="mt-[14px] grid gap-[14px]">
                      {changeGroups.map((group) => (
                        <section
                          key={group.key}
                          aria-labelledby={`review-group-${group.key}`}
                        >
                          <div className="mb-sm flex items-center gap-sm">
                            <h2
                              id={`review-group-${group.key}`}
                              className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase"
                            >
                              {group.label}
                            </h2>
                            <span className="font-mono text-[0.7rem] text-text-tertiary">
                              {group.changes.length}{" "}
                              {pluralize(group.changes.length, "change")}
                            </span>
                            <span className="h-px min-w-0 grow bg-border-dim" />
                          </div>
                          <div className="grid gap-sm">
                            {group.changes.map((change) => (
                              <ReviewChangeCard
                                key={change.elementId}
                                change={change}
                                criteria={requirementCriteriaForReview(
                                  change,
                                  diff,
                                  currentSnapshot,
                                  baseSnapshot,
                                )}
                                detail={detail}
                                projectName={projectName}
                                baseSnapshot={baseSnapshot}
                                currentSnapshot={currentSnapshot}
                                placements={reviewCommentPlacement.coLocated}
                                combinedApproval={readiness.combined}
                                reviewHash={reviewHash}
                                onFeedback={setFeedback}
                                onError={setError}
                              />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </>
                )}

                {awaitingCards.length > 0 && (
                  <section
                    aria-labelledby="review-group-awaiting-approval"
                    className="mt-[14px]"
                  >
                    <div className="mb-sm flex items-center gap-sm">
                      <h2
                        id="review-group-awaiting-approval"
                        className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase"
                      >
                        Awaiting approval
                      </h2>
                      <span className="font-mono text-[0.7rem] text-text-tertiary">
                        {awaitingCards.length} unchanged{" "}
                        {pluralize(awaitingCards.length, "element")}
                      </span>
                      <span className="h-px min-w-0 grow bg-border-dim" />
                    </div>
                    <p className="mt-0 mb-sm font-mono text-[0.7rem] text-text-tertiary">
                      Carried unchanged from the base revision without ever
                      being approved — review and approve each item; sign-off
                      approves whatever remains.
                    </p>
                    <div className="grid gap-sm">
                      {awaitingCards.map((change) => (
                        <ReviewChangeCard
                          key={change.elementId}
                          change={change}
                          criteria={requirementCriteriaForReview(
                            change,
                            diff,
                            currentSnapshot,
                            baseSnapshot,
                          )}
                          detail={detail}
                          projectName={projectName}
                          baseSnapshot={baseSnapshot}
                          currentSnapshot={currentSnapshot}
                          placements={reviewCommentPlacement.coLocated}
                          combinedApproval={readiness.combined}
                          reviewHash={reviewHash}
                          onFeedback={setFeedback}
                          onError={setError}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {commentedCards.length > 0 && (
                  <section
                    aria-labelledby="review-group-commented-unchanged"
                    className="mt-[14px]"
                  >
                    <div className="mb-sm flex items-center gap-sm">
                      <h2
                        id="review-group-commented-unchanged"
                        className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase"
                      >
                        Commented unchanged
                      </h2>
                      <span className="font-mono text-[0.7rem] text-text-tertiary">
                        {commentedCards.length} current{" "}
                        {pluralize(commentedCards.length, "thread host")}
                      </span>
                      <span className="h-px min-w-0 grow bg-border-dim" />
                    </div>
                    <p className="mt-0 mb-sm font-mono text-[0.7rem] text-text-tertiary">
                      The revision carries these subjects unchanged, but their
                      current review threads still need a visible host.
                    </p>
                    <div className="grid gap-sm">
                      {commentedCards.map((change) => (
                        <ReviewChangeCard
                          key={change.elementId}
                          change={change}
                          criteria={requirementCriteriaForReview(
                            change,
                            diff,
                            currentSnapshot,
                            baseSnapshot,
                          )}
                          detail={detail}
                          projectName={projectName}
                          baseSnapshot={baseSnapshot}
                          currentSnapshot={currentSnapshot}
                          placements={reviewCommentPlacement.coLocated}
                          combinedApproval={readiness.combined}
                          reviewHash={reviewHash}
                          onFeedback={setFeedback}
                          onError={setError}
                        />
                      ))}
                    </div>
                  </section>
                )}

                <UnchangedApprovals
                  views={quietUnchangedViews}
                  importCarriedElementIds={importCarriedElementIds}
                />
              </>
            )}
          </section>
          <div className="h-xl" />
        </TabsContent>

        <TabsContent value="raw">
          <section className="mt-[14px] rounded-lg border border-solid border-border-subtle bg-bg-base">
            <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
              <h2 className="m-0 font-display text-[0.88rem] font-bold text-text-primary">
                Raw diff
              </h2>
              <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary uppercase">
                Secondary view — the semantic change list is the review
                contract; use the raw diff for spot checks.
              </p>
            </div>
            <pre className="m-0 max-h-[65vh] overflow-auto p-md font-mono text-[0.72rem] leading-relaxed whitespace-pre-wrap text-text-secondary">
              {formatRawDiff(baseSnapshot, currentSnapshot, diff.changeList)}
            </pre>
          </section>
          <div className="h-xl" />
        </TabsContent>
      </TabsRoot>

      <ReviewQuestionsPanel detail={detail} detailPath={detailPath} />

      {reviewCommentPlacement.fallback.length > 0 ? (
        <section
          aria-labelledby="review-fallback-threads-heading"
          className="mt-lg scroll-mt-[180px] rounded-lg border border-solid border-border-subtle bg-bg-base px-[20px] py-[18px] max-768:scroll-mt-[260px] max-768:px-md max-768:py-md"
        >
          <h2
            id="review-fallback-threads-heading"
            className="mt-0 mb-md font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase"
          >
            Historical &amp; orphaned review threads
          </h2>
          <SpecCommentThreadList
            projectName={projectName}
            slug={detail.spec.slug}
            specId={detail.spec.id}
            viewedRevisionId={currentSnapshot.revision.id}
            viewedRevisionState={currentSnapshot.revision.state}
            specAbandoned={false}
            humanTransport
            placements={reviewCommentPlacement.fallback}
            label="Historical and orphaned review threads"
          />
        </section>
      ) : null}

      <footer
        data-testid="review-readiness"
        className="sticky bottom-0 z-[150] flex items-center gap-lg border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-surface px-sm py-md shadow-[0_-12px_32px_var(--color-bg-void)] max-768:flex-col max-768:items-stretch"
      >
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-sm">
            {readiness.combined ? (
              <StatusChip tone="green">Sign-off approves all items</StatusChip>
            ) : (
              <>
                <span className="font-mono text-[0.78rem] font-bold text-text-primary tabular-nums">
                  {readiness.approved}/{readiness.total} approved
                </span>
                {readiness.importCarried > 0 && (
                  <StatusChip tone="neutral">
                    {readiness.importCarried} carried from import
                  </StatusChip>
                )}
                <StatusChip tone={readiness.approvalsReady ? "green" : "amber"}>
                  {readiness.approvalsReady
                    ? readiness.importCarried > 0
                      ? "Nothing awaiting approval"
                      : "Approvals complete"
                    : "Approvals incomplete"}
                </StatusChip>
              </>
            )}
            <StatusChip
              tone={readiness.blockingThreadCount === 0 ? "green" : "amber"}
            >
              {readiness.blockingThreadCount === 0
                ? "Threads resolved"
                : `${readiness.blockingThreadCount} blocking ${pluralize(readiness.blockingThreadCount, "thread")}`}
            </StatusChip>
            <StatusChip
              tone={readiness.signOffFindingCount === 0 ? "green" : "amber"}
            >
              {readiness.signOffFindingCount === 0
                ? "Sign-off lint clear"
                : `${readiness.signOffFindingCount} sign-off ${pluralize(readiness.signOffFindingCount, "finding")}`}
            </StatusChip>
            <StatusChip
              tone={readiness.activeQuestionCount === 0 ? "green" : "cyan"}
            >
              {readiness.activeQuestionCount === 0
                ? "No open questions"
                : `${readiness.activeQuestionCount} open ${pluralize(readiness.activeQuestionCount, "question")} · attention`}
            </StatusChip>
            <StatusChip
              tone={readiness.activeAssumptionCount === 0 ? "green" : "cyan"}
            >
              {readiness.activeAssumptionCount === 0
                ? "No proposed assumptions"
                : `${readiness.activeAssumptionCount} proposed ${pluralize(readiness.activeAssumptionCount, "assumption")} · attention`}
            </StatusChip>
          </div>
          {readiness.total > 0 && (
            <Progress
              aria-label="Review approval progress"
              value={readiness.approved}
              max={readiness.total}
              tone={readiness.ready ? "accent" : "warning"}
              layoutClassName="mt-sm max-w-[420px] max-768:max-w-none"
            />
          )}
        </div>
        <AlertDialog
          open={signOffDialogOpen}
          onOpenChange={(open) => {
            setSignOffDialogOpen(open);
            if (open) setSignOffAcknowledged(false);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              variant={readiness.conditionsReady ? "primary" : "default"}
              touch
              loading={signOff.isPending}
              // Outstanding approvals no longer block the act — the act writes
              // them. Only the conditions no approval can satisfy do.
              disabled={!readiness.conditionsReady}
              title={
                readiness.conditionsReady
                  ? "Approve the remaining subjects and freeze this revision"
                  : readinessBlockerSummary(readiness)
              }
            >
              {outstanding.length === 0
                ? `Sign off revision ${currentSnapshot.revision.number}`
                : `Approve ${outstanding.length} remaining and sign off revision ${currentSnapshot.revision.number}`}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="default">
            <AlertDialogTitle>
              Sign off revision {currentSnapshot.revision.number}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This explicit human act freezes revision{" "}
              {currentSnapshot.revision.number} as the approved, immutable
              content of {detail.spec.slug}. Executions pin it; later changes
              require a new revision.
            </AlertDialogDescription>
            {outstanding.length > 0 && (
              <div
                data-testid="combined-sign-off-subjects"
                className="mb-lg grid gap-xs rounded-md border border-solid border-amber-dim bg-bg-base px-md py-sm font-mono text-[0.72rem] text-text-secondary"
              >
                <span className="text-text-primary">
                  Approved by this act, one record each:
                </span>
                {outstanding.map((subject) => (
                  <span
                    key={`${subject.gate}:${subject.elementId ?? "plan"}`}
                    className="flex items-center gap-sm"
                  >
                    <StatusChip tone="amber">{subject.gate}</StatusChip>
                    {subject.subject}
                  </span>
                ))}
              </div>
            )}
            <div className="mb-lg grid gap-sm rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm font-mono text-[0.72rem] text-text-secondary">
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                {readiness.combined
                  ? "Combined approval — this sign-off approves every item"
                  : readiness.importCarried > 0
                    ? `${readiness.approved}/${readiness.total} review approvals recorded, ${readiness.importCarried} carried from import`
                    : `${readiness.approved}/${readiness.total} review approvals recorded`}
              </span>
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                Blocking threads resolved
              </span>
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                No server lint finding blocks sign-off
              </span>
            </div>
            <CheckboxField
              checked={signOffAcknowledged}
              onCheckedChange={(checked) =>
                setSignOffAcknowledged(checked === true)
              }
              label={`I reviewed the semantic change list and approve revision ${currentSnapshot.revision.number} as a whole.`}
            />
            <AlertDialogActions layoutClassName="mt-lg">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!signOffAcknowledged}
                onClick={handleSignOff}
              >
                {outstanding.length === 0
                  ? `Sign off — freeze revision ${currentSnapshot.revision.number}`
                  : `Approve ${outstanding.length} and sign off — freeze revision ${currentSnapshot.revision.number}`}
              </AlertDialogAction>
            </AlertDialogActions>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
    </div>
  );
}

/**
 * The author's disposition document from their latest review request
 * (design §8).
 *
 * It sits above the change list on purpose: review converges when the reviewer
 * reads what the round claims to have changed and closed before re-deriving it
 * from the diff.
 */
function ReviewRequestNotes({
  notes,
}: {
  notes: string | null;
}): React.JSX.Element | null {
  if (notes === null) return null;
  return (
    <section
      data-testid="review-request-notes"
      aria-label="Review request notes"
      className="mt-[14px] rounded-lg border border-solid border-border-subtle bg-bg-surface px-md py-sm"
    >
      <h2 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
        Author&rsquo;s disposition
      </h2>
      <div className="mt-xs min-w-0">
        <CompactMarkdown content={notes} />
      </div>
    </section>
  );
}

function RevisionPremises({
  snapshot,
  baseSnapshot,
}: {
  snapshot: SpecRevisionSnapshot;
  baseSnapshot: SpecRevisionSnapshot | null;
}): React.JSX.Element {
  const citations = snapshot.assumptionCitations.toSorted(
    (left, right) =>
      left.snapshot.number - right.snapshot.number ||
      left.elementId.localeCompare(right.elementId),
  );
  const contractChanged =
    baseSnapshot !== null &&
    baseSnapshot.revision.citationContractVersion !==
      snapshot.revision.citationContractVersion;

  return (
    <section
      aria-label="Revision premises"
      className="mt-[14px] overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Revision premises
        </h2>
        <StatusChip tone={contractChanged ? "amber" : "neutral"}>
          {contractChanged
            ? `Citation contract ${baseSnapshot.revision.citationContractVersion} → ${snapshot.revision.citationContractVersion}`
            : `Citation contract ${snapshot.revision.citationContractVersion}`}
        </StatusChip>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {citations.length} pinned {pluralize(citations.length, "citation")}
        </span>
      </div>
      {citations.length === 0 ? (
        <p className="m-0 px-md py-sm font-mono text-[0.7rem] text-text-tertiary">
          This revision cites no assumptions.
        </p>
      ) : (
        <div className="grid gap-sm p-md">
          {citations.map((citation) => {
            const element = viewForElement(snapshot, citation.elementId);
            return (
              <article
                key={`${citation.elementId}:${citation.assumptionId}`}
                className="rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm"
              >
                <div className="flex flex-wrap items-center gap-sm">
                  <span className="font-mono text-[0.72rem] font-bold text-cyan">
                    A{citation.snapshot.number}
                  </span>
                  <StatusChip
                    tone={
                      citation.snapshot.disposition === "confirmed"
                        ? "green"
                        : citation.snapshot.disposition === "rejected"
                          ? "red"
                          : citation.snapshot.disposition === "proposed"
                            ? "amber"
                            : "neutral"
                    }
                  >
                    {capitalize(citation.snapshot.disposition)}
                  </StatusChip>
                  <span className="font-mono text-[0.68rem] text-text-tertiary">
                    Cited by {element?.handle ?? citation.elementId}
                  </span>
                  <span className="font-mono text-[0.68rem] text-text-tertiary">
                    Record v{citation.snapshot.recordVersion}
                  </span>
                </div>
                <div className="mt-xs min-w-0 text-[0.84rem] leading-relaxed text-text-primary">
                  <CompactMarkdown content={citation.snapshot.text} />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function groupReviewChanges(
  changes: SemanticChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ReviewChangeGroup[] {
  const groups = new Map<ReviewChangeGroup["key"], ReviewCardChange[]>();
  for (const change of reviewCardChanges(
    changes,
    currentSnapshot,
    baseSnapshot,
  )) {
    const key = reviewGroupKey(change.kind);
    const group = groups.get(key) ?? [];
    group.push(change);
    groups.set(key, group);
  }

  return reviewGroupOrder.flatMap((key) => {
    const group = groups.get(key);
    if (group === undefined) return [];
    return [
      {
        key,
        label: reviewGroupLabel[key],
        changes:
          key === "requirements"
            ? requirementCardChanges(
                orderCriteriaUnderRequirements(
                  group,
                  currentSnapshot,
                  baseSnapshot,
                ),
                currentSnapshot,
                baseSnapshot,
              )
            : group,
      },
    ];
  });
}

function reviewCardChanges(
  changes: SemanticChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ReviewCardChange[] {
  const cards: ReviewCardChange[] = [];
  const representedElementIds = new Set<string>();

  for (const change of changes) {
    if (
      change.kind === "assumption_citation" ||
      change.kind === "citation_contract"
    ) {
      continue;
    }
    cards.push(change);
    representedElementIds.add(change.elementId);
  }

  for (const change of changes) {
    if (
      change.kind !== "assumption_citation" ||
      representedElementIds.has(change.elementId)
    ) {
      continue;
    }
    const element =
      viewForElement(currentSnapshot, change.elementId) ??
      viewForElement(baseSnapshot, change.elementId);
    if (element === null) continue;
    cards.push({
      elementId: change.elementId,
      kind: element.entry.element.kind,
      change: "modified",
      summary: change.summary,
    });
    representedElementIds.add(change.elementId);
  }

  return cards;
}

function requirementCardChanges(
  changes: ReviewCardChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ReviewCardChange[] {
  const requirementIds = new Set(
    changes
      .filter((change) => change.kind === "requirement")
      .map((change) => change.elementId),
  );
  return changes.filter((change) => {
    if (change.kind !== "criterion") return true;
    const criterion =
      viewForElement(currentSnapshot, change.elementId) ??
      viewForElement(baseSnapshot, change.elementId);
    const parentId = criterion?.entry.element.parentElementId;
    return parentId === null || parentId === undefined
      ? true
      : !requirementIds.has(parentId);
  });
}

function requirementCriteriaForReview(
  change: ReviewCardChange,
  diff: RevisionDiffResult,
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): RequirementCriterionReview[] {
  if (change.kind !== "requirement") return [];

  const orderedIds = currentSnapshot.elements.flatMap((entry) =>
    entry.version.payload.kind === "criterion" &&
    entry.element.parentElementId === change.elementId
      ? [entry.element.id]
      : [],
  );
  for (const entry of baseSnapshot?.elements ?? []) {
    if (
      entry.version.payload.kind === "criterion" &&
      entry.element.parentElementId === change.elementId &&
      !orderedIds.includes(entry.element.id)
    ) {
      orderedIds.push(entry.element.id);
    }
  }

  const changesById = new Map(
    diff.classifications.map((classification) => [
      classification.elementId,
      classification.classification,
    ]),
  );
  return orderedIds.map((elementId) => ({
    elementId,
    base: viewForElement(baseSnapshot, elementId),
    current: viewForElement(currentSnapshot, elementId),
    change: changesById.get(elementId) ?? "unchanged",
  }));
}

// Authoring appends new elements at the end of the snapshot, so the change
// list can separate a criterion from the requirement it belongs to. Anchor
// each criterion to its parent requirement's document position; elements only
// present in the base revision sort after all current ones.
function orderCriteriaUnderRequirements(
  changes: ReviewCardChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ReviewCardChange[] {
  const documentOrder = new Map<
    string,
    { position: number; parentElementId: string | null }
  >();
  const removedOffset = currentSnapshot.elements.length;
  baseSnapshot?.elements.forEach((entry, index) => {
    documentOrder.set(entry.element.id, {
      position: removedOffset + index,
      parentElementId: entry.element.parentElementId,
    });
  });
  currentSnapshot.elements.forEach((entry, index) => {
    documentOrder.set(entry.element.id, {
      position: index,
      parentElementId: entry.element.parentElementId,
    });
  });

  const sortKey = (change: ReviewCardChange): [number, number] => {
    const info = documentOrder.get(change.elementId);
    if (info === undefined) return [Number.MAX_SAFE_INTEGER, 0];
    const parent =
      change.kind === "criterion" && info.parentElementId !== null
        ? documentOrder.get(info.parentElementId)
        : undefined;
    return parent === undefined
      ? [info.position, 0]
      : [parent.position, info.position + 1];
  };

  return changes
    .map((change) => ({ change, key: sortKey(change) }))
    .toSorted(
      (left, right) => left.key[0] - right.key[0] || left.key[1] - right.key[1],
    )
    .map(({ change }) => change);
}

function reviewGroupKey(
  kind: ReviewCardChange["kind"],
): ReviewChangeGroup["key"] {
  switch (kind) {
    case "section":
      return "sections";
    case "requirement":
    case "criterion":
      return "requirements";
    case "decision":
      return "decisions";
    case "task":
      return "tasks";
  }
}

function unchangedElementViews(
  diff: RevisionDiffResult,
  currentSnapshot: SpecRevisionSnapshot,
): ReviewElementView[] {
  return diff.classifications.flatMap((classification) => {
    if (
      classification.classification !== "unchanged" ||
      classification.kind === "criterion"
    )
      return [];
    const view = viewForElement(currentSnapshot, classification.elementId);
    return view === null ? [] : [view];
  });
}

/**
 * Unchanged elements the server still owes an approval for, shaped as review
 * cards. Unchanged against the immediate parent is not approved (#58): a
 * draft reopened over a withdrawn attempt carries content no human ever
 * approved, and each such subject must be reviewable and approvable on its
 * own rather than only through the bulk sign-off act.
 */
function awaitingApprovalCards(
  views: ReviewElementView[],
  outstandingElementIds: ReadonlySet<string>,
): ReviewCardChange[] {
  return views.flatMap((view) => {
    if (!outstandingElementIds.has(view.entry.element.id)) return [];
    const payload = view.entry.version.payload;
    if (payload.kind !== "requirement" && payload.kind !== "decision") {
      return [];
    }
    return [
      {
        elementId: view.entry.element.id,
        kind: payload.kind,
        change: "unchanged" as const,
        summary: `Unchanged ${payload.kind}: ${
          payload.kind === "requirement" ? payload.statement : payload.title
        }`,
      },
    ];
  });
}

function commentedUnchangedCards(
  views: ReviewElementView[],
  commentedElementIds: ReadonlySet<string>,
  excludedElementIds: ReadonlySet<string>,
): ReviewCardChange[] {
  return views.flatMap((view) => {
    const elementId = view.entry.element.id;
    if (
      !commentedElementIds.has(elementId) ||
      excludedElementIds.has(elementId)
    ) {
      return [];
    }
    const payload = view.entry.version.payload;
    const label =
      payload.kind === "section"
        ? payload.title
        : payload.kind === "requirement"
          ? payload.statement
          : payload.kind === "decision"
            ? payload.title
            : payload.kind === "task"
              ? payload.title
              : payload.text;
    return [
      {
        elementId,
        kind: payload.kind,
        change: "unchanged" as const,
        summary: `Unchanged ${payload.kind}: ${label}`,
      },
    ];
  });
}

/**
 * Unchanged elements nobody is being asked to approve. Elements the server
 * still owes an approval for are promoted to full review cards in the
 * awaiting-approval section instead (#58), so a chip here is either an
 * approval carried forward or a subject the import admitted — never an
 * outstanding one.
 */
function UnchangedApprovals({
  views,
  importCarriedElementIds,
}: {
  views: ReviewElementView[];
  /**
   * Unchanged and unapproved at once: the import that created these admitted
   * them, so nobody is being asked for them and no human ever read them. The
   * green check and the "approvals carried forward" caption would claim the
   * act that never happened, which is why they get a chip of their own.
   */
  importCarriedElementIds: ReadonlySet<string>;
}): React.JSX.Element | null {
  if (views.length === 0) return null;

  const importCarriedCount = views.filter((view) =>
    importCarriedElementIds.has(view.entry.element.id),
  ).length;

  return (
    <div className="mt-lg rounded-md border border-dashed border-border-default px-md py-sm">
      <Collapsible>
        <CollapsibleTrigger layoutClassName="w-full">
          {views.length} unchanged {pluralize(views.length, "element")} —{" "}
          {importCarriedCount > 0
            ? `${importCarriedCount} carried from the import, approved by no human`
            : "approvals carried forward quietly"}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-xs pt-sm">
            {views.map((view) =>
              importCarriedElementIds.has(view.entry.element.id) ? (
                <StatusChip key={view.entry.element.id} tone="neutral">
                  {view.handle} — carried from import
                </StatusChip>
              ) : (
                <StatusChip
                  key={view.entry.element.id}
                  tone="green"
                  icon={<CheckIcon size={12} className="text-green" />}
                >
                  {view.handle}
                </StatusChip>
              ),
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ReviewQuestionsPanel({
  detail,
  detailPath,
}: {
  detail: SpecDetailView;
  detailPath: string;
}): React.JSX.Element {
  const questions = detail.questions.filter(
    ({ presentation }) => presentation.state === "current",
  );
  const assumptions = detail.assumptions.filter(
    ({ presentation }) => presentation.state === "current",
  );
  const unresolvedCount =
    questions.filter((question) => question.status === "open").length +
    assumptions.filter((assumption) => assumption.disposition === "proposed")
      .length;

  return (
    <section
      aria-label="Questions and assumptions in this revision"
      className="mt-lg overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Questions &amp; assumptions in this revision
        </h2>
        <StatusChip tone={unresolvedCount === 0 ? "green" : "cyan"}>
          {unresolvedCount === 0
            ? "All resolved"
            : `${unresolvedCount} active attention`}
        </StatusChip>
        <Link
          href={`${detailPath}?view=requirements`}
          className="ml-auto inline-flex min-h-[28px] items-center font-mono text-[0.7rem] font-semibold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
        >
          Resolve in Requirements
        </Link>
      </div>

      {questions.length === 0 && assumptions.length === 0 ? (
        <p className="m-0 px-md py-lg font-mono text-[0.72rem] text-text-tertiary">
          No questions or assumptions recorded for this spec.
        </p>
      ) : (
        <div>
          {questions.map((question) => {
            const status = reviewQuestionStatus[question.status];
            return (
              <div
                key={question.id}
                className="flex items-start gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm max-768:flex-wrap"
              >
                <span className="w-[34px] shrink-0 font-mono text-[0.72rem] font-bold text-cyan-dim">
                  {question.handle}
                </span>
                <div className="min-w-0 grow">
                  <CompactMarkdown content={question.text} />
                </div>
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </div>
            );
          })}
          {assumptions.map((assumption) => {
            const status = reviewAssumptionStatus[assumption.disposition];
            return (
              <div
                key={assumption.id}
                className="flex items-start gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm max-768:flex-wrap"
              >
                <span className="w-[34px] shrink-0 font-mono text-[0.72rem] font-bold text-cyan-dim">
                  {assumption.handle}
                </span>
                <div className="min-w-0 grow">
                  <CompactMarkdown content={assumption.text} />
                </div>
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function reviewAttentionCount(detail: SpecDetailView): number {
  if (detail.spec.abandonedAt !== null || detail.draftReview === null) return 0;
  const readiness = reviewReadiness(detail);
  return (
    // An import-carried subject asks nobody for anything, so it is not
    // attention owed even though no human approved it.
    (readiness.combined
      ? 0
      : readiness.total - readiness.approved - readiness.importCarried) +
    readiness.blockingThreadCount +
    readiness.signOffFindingCount
  );
}

function reviewReadiness(detail: SpecDetailView): ReviewReadiness {
  const snapshot = detail.draftReview?.snapshot ?? null;
  if (snapshot === null) {
    return {
      approved: 0,
      importCarried: 0,
      total: 0,
      approvalsReady: false,
      combined: false,
      blockingThreadCount: 0,
      signOffFindingCount: 0,
      activeQuestionCount: 0,
      activeAssumptionCount: 0,
      conditionsReady: false,
      ready: false,
    };
  }

  const combined = authoringApprovalsCollapseIntoSignOff(
    detail.spec.gatePolicy,
    snapshot.revision.authoringStage,
  );
  const requiresApproval = (gate: "requirements" | "design" | "plan") => {
    const dial = resolveDial(detail.spec.gatePolicy, gate);
    return dial === "gate" || dial === COMBINED_APPROVAL_DIAL;
  };
  const outstanding = outstandingSubjects(detail);
  const consulted = consultedReviewGates(detail);
  const subjects: BulkApprovalSubject[] = [];
  if (!combined) {
    for (const entry of snapshot.elements) {
      switch (entry.version.payload.kind) {
        case "requirement":
          if (
            consulted.has("requirements") &&
            requiresApproval("requirements")
          ) {
            subjects.push({
              subjectKind: "requirement",
              elementId: entry.element.id,
            });
          }
          break;
        case "decision":
          if (consulted.has("design") && requiresApproval("design")) {
            subjects.push({
              subjectKind: "decision",
              elementId: entry.element.id,
            });
          }
          break;
        default:
          break;
      }
    }
    if (
      snapshot.revision.authoringStage === "plan" &&
      consulted.has("plan") &&
      requiresApproval("plan")
    ) {
      subjects.push({ subjectKind: "plan", elementId: null });
    }
  }

  // Absence from the outstanding list is not an approval on its own: an import
  // admission settles a subject with no approval row behind it, so those are
  // subtracted here and reported separately.
  const carried = importCarriedSubjects(detail);
  const settled = subjects.filter(
    (subject) => !outstanding.has(subjectKey(subject)),
  );
  const importCarried = settled.filter((subject) =>
    carried.has(subjectKey(subject)),
  ).length;
  const approved = settled.length - importCarried;
  const blockingThreadCount = assembleSpecCommentThreads(
    detail.comments,
  ).filter(
    (thread) =>
      thread.root.revisionId === snapshot.revision.id &&
      thread.blocking &&
      thread.open,
  ).length;
  const signOffFindingCount =
    detail.status.draftHealth?.counts.find(
      ({ severity }) => severity === "blocks_signoff",
    )?.count ?? 0;
  const activeQuestionCount = detail.questions.filter(
    (question) => question.presentation.attentionActive,
  ).length;
  const activeAssumptionCount = detail.assumptions.filter(
    (assumption) => assumption.presentation.attentionActive,
  ).length;
  const approvalsReady = approved + importCarried === subjects.length;
  const conditionsReady =
    blockingThreadCount === 0 && signOffFindingCount === 0;

  return {
    approved,
    importCarried,
    total: subjects.length,
    approvalsReady,
    combined,
    blockingThreadCount,
    signOffFindingCount,
    activeQuestionCount,
    activeAssumptionCount,
    conditionsReady,
    ready: approvalsReady && conditionsReady,
  };
}

/**
 * What the combined act disables on. Outstanding approvals are deliberately
 * absent: the act writes them, so listing them as a blocker would describe a
 * gate the reviewer has no separate way to clear.
 */
function readinessBlockerSummary(readiness: ReviewReadiness): string {
  const blockers = [
    ...(readiness.blockingThreadCount === 0
      ? []
      : [
          `${readiness.blockingThreadCount} blocking ${pluralize(readiness.blockingThreadCount, "thread")}`,
        ]),
    ...(readiness.signOffFindingCount === 0
      ? []
      : [
          `${readiness.signOffFindingCount} server lint ${pluralize(readiness.signOffFindingCount, "finding")}`,
        ]),
  ];
  return `Sign-off blocked — ${blockers.join(" · ")}`;
}

export function bulkApprovalSubjects(
  detail: SpecDetailView,
  mode: "requirements" | "remaining",
): BulkApprovalSubject[] {
  const snapshot = detail.draftReview?.snapshot ?? null;
  if (snapshot === null) return [];

  const consulted = consultedReviewGates(detail);
  const requiresApproval = (gate: "requirements" | "design" | "plan") => {
    const dial = resolveDial(detail.spec.gatePolicy, gate);
    return dial === "gate" || dial === COMBINED_APPROVAL_DIAL;
  };

  const elementSubjects = snapshot.elements.flatMap(
    (entry): ApprovalTarget[] => {
      if (
        entry.version.payload.kind === "requirement" &&
        consulted.has("requirements") &&
        requiresApproval("requirements")
      ) {
        return [{ subjectKind: "requirement", elementId: entry.element.id }];
      }
      if (
        entry.version.payload.kind === "decision" &&
        consulted.has("design") &&
        requiresApproval("design")
      ) {
        return [{ subjectKind: "decision", elementId: entry.element.id }];
      }
      return [];
    },
  );
  if (mode === "requirements") {
    return elementSubjects.filter(
      (subject) => subject.subjectKind === "requirement",
    );
  }

  const outstanding = outstandingSubjects(detail);
  const remaining: BulkApprovalSubject[] = elementSubjects.filter((subject) =>
    outstanding.has(subjectKey(subject)),
  );
  const planSubject = { subjectKind: "plan" as const, elementId: null };
  if (
    snapshot.revision.authoringStage === "plan" &&
    consulted.has("plan") &&
    requiresApproval("plan") &&
    outstanding.has(subjectKey(planSubject))
  ) {
    remaining.push(planSubject);
  }
  return remaining;
}

/**
 * The gates the server's projection says this revision's transition consults.
 * Applicability is measured against the nearest approved ancestor, which no
 * client-side comparison against the immediate parent can reproduce: an
 * obligation that entered through a withdrawn attempt is unchanged against
 * that attempt and still unadmitted against the governance baseline.
 */
function consultedReviewGates(
  detail: SpecDetailView,
): Set<"requirements" | "design" | "plan"> {
  return new Set(
    detail.status.applicableGates.flatMap((gate) =>
      gate === "requirements" || gate === "design" || gate === "plan"
        ? [gate]
        : [],
    ),
  );
}

function subjectKey(subject: BulkApprovalSubject): string {
  return `${subject.subjectKind}:${subject.elementId ?? ""}`;
}

/**
 * The authoring subjects the combined act will approve, named as the server
 * named them. The confirmation lists these and the transaction re-derives the
 * same set from the same projection, so what the operator read and what the
 * act writes cannot disagree — no subject list crosses the wire.
 */
function outstandingApprovalSubjects(
  detail: SpecDetailView,
): SpecDetailView["status"]["pendingApprovals"] {
  return detail.status.pendingApprovals.filter(
    (pending) =>
      pending.gate === "requirements" ||
      pending.gate === "design" ||
      pending.gate === "plan",
  );
}

/**
 * The subjects an import admission settles rather than a human approval, read
 * from the server's projection. They are absent from `pendingApprovals` — no
 * human is being asked for them — but crediting that absence to a human is
 * exactly the claim the import never earned.
 */
function importCarriedSubjects(detail: SpecDetailView): Set<string> {
  return new Set(
    detail.status.importCarriedApprovals.flatMap((carried) => {
      if (carried.gate === "requirements") {
        return [
          subjectKey({
            subjectKind: "requirement",
            elementId: carried.elementId,
          }),
        ];
      }
      return carried.gate === "design"
        ? [
            subjectKey({
              subjectKind: "decision",
              elementId: carried.elementId,
            }),
          ]
        : [];
    }),
  );
}

/**
 * The subjects a human still owes, read from the server's projection. An
 * approval row's own `validity` cannot answer this: it says nothing about
 * whether the approval was recorded on a revision in this lineage or against
 * the content the revision carries now.
 */
function outstandingSubjects(detail: SpecDetailView): Set<string> {
  return new Set(
    detail.status.pendingApprovals.flatMap((pending) => {
      if (pending.gate === "requirements" && pending.elementId !== null) {
        return [
          subjectKey({
            subjectKind: "requirement",
            elementId: pending.elementId,
          }),
        ];
      }
      if (pending.gate === "design" && pending.elementId !== null) {
        return [
          subjectKey({ subjectKind: "decision", elementId: pending.elementId }),
        ];
      }
      return pending.gate === "plan"
        ? [subjectKey({ subjectKind: "plan", elementId: null })]
        : [];
    }),
  );
}

function ReviewChangeCard({
  change,
  criteria,
  detail,
  projectName,
  baseSnapshot,
  currentSnapshot,
  placements,
  combinedApproval,
  reviewHash,
  onFeedback,
  onError,
}: {
  change: ReviewCardChange;
  criteria: RequirementCriterionReview[];
  detail: SpecDetailView;
  projectName: string;
  baseSnapshot: SpecRevisionSnapshot | null;
  currentSnapshot: SpecRevisionSnapshot;
  placements: readonly PlacedSpecCommentThread[];
  combinedApproval: boolean;
  /** The draft content the reviewer is reading; approval echoes it. */
  reviewHash: string;
  onFeedback(feedback: string | null): void;
  onError(error: string | null): void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [commenting, setCommenting] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const base = viewForElement(baseSnapshot, change.elementId);
  const current = viewForElement(currentSnapshot, change.elementId);
  const display = current ?? base;
  const handle = display?.handle ?? change.elementId;
  const controlLabel = reviewChangeControlLabel(change);
  const approvalTarget = approvalTargetFor(
    current ?? base,
    currentSnapshot,
    baseSnapshot,
  );
  const approval =
    approvalTarget === null
      ? null
      : approvalFor(detail.approvals, approvalTarget);
  // A recorded approval is not an approval of THIS revision: whether it
  // applies depends on the lineage it was recorded in and on the content the
  // revision carries now, which only the server's projection answers. The
  // row's own validity would offer "Unapprove" for a subject sign-off refuses.
  const approvalApplies =
    approval?.validity === "valid" &&
    (approvalTarget === null ||
      !outstandingSubjects(detail).has(subjectKey(approvalTarget)));
  const threadPlacements = placements.filter(
    ({ thread }) => thread.root.elementId === change.elementId,
  );

  const comment = useSpecActionMutation<
    {
      revisionId: string;
      elementId: string;
      threadId: string;
      parentCommentId: null;
      anchor: CommentAnchor;
      body: string;
      blocking: boolean;
    },
    z.infer<typeof specCommentRowSchema>
  >(projectName, detail.spec.slug, "comment", specCommentRowSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-attention-changed"],
  });
  const approve = useSpecActionMutation<
    {
      revisionId: string;
      subjectKind: "requirement" | "decision";
      elementId: string;
      expectedReviewHash: string;
    },
    z.infer<typeof specApprovalRowSchema>
  >(projectName, detail.spec.slug, "approve-item", specApprovalRowSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-approval-changed"],
  });
  const unapprove = useSpecActionMutation<
    {
      revisionId: string;
      subjectKind: "requirement" | "decision";
      elementId: string;
    },
    z.infer<typeof specApprovalRowSchema>
  >(projectName, detail.spec.slug, "unapprove-item", specApprovalRowSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-approval-changed"],
  });

  function recordComment(): void {
    if (
      current === null ||
      display === null ||
      display === undefined ||
      commentBody.trim().length === 0
    )
      return;
    const quote = display.body.slice(0, 160);
    const anchor: CommentAnchor = {
      sectionId: display.handle,
      headingLabel: display.handle,
      line: 1,
      charStart: 0,
      charEnd: quote.length,
      quote,
      prefix: "",
      suffix: display.body.slice(quote.length, quote.length + 32),
      docRevision:
        currentSnapshot.revision.contentHash ?? currentSnapshot.revision.id,
    };
    const threadId = createClientId();
    onError(null);
    onFeedback(`Recording comment on ${handle}…`);
    comment.mutate(
      {
        revisionId: currentSnapshot.revision.id,
        elementId: display.entry.element.id,
        threadId,
        parentCommentId: null,
        anchor,
        body: commentBody.trim(),
        blocking: false,
      },
      {
        onSuccess: (result) => {
          setCommentBody("");
          setCommenting(false);
          onFeedback(`Comment recorded on ${handle}`);
          commentsLogger.info("spec_studio.comment.root.completed", {
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: display.entry.element.id,
            threadId: result.thread_id,
          });
        },
        onError: (mutationError) => {
          onFeedback(null);
          onError(mutationError.message);
          commentsLogger.warn("spec_studio.comment.root.failed", {
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: display.entry.element.id,
            threadId,
            error: safeError(mutationError),
          });
        },
      },
    );
  }

  function approveItem(): void {
    if (approvalTarget === null) return;
    onError(null);
    onFeedback(`Approving ${handle}…`);
    approve.mutate(
      {
        revisionId: currentSnapshot.revision.id,
        subjectKind: approvalTarget.subjectKind,
        elementId: approvalTarget.elementId,
        expectedReviewHash: reviewHash,
      },
      {
        onSuccess: () => {
          onFeedback(`${handle} approved`);
          logger.info("spec_studio.review_action.completed", {
            action: "approve-item",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: approvalTarget.elementId,
          });
        },
        onError: (mutationError) => {
          onFeedback(null);
          onError(mutationError.message);
          logger.warn("spec_studio.review_action.failed", {
            action: "approve-item",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: approvalTarget.elementId,
            error: mutationError.message,
          });
        },
      },
    );
  }

  function unapproveItem(): void {
    if (approvalTarget === null) return;
    onError(null);
    onFeedback(`Removing approval on ${handle}…`);
    unapprove.mutate(
      {
        revisionId: currentSnapshot.revision.id,
        subjectKind: approvalTarget.subjectKind,
        elementId: approvalTarget.elementId,
      },
      {
        onSuccess: () => {
          onFeedback(`${handle} approval removed`);
          logger.info("spec_studio.review_action.completed", {
            action: "unapprove-item",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: approvalTarget.elementId,
          });
        },
        onError: (mutationError) => {
          onFeedback(null);
          onError(mutationError.message);
          logger.warn("spec_studio.review_action.failed", {
            action: "unapprove-item",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: approvalTarget.elementId,
            error: mutationError.message,
          });
        },
      },
    );
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <article
        id={reviewChangeTargetId(change.elementId)}
        data-testid={`review-change-${change.elementId}`}
        tabIndex={-1}
        className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
      >
        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-sm px-md py-sm max-768:grid-cols-[auto_minmax(0,1fr)] max-768:gap-y-sm">
          <StatusChip tone={changeTone[change.change]}>
            {capitalize(change.change)}
          </StatusChip>
          {display !== null && display !== undefined && (
            <Link
              href={changeDeepLink(
                projectName,
                detail.spec.slug,
                change,
                current,
                handle,
                currentSnapshot.revision.authoringStage,
              )}
              className="inline-flex min-h-[28px] items-center font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
            >
              {handle}
            </Link>
          )}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={controlLabel}
              className="group flex min-h-[32px] min-w-0 cursor-pointer items-start gap-sm border-0 bg-transparent p-0 text-left font-mono text-[0.82rem] leading-relaxed text-text-primary hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:col-span-2 max-768:row-start-2 max-768:min-h-[44px]"
            >
              <span className="min-w-0 grow [overflow-wrap:anywhere]">
                {controlLabel}
              </span>
              <ChevronDownIcon
                size={14}
                className="shrink-0 text-text-tertiary transition-transform duration-150 group-data-[state=open]:rotate-180"
              />
            </button>
          </CollapsibleTrigger>
          <div className="flex flex-wrap items-center justify-end gap-xs max-768:col-span-2 max-768:row-start-3 max-768:justify-start">
            {approval?.validity === "stale" && (
              <StatusChip tone="amber">Approval stale</StatusChip>
            )}
            {approval?.validity === "closed" && (
              <StatusChip tone="neutral">Approval closed</StatusChip>
            )}
            {approvalApplies && <StatusChip tone="green">Approved</StatusChip>}
            {change.change !== "removed" ? (
              <Button
                size="touch"
                onClick={() => {
                  setCommenting((open) => !open);
                  setExpanded(true);
                }}
              >
                Comment
              </Button>
            ) : null}
            {combinedApproval ? (
              <StatusChip
                tone="neutral"
                title="The combined sign-off is the approval act"
              >
                Covered by sign-off
              </StatusChip>
            ) : approvalApplies ? (
              <Button
                size="touch"
                loading={unapprove.isPending}
                onClick={unapproveItem}
                title="Remove the recorded approval for this element"
              >
                Unapprove item
              </Button>
            ) : approvalTarget === null ? (
              // Sections, tasks, and orphaned criteria have no per-item
              // approval subject (Requirement 10.1) — a dead approve button
              // here reads as broken, so state the coverage instead.
              change.change !== "removed" && (
                <StatusChip
                  tone="neutral"
                  title="This element has no independent approval gate — revision sign-off approves it"
                >
                  Covered by sign-off
                </StatusChip>
              )
            ) : (
              change.change !== "removed" && (
                <Button
                  size="sm"
                  touch
                  variant="success"
                  loading={approve.isPending}
                  onClick={approveItem}
                >
                  Approve item
                </Button>
              )
            )}
          </div>
        </div>

        <CollapsibleContent forceMount asChild>
          <div
            hidden={!expanded}
            className="border-x-0 border-t border-b-0 border-solid border-border-subtle data-[state=closed]:hidden"
          >
            <RevisionComparison
              base={base}
              current={current}
              baseRevisionNumber={baseSnapshot?.revision.number ?? null}
              currentRevisionNumber={currentSnapshot.revision.number}
            />
            {criteria.length > 0 && (
              <div className="border-x-0 border-t border-b-0 border-solid border-border-dim bg-bg-base px-lg py-md max-768:px-md">
                <p className="mt-0 mb-sm font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                  Acceptance criteria — approved together with {handle}
                </p>
                <div className="grid gap-sm">
                  {criteria.map((criterion) => {
                    const criterionDisplay =
                      criterion.current ?? criterion.base;
                    if (criterionDisplay === null) return null;
                    const criterionPlacements = placements.filter(
                      ({ thread }) =>
                        thread.root.elementId === criterion.elementId,
                    );
                    return (
                      <div
                        key={criterion.elementId}
                        id={reviewChangeTargetId(criterion.elementId)}
                        data-testid={`review-criterion-${criterion.elementId}`}
                        tabIndex={-1}
                        className="rounded-sm focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                      >
                        <div
                          className={cn(
                            "flex items-start gap-sm border-t-0 border-r-0 border-b-0 border-l-2 border-solid py-xs pr-0 pl-md max-768:flex-wrap",
                            criterionRailClass[criterion.change],
                          )}
                        >
                          <Link
                            href={criterionDeepLink(
                              projectName,
                              detail.spec.slug,
                              criterion,
                              criterionDisplay.handle,
                              currentSnapshot.revision.authoringStage,
                            )}
                            className="inline-flex min-h-[28px] shrink-0 items-center font-mono text-[0.72rem] font-bold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
                          >
                            {criterionDisplay.handle}
                          </Link>
                          <div className="min-w-0 grow">
                            <RevisionComparison
                              base={criterion.base}
                              current={criterion.current}
                              baseRevisionNumber={
                                baseSnapshot?.revision.number ?? null
                              }
                              currentRevisionNumber={
                                currentSnapshot.revision.number
                              }
                            />
                          </div>
                          <StatusChip
                            tone={changeTone[criterion.change]}
                            layoutClassName="ml-auto"
                          >
                            {capitalize(criterion.change)}
                          </StatusChip>
                        </div>
                        {criterionPlacements.length > 0 ? (
                          <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-md py-sm">
                            <SpecCommentThreadList
                              projectName={projectName}
                              slug={detail.spec.slug}
                              specId={detail.spec.id}
                              viewedRevisionId={currentSnapshot.revision.id}
                              viewedRevisionState={
                                currentSnapshot.revision.state
                              }
                              specAbandoned={false}
                              humanTransport
                              placements={criterionPlacements}
                              label={`${criterionDisplay.handle} review threads`}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>

        {threadPlacements.length > 0 ? (
          <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-md py-sm">
            <SpecCommentThreadList
              projectName={projectName}
              slug={detail.spec.slug}
              specId={detail.spec.id}
              viewedRevisionId={currentSnapshot.revision.id}
              viewedRevisionState={currentSnapshot.revision.state}
              specAbandoned={false}
              humanTransport
              placements={threadPlacements}
              label={`${handle} review threads`}
            />
          </div>
        ) : null}

        {commenting && change.change !== "removed" && (
          <div className="border-x-0 border-t border-b-0 border-solid border-border-dim bg-bg-base px-md py-sm">
            <label
              htmlFor={`comment-${change.elementId}`}
              className="mb-xs block font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase"
            >
              Comment on {handle}
            </label>
            <MultilineInput
              id={`comment-${change.elementId}`}
              aria-label={`Comment on ${handle}`}
              value={commentBody}
              onValueChange={setCommentBody}
              voiceProjectName={projectName}
              rows={3}
              className="box-border w-full resize-y rounded-md border border-solid border-border-default bg-bg-surface px-[12px] py-[9px] font-mono text-[0.78rem] text-text-primary outline-0 placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]"
              placeholder="Leave review context for this element"
            />
            <div className="mt-sm flex justify-end">
              <Button
                size="touch"
                variant="primary"
                disabled={commentBody.trim().length === 0}
                loading={comment.isPending}
                onClick={recordComment}
              >
                Record comment
              </Button>
            </div>
          </div>
        )}
      </article>
    </Collapsible>
  );
}

function RevisionPane({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0 bg-bg-base px-md py-sm">
      <span className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        {label}
      </span>
      <div className="mt-sm">{children}</div>
    </div>
  );
}

/**
 * One formatted body carrying its own revision history: unchanged prose renders
 * as ordinary Markdown, and the spans this revision changed take the added or
 * removed colour on top of whatever formatting they already had.
 */
function RevisionComparison({
  base,
  current,
  baseRevisionNumber,
  currentRevisionNumber,
}: {
  base: ReviewElementView | null;
  current: ReviewElementView | null;
  baseRevisionNumber: number | null;
  currentRevisionNumber: number;
}): React.JSX.Element | null {
  const display = current ?? base;
  if (display === null) return null;

  // The first revision has nothing to compare against, so colouring all of it
  // as added would say nothing about what a reviewer is being asked to read.
  const compared = baseRevisionNumber !== null && base?.body !== current?.body;
  if (!compared) {
    return (
      <RevisionPane
        label={`Revision ${current === null && baseRevisionNumber !== null ? baseRevisionNumber : currentRevisionNumber}`}
      >
        <CompactMarkdown content={display.body} />
      </RevisionPane>
    );
  }

  return (
    <RevisionPane
      label={
        current === null
          ? `Revision ${baseRevisionNumber} — removed`
          : base === null
            ? `Revision ${currentRevisionNumber} — added`
            : `Revision ${baseRevisionNumber} → ${currentRevisionNumber}`
      }
    >
      <CompactMarkdownDiff
        before={base?.body ?? null}
        after={current?.body ?? null}
      />
    </RevisionPane>
  );
}

function reviewChangeControlLabel(change: ReviewCardChange): string {
  if (change.kind === "requirement") {
    return change.summary.startsWith("Modified requirement criteria:")
      ? "Modified requirement criteria"
      : `${capitalize(change.change)} requirement`;
  }
  if (change.kind === "criterion") {
    return `${capitalize(change.change)} acceptance criterion`;
  }
  return change.summary;
}

function toDiffRows(snapshot: SpecRevisionSnapshot): RevisionElement[] {
  return snapshot.elements.map((entry) => ({
    elementId: entry.element.id,
    parentElementId: entry.element.parentElementId,
    payloadHash: entry.version.payloadHash,
    payload: entry.version.payload,
  }));
}

function revisionCitationDiffContext(
  baseSnapshot: SpecRevisionSnapshot | null,
  currentSnapshot: SpecRevisionSnapshot,
) {
  return {
    baseCitationContractVersion:
      baseSnapshot?.revision.citationContractVersion ??
      currentSnapshot.revision.citationContractVersion,
    draftCitationContractVersion:
      currentSnapshot.revision.citationContractVersion,
    baseCitations:
      baseSnapshot?.assumptionCitations.map((citation) => ({
        elementId: citation.elementId,
        assumptionId: citation.assumptionId,
        snapshot: citation.snapshot,
      })) ?? [],
    draftCitations: currentSnapshot.assumptionCitations.map((citation) => ({
      elementId: citation.elementId,
      assumptionId: citation.assumptionId,
      snapshot: citation.snapshot,
    })),
  };
}

function viewForElement(
  snapshot: SpecRevisionSnapshot | null,
  elementId: string,
): ReviewElementView | null {
  if (snapshot === null) return null;
  const entry = snapshot.elements.find(
    (candidate) => candidate.element.id === elementId,
  );
  if (entry === undefined) return null;
  return {
    entry,
    handle: handleFor(entry, snapshot),
    body: bodyFor(entry, snapshot),
  };
}

function handleFor(
  entry: SpecRevisionElement,
  snapshot: SpecRevisionSnapshot,
): string {
  const number = entry.element.number;
  switch (entry.version.payload.kind) {
    case "section":
      return entry.element.id;
    case "requirement":
      return number === null ? entry.element.id : `R${number}`;
    case "criterion": {
      const parent = snapshot.elements.find(
        (candidate) => candidate.element.id === entry.element.parentElementId,
      );
      const parentNumber = parent?.element.number;
      return number === null ||
        parentNumber === null ||
        parentNumber === undefined
        ? entry.element.id
        : `R${parentNumber}.${number}`;
    }
    case "decision":
      return number === null ? entry.element.id : `D${number}`;
    case "task":
      return number === null ? entry.element.id : `T${number}`;
  }
}

function bodyFor(
  entry: SpecRevisionElement,
  snapshot: SpecRevisionSnapshot,
): string {
  const payload = entry.version.payload;
  switch (payload.kind) {
    case "section":
      return payload.body;
    case "requirement":
      return payload.statement;
    case "criterion":
      return payload.text;
    case "decision":
      return `${payload.title}\n${payload.chosenApproach}\n${payload.reason}`;
    case "task": {
      const dependencies = elementHandles(
        payload.dependsOnTaskElementIds,
        snapshot,
      );
      const criteria = elementHandles(
        payload.coveredCriterionElementIds,
        snapshot,
      );
      return [
        payload.title,
        payload.instructions,
        "",
        `- **Dependencies:** ${dependencies.length > 0 ? dependencies.join(", ") : "None"}`,
        `- **Lane group:** ${payload.laneGroup ?? "One task per lane"}`,
        `- **Execution lane:** ${payload.executionLane ?? "Single-member lane"}`,
        `- **Touched surfaces:** ${payload.touchedPaths?.join(", ") ?? "Not declared"}`,
        `- **Criterion coverage:** ${criteria.length > 0 ? criteria.join(", ") : "None"}`,
      ].join("\n");
    }
  }
}

function elementHandles(
  elementIds: string[],
  snapshot: SpecRevisionSnapshot,
): string[] {
  return elementIds.map((elementId) => {
    const entry = snapshot.elements.find(
      (candidate) => candidate.element.id === elementId,
    );
    return entry === undefined ? elementId : handleFor(entry, snapshot);
  });
}

function bodyForElement(
  snapshot: SpecRevisionSnapshot,
  elementId: string,
): string | null {
  const entry = snapshot.elements.find(
    (candidate) => candidate.element.id === elementId,
  );
  return entry === undefined ? null : bodyFor(entry, snapshot);
}

function approvalTargetFor(
  view: ReviewElementView | null | undefined,
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ApprovalTarget | null {
  if (view === null || view === undefined) return null;
  if (view.entry.version.payload.kind === "requirement") {
    return { subjectKind: "requirement", elementId: view.entry.element.id };
  }
  if (view.entry.version.payload.kind === "decision") {
    return { subjectKind: "decision", elementId: view.entry.element.id };
  }
  if (view.entry.version.payload.kind !== "criterion") return null;
  const parentId = view.entry.element.parentElementId;
  if (parentId === null) return null;
  const parent =
    currentSnapshot.elements.find((entry) => entry.element.id === parentId) ??
    baseSnapshot?.elements.find((entry) => entry.element.id === parentId);
  return parent?.version.payload.kind === "requirement"
    ? { subjectKind: "requirement", elementId: parent.element.id }
    : null;
}

function approvalFor(
  approvals: SpecApprovalRow[],
  target: ApprovalTarget,
): SpecApprovalRow | null {
  return (
    approvals
      .filter(
        (approval) =>
          approval.subject_kind === target.subjectKind &&
          approval.element_id === target.elementId,
      )
      .toSorted((left, right) =>
        left.granted_at === right.granted_at
          ? left.id.localeCompare(right.id)
          : left.granted_at.localeCompare(right.granted_at),
      )
      .at(-1) ?? null
  );
}

function formatRawDiff(
  baseSnapshot: SpecRevisionSnapshot | null,
  currentSnapshot: SpecRevisionSnapshot,
  changes: SemanticChange[],
): string {
  const lines = [
    baseSnapshot === null
      ? "--- empty-baseline"
      : `--- revision-${baseSnapshot.revision.number}`,
    `+++ revision-${currentSnapshot.revision.number}`,
  ];
  for (const change of changes) {
    const base = viewForElement(baseSnapshot, change.elementId);
    const current = viewForElement(currentSnapshot, change.elementId);
    lines.push(
      `@@ ${current?.handle ?? base?.handle ?? change.elementId} · ${change.change} @@`,
    );
    if (base !== null) lines.push(`- ${base.body}`);
    if (current !== null) lines.push(`+ ${current.body}`);
  }
  return lines.join("\n");
}

function changeDeepLink(
  projectName: string,
  slug: string,
  change: ReviewCardChange,
  current: ReviewElementView | null,
  handle: string,
  authoringStage: SpecRevision["authoringStage"],
): string {
  const detailPath = detailPathFor(projectName, slug);
  if (
    change.change === "removed" ||
    current?.entry.version.payload.kind === "section"
  ) {
    const reviewView = authoringStage === "design" ? "design" : "requirements";
    return `${detailPath}?view=${reviewView}&change=${encodeURIComponent(change.elementId)}`;
  }
  return `${detailPath}?el=${encodeURIComponent(handle)}`;
}

function detailPathFor(projectName: string, slug: string): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
}

function criterionDeepLink(
  projectName: string,
  slug: string,
  criterion: RequirementCriterionReview,
  handle: string,
  authoringStage: SpecRevision["authoringStage"],
): string {
  const detailPath = detailPathFor(projectName, slug);
  const reviewView = authoringStage === "design" ? "design" : "requirements";
  return criterion.change === "removed"
    ? `${detailPath}?view=${reviewView}&change=${encodeURIComponent(criterion.elementId)}`
    : `${detailPath}?el=${encodeURIComponent(handle)}`;
}

function reviewChangeTargetId(elementId: string): string {
  return `review-change-${elementId}`;
}

function parseAnchor(anchor: unknown): CommentAnchor | null {
  const parsed = commentAnchorSchema.safeParse(anchor);
  return parsed.success ? parsed.data : null;
}

function createClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `review-thread-${Date.now()}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
