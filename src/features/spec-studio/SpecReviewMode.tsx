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
import { CompactMarkdown } from "@/components/markdown/Markdown";
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
  type SpecRevisionElement,
  type SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

import { reanchorSpecThread, type SpecThreadAnchorState } from "./reanchor";
import {
  formatInlineReviewDiff,
  type InlineReviewDiffSegment,
} from "./SpecReviewDiff";
import SpecReadOnlyNotice from "./SpecReadOnlyNotice";

const logger = createClientLogger("spec-studio-review");

const requestChangesResponseSchema = z
  .object({
    withdrawn: specRevisionSchema,
    draft: specRevisionSchema,
  })
  .strict();

const signOffResponseSchema = z
  .object({
    revision: specRevisionSchema,
    approval: specApprovalRowSchema.nullable(),
  })
  .strict();

const changeTone: Record<SemanticChange["change"], StatusChipTone> = {
  added: "green",
  modified: "amber",
  removed: "red",
};

const criterionTone: Record<
  RequirementCriterionReview["change"],
  StatusChipTone
> = {
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

const anchorTone: Record<SpecThreadAnchorState["status"], StatusChipTone> = {
  anchored: "green",
  reanchored: "cyan",
  stale: "amber",
  orphaned: "amber",
};

const anchorLabel: Record<SpecThreadAnchorState["status"], string> = {
  anchored: "Anchored",
  reanchored: "Re-anchored",
  stale: "Stale",
  orphaned: "Orphaned",
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
  changes: SemanticChange[];
}

interface ReviewReadiness {
  approved: number;
  total: number;
  approvalsReady: boolean;
  combined: boolean;
  blockingThreadCount: number;
  rejectedAssumptionCount: number;
  openQuestionCount: number;
  undisposedAssumptionCount: number;
  ready: boolean;
}

interface RequirementCriterionReview {
  elementId: string;
  base: ReviewElementView | null;
  current: ReviewElementView | null;
  change: SemanticChange["change"] | "unchanged";
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
  open: { label: "Open — blocks sign-off", tone: "amber" },
  answered: { label: "Answered", tone: "green" },
};

const reviewAssumptionStatus: Record<
  SpecDetailView["assumptions"][number]["disposition"],
  { label: string; tone: StatusChipTone }
> = {
  proposed: { label: "Proposed — blocks sign-off", tone: "amber" },
  confirmed: { label: "Confirmed", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  deferred: { label: "Deferred", tone: "neutral" },
};

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
  const baseSnapshot = detail.baseRevision;
  const currentSnapshot = detail.currentRevision;
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signOffDialogOpen, setSignOffDialogOpen] = useState(false);
  const [signOffAcknowledged, setSignOffAcknowledged] = useState(false);

  const diff = useMemo(() => {
    if (currentSnapshot === null) return null;
    return diffRevisions(
      baseSnapshot === null ? [] : toDiffRows(baseSnapshot),
      toDiffRows(currentSnapshot),
    );
  }, [baseSnapshot, currentSnapshot]);

  useEffect(() => {
    if (highlightedChangeId === null || diff === null) return;
    const target = document.getElementById(
      reviewChangeTargetId(highlightedChangeId),
    );
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [diff, highlightedChangeId]);

  const requestChanges = useSpecActionMutation<
    { revisionId: string },
    z.infer<typeof requestChangesResponseSchema>
  >(
    projectName,
    detail.spec.slug,
    "request-changes",
    requestChangesResponseSchema,
    {
      specId: detail.spec.id,
      eventTypes: ["spec-revision-changed"],
    },
  );
  const signOff = useSpecActionMutation<
    { revisionId: string },
    z.infer<typeof signOffResponseSchema>
  >(projectName, detail.spec.slug, "sign-off", signOffResponseSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-revision-changed", "spec-approval-changed"],
  });
  const bulkApprove = useSpecActionMutation<
    { revisionId: string; subjects: BulkApprovalSubject[] },
    z.infer<typeof specApprovalRowSchema>[]
  >(
    projectName,
    detail.spec.slug,
    "bulk-approve",
    z.array(specApprovalRowSchema),
    {
      specId: detail.spec.id,
      eventTypes: ["spec-approval-changed"],
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
    currentSnapshot === null ||
    diff === null ||
    currentSnapshot.revision.state !== "proposed"
  ) {
    return (
      <EmptyState>
        <EmptyStateTitle>Nothing awaiting review</EmptyStateTitle>
        <EmptyStateDesc>
          There is no proposed revision. Open a draft and propose it when the
          next change set is ready for review.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  const detailPath = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`;
  const currentRevision = currentSnapshot.revision;
  const revisionId = currentRevision.id;

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

  function handleRequestChanges(): void {
    setError(null);
    setFeedback("Opening a follow-up draft…");
    requestChanges.mutate(
      { revisionId },
      {
        onSuccess: ({ draft }) => {
          const message = `Draft revision ${draft.number} opened`;
          setFeedback(message);
          logger.info("spec_studio.review_action.completed", {
            action: "request-changes",
            specId: detail.spec.id,
            revisionId,
            draftRevisionId: draft.id,
          });
          onComplete?.(message);
        },
        onError: (mutationError) =>
          reportError("request-changes", mutationError),
      },
    );
  }

  function handleSignOff(): void {
    setError(null);
    setFeedback("Signing off revision…");
    signOff.mutate(
      { revisionId },
      {
        onSuccess: () => {
          const message = `Revision ${currentRevision.number} signed off`;
          setFeedback(message);
          logger.info("spec_studio.review_action.completed", {
            action: "sign-off",
            specId: detail.spec.id,
            revisionId,
          });
          onComplete?.(message);
        },
        onError: (mutationError) => reportError("sign-off", mutationError),
      },
    );
  }

  function handleBulkApproval(): void {
    const subjects = bulkApprovalSubjects(detail, "remaining");
    if (subjects.length === 0) return;
    setError(null);
    setFeedback("Approving every remaining review subject…");
    bulkApprove.mutate(
      { revisionId, subjects },
      {
        onSuccess: (approvals) => {
          setFeedback(`${approvals.length} approval records written`);
          logger.info("spec_studio.review_action.completed", {
            action: "bulk-approve-remaining",
            specId: detail.spec.id,
            revisionId,
            approvalCount: approvals.length,
          });
        },
        onError: (mutationError) =>
          reportError("bulk-approve-remaining", mutationError),
      },
    );
  }

  const remainingSubjects = bulkApprovalSubjects(detail, "remaining");
  const changeGroups = groupReviewChanges(
    diff.changeList,
    currentSnapshot,
    baseSnapshot,
  );
  const unchangedViews = unchangedElementViews(diff, currentSnapshot);
  const readiness = reviewReadiness(detail);
  const outstandingElementIds = new Set(
    detail.status.pendingApprovals.flatMap((pending) =>
      pending.elementId === null ? [] : [pending.elementId],
    ),
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
                proposed
                {currentSnapshot.revision.proposedAt === null
                  ? ""
                  : ` ${currentSnapshot.revision.proposedAt.slice(0, 10)}`}{" "}
                ·{" "}
                {baseSnapshot === null
                  ? "initial proposal"
                  : `over revision ${baseSnapshot.revision.number}`}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-sm max-768:justify-between">
            {readiness.combined ? (
              <StatusChip tone="green">Sign-off approves all items</StatusChip>
            ) : remainingSubjects.length === 0 ? (
              <StatusChip tone="green">All approved</StatusChip>
            ) : (
              <Button
                size="sm"
                touch
                variant="primary"
                loading={bulkApprove.isPending}
                onClick={handleBulkApproval}
              >
                Approve all remaining ({remainingSubjects.length})
              </Button>
            )}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  touch
                  loading={requestChanges.isPending}
                  title="Ends this review attempt and opens a draft revision"
                >
                  Request changes
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent size="default">
                <AlertDialogTitle>
                  Request changes — end this review?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This ends the review attempt on revision{" "}
                  {currentSnapshot.revision.number} and opens a follow-up draft.
                  It is not a comment — the frozen proposal remains in history,
                  and approvals recorded so far stay recorded.
                </AlertDialogDescription>
                <AlertDialogActions>
                  <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRequestChanges}>
                    End review — open draft
                  </AlertDialogAction>
                </AlertDialogActions>
              </AlertDialogContent>
            </AlertDialog>
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

        <TabsContent value="semantic">
          <section
            aria-label="Semantic changes"
            className="mt-[14px] rounded-lg border border-solid border-border-subtle bg-bg-base px-[20px] py-[18px] max-768:px-md max-768:py-md"
          >
            {diff.changeList.length === 0 ? (
              <EmptyState>
                <EmptyStateTitle>No semantic changes</EmptyStateTitle>
                <EmptyStateDesc>
                  The proposed revision matches its base.
                </EmptyStateDesc>
              </EmptyState>
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
                      Approvals on unchanged elements carry forward quietly.
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
                            combinedApproval={readiness.combined}
                            onFeedback={setFeedback}
                            onError={setError}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>

                <UnchangedApprovals
                  views={unchangedViews}
                  outstandingElementIds={outstandingElementIds}
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
                <StatusChip tone={readiness.approvalsReady ? "green" : "amber"}>
                  {readiness.approvalsReady
                    ? "Approvals complete"
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
              tone={readiness.rejectedAssumptionCount === 0 ? "green" : "amber"}
            >
              {readiness.rejectedAssumptionCount === 0
                ? "Assumptions clear"
                : `${readiness.rejectedAssumptionCount} rejected ${pluralize(readiness.rejectedAssumptionCount, "assumption")}`}
            </StatusChip>
            <StatusChip
              tone={readiness.openQuestionCount === 0 ? "green" : "amber"}
            >
              {readiness.openQuestionCount === 0
                ? "Questions answered"
                : `${readiness.openQuestionCount} open ${pluralize(readiness.openQuestionCount, "question")}`}
            </StatusChip>
            <StatusChip
              tone={
                readiness.undisposedAssumptionCount === 0 ? "green" : "amber"
              }
            >
              {readiness.undisposedAssumptionCount === 0
                ? "Assumptions disposed"
                : `${readiness.undisposedAssumptionCount} undisposed ${pluralize(readiness.undisposedAssumptionCount, "assumption")}`}
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
              variant={readiness.ready ? "primary" : "default"}
              touch
              loading={signOff.isPending}
              disabled={!readiness.ready}
              title={
                readiness.ready
                  ? "Freeze this revision"
                  : readinessBlockerSummary(readiness)
              }
            >
              Sign off revision {currentSnapshot.revision.number}
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
            <div className="mb-lg grid gap-sm rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm font-mono text-[0.72rem] text-text-secondary">
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                {readiness.combined
                  ? "Combined approval — this sign-off approves every item"
                  : `${readiness.approved}/${readiness.total} review approvals recorded`}
              </span>
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                Blocking threads resolved
              </span>
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                No rejected attached assumption remains cited
              </span>
              <span className="flex items-center gap-sm">
                <CheckIcon size={12} className="text-green" />
                All questions answered and all assumptions disposed
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
                Sign off — freeze revision {currentSnapshot.revision.number}
              </AlertDialogAction>
            </AlertDialogActions>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
    </div>
  );
}

function groupReviewChanges(
  changes: SemanticChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): ReviewChangeGroup[] {
  const groups = new Map<ReviewChangeGroup["key"], SemanticChange[]>();
  for (const change of changes) {
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

function requirementCardChanges(
  changes: SemanticChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): SemanticChange[] {
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
  change: SemanticChange,
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
    diff.changeList.map((criterionChange) => [
      criterionChange.elementId,
      criterionChange.change,
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
  changes: SemanticChange[],
  currentSnapshot: SpecRevisionSnapshot,
  baseSnapshot: SpecRevisionSnapshot | null,
): SemanticChange[] {
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

  const sortKey = (change: SemanticChange): [number, number] => {
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
  kind: SemanticChange["kind"],
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

function UnchangedApprovals({
  views,
  outstandingElementIds,
}: {
  views: ReviewElementView[];
  /**
   * Unchanged against the immediate parent is not approved: a change that
   * entered through a withdrawn attempt still owes the approval the server
   * measures against the nearest approved ancestor, so its chip must not read
   * as carried forward.
   */
  outstandingElementIds: ReadonlySet<string>;
}): React.JSX.Element | null {
  if (views.length === 0) return null;

  return (
    <div className="mt-lg rounded-md border border-dashed border-border-default px-md py-sm">
      <Collapsible>
        <CollapsibleTrigger layoutClassName="w-full">
          {views.length} unchanged {pluralize(views.length, "element")} —
          approvals carried forward quietly
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-xs pt-sm">
            {views.map((view) =>
              outstandingElementIds.has(view.entry.element.id) ? (
                <StatusChip key={view.entry.element.id} tone="amber">
                  {view.handle} — approval outstanding
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
  const unresolvedCount =
    detail.questions.filter((question) => question.status === "open").length +
    detail.assumptions.filter(
      (assumption) => assumption.disposition === "proposed",
    ).length;

  return (
    <section
      aria-label="Questions and assumptions in this revision"
      className="mt-lg overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Questions &amp; assumptions in this revision
        </h2>
        <StatusChip tone={unresolvedCount === 0 ? "green" : "amber"}>
          {unresolvedCount === 0
            ? "All resolved"
            : `${unresolvedCount} unresolved · blocks sign-off`}
        </StatusChip>
        <Link
          href={`${detailPath}?view=questions`}
          className="ml-auto inline-flex min-h-[28px] items-center font-mono text-[0.7rem] font-semibold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
        >
          Resolve on Questions screen
        </Link>
      </div>

      {detail.questions.length === 0 && detail.assumptions.length === 0 ? (
        <p className="m-0 px-md py-lg font-mono text-[0.72rem] text-text-tertiary">
          No questions or assumptions recorded for this spec.
        </p>
      ) : (
        <div>
          {detail.questions.map((question) => {
            const status = reviewQuestionStatus[question.status];
            return (
              <div
                key={question.id}
                className="flex items-start gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm max-768:flex-wrap"
              >
                <span className="w-[34px] shrink-0 font-mono text-[0.72rem] font-bold text-cyan-dim">
                  {question.handle}
                </span>
                <span className="min-w-0 grow font-mono text-[0.76rem] leading-relaxed text-text-secondary">
                  {question.text}
                </span>
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </div>
            );
          })}
          {detail.assumptions.map((assumption) => {
            const status = reviewAssumptionStatus[assumption.disposition];
            return (
              <div
                key={assumption.id}
                className="flex items-start gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm max-768:flex-wrap"
              >
                <span className="w-[34px] shrink-0 font-mono text-[0.72rem] font-bold text-cyan-dim">
                  {assumption.handle}
                </span>
                <span className="min-w-0 grow font-mono text-[0.76rem] leading-relaxed text-text-secondary">
                  {assumption.text}
                </span>
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
  if (detail.spec.abandonedAt !== null) return 0;
  if (detail.currentRevision?.revision.state !== "proposed") return 0;
  const readiness = reviewReadiness(detail);
  return (
    (readiness.combined ? 0 : readiness.total - readiness.approved) +
    readiness.blockingThreadCount +
    readiness.rejectedAssumptionCount +
    readiness.openQuestionCount +
    readiness.undisposedAssumptionCount
  );
}

function reviewReadiness(detail: SpecDetailView): ReviewReadiness {
  const snapshot = detail.currentRevision;
  if (snapshot === null) {
    return {
      approved: 0,
      total: 0,
      approvalsReady: false,
      combined: false,
      blockingThreadCount: 0,
      rejectedAssumptionCount: 0,
      openQuestionCount: 0,
      undisposedAssumptionCount: 0,
      ready: false,
    };
  }

  const combined = authoringApprovalsCollapseIntoSignOff(
    detail.spec.gatePolicy,
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

  const approved = subjects.filter(
    (subject) => !outstanding.has(subjectKey(subject)),
  ).length;
  const blockingThreadCount = groupThreads(detail).filter((thread) =>
    thread.comments.some(
      (comment) =>
        comment.revision_id === snapshot.revision.id &&
        comment.blocking === 1 &&
        comment.resolution === "open",
    ),
  ).length;
  const currentElementIds = new Set(
    snapshot.elements.map((entry) => entry.element.id),
  );
  const rejectedAssumptionCount = detail.assumptions.filter(
    (assumption) =>
      assumption.disposition === "rejected" &&
      assumption.elementId !== null &&
      currentElementIds.has(assumption.elementId) &&
      (snapshot.revision.proposedAt === null ||
        assumption.createdAt <= snapshot.revision.proposedAt),
  ).length;
  const openQuestionCount = detail.questions.filter(
    (question) => question.status === "open",
  ).length;
  const undisposedAssumptionCount = detail.assumptions.filter(
    (assumption) => assumption.disposition === "proposed",
  ).length;
  const approvalsReady = approved === subjects.length;

  return {
    approved,
    total: subjects.length,
    approvalsReady,
    combined,
    blockingThreadCount,
    rejectedAssumptionCount,
    openQuestionCount,
    undisposedAssumptionCount,
    ready:
      approvalsReady &&
      blockingThreadCount === 0 &&
      rejectedAssumptionCount === 0 &&
      openQuestionCount === 0 &&
      undisposedAssumptionCount === 0,
  };
}

function readinessBlockerSummary(readiness: ReviewReadiness): string {
  const blockers = [
    ...(readiness.approvalsReady
      ? []
      : [`${readiness.total - readiness.approved} approvals outstanding`]),
    ...(readiness.blockingThreadCount === 0
      ? []
      : [
          `${readiness.blockingThreadCount} blocking ${pluralize(readiness.blockingThreadCount, "thread")}`,
        ]),
    ...(readiness.rejectedAssumptionCount === 0
      ? []
      : [
          `${readiness.rejectedAssumptionCount} rejected cited ${pluralize(readiness.rejectedAssumptionCount, "assumption")}`,
        ]),
    ...(readiness.openQuestionCount === 0
      ? []
      : [
          `${readiness.openQuestionCount} open ${pluralize(readiness.openQuestionCount, "question")}`,
        ]),
    ...(readiness.undisposedAssumptionCount === 0
      ? []
      : [
          `${readiness.undisposedAssumptionCount} undisposed ${pluralize(readiness.undisposedAssumptionCount, "assumption")}`,
        ]),
  ];
  return `Sign-off blocked — ${blockers.join(" · ")}`;
}

export function bulkApprovalSubjects(
  detail: SpecDetailView,
  mode: "requirements" | "remaining",
): BulkApprovalSubject[] {
  const snapshot = detail.currentRevision;
  if (snapshot === null || snapshot.revision.state !== "proposed") return [];

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
  combinedApproval,
  onFeedback,
  onError,
}: {
  change: SemanticChange;
  criteria: RequirementCriterionReview[];
  detail: SpecDetailView;
  projectName: string;
  baseSnapshot: SpecRevisionSnapshot | null;
  currentSnapshot: SpecRevisionSnapshot;
  combinedApproval: boolean;
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
  const headlineBefore = reviewHeadline(base);
  const headlineAfter = reviewHeadline(current);
  const inlineDiff = formatInlineReviewDiff(headlineBefore, headlineAfter);
  const expandedBody = current ?? base;
  const showExpandedBody = shouldShowExpandedBody(expandedBody);
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
  const threads = groupThreads(detail).filter(
    (thread) => thread.comments[0]?.element_id === change.elementId,
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
    onError(null);
    onFeedback(`Recording comment on ${handle}…`);
    comment.mutate(
      {
        revisionId: currentSnapshot.revision.id,
        elementId: display.entry.element.id,
        threadId: createClientId(),
        parentCommentId: null,
        anchor,
        body: commentBody.trim(),
        blocking: false,
      },
      {
        onSuccess: () => {
          setCommentBody("");
          setCommenting(false);
          onFeedback(`Comment recorded on ${handle}`);
          logger.info("spec_studio.review_action.completed", {
            action: "comment",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: display.entry.element.id,
          });
        },
        onError: (mutationError) => {
          onFeedback(null);
          onError(mutationError.message);
          logger.warn("spec_studio.review_action.failed", {
            action: "comment",
            specId: detail.spec.id,
            revisionId: currentSnapshot.revision.id,
            elementId: display.entry.element.id,
            error: mutationError.message,
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
              )}
              className="inline-flex min-h-[28px] items-center font-mono text-[0.72rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
            >
              {handle}
            </Link>
          )}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={change.summary}
              className="group flex min-h-[32px] min-w-0 cursor-pointer items-start gap-sm border-0 bg-transparent p-0 text-left font-mono text-[0.82rem] leading-relaxed text-text-primary hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:col-span-2 max-768:row-start-2 max-768:min-h-[44px]"
            >
              <InlineReviewDiff
                segments={inlineDiff}
                fallback={change.summary}
              />
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
            <Button
              size="sm"
              touch
              onClick={() => {
                setCommenting((open) => !open);
                setExpanded(true);
              }}
            >
              Comment
            </Button>
            {combinedApproval ? (
              <StatusChip
                tone="neutral"
                title="The combined sign-off is the approval act"
              >
                Covered by sign-off
              </StatusChip>
            ) : approvalApplies ? (
              <Button
                size="sm"
                touch
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
            {showExpandedBody && expandedBody !== null && (
              <RevisionValue
                label={
                  current === null && baseSnapshot !== null
                    ? `Revision ${baseSnapshot.revision.number}`
                    : `Revision ${currentSnapshot.revision.number}`
                }
                body={expandedBody.body}
              />
            )}
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
                    const criterionThreads = groupThreads(detail).filter(
                      (thread) =>
                        thread.comments[0]?.element_id === criterion.elementId,
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
                            )}
                            className="inline-flex min-h-[28px] shrink-0 items-center font-mono text-[0.72rem] font-bold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
                          >
                            {criterionDisplay.handle}
                          </Link>
                          <InlineReviewDiff
                            segments={formatInlineReviewDiff(
                              reviewHeadline(criterion.base),
                              reviewHeadline(criterion.current),
                            )}
                            fallback={criterionDisplay.body}
                          />
                          <StatusChip
                            tone={criterionTone[criterion.change]}
                            layoutClassName="ml-auto"
                          >
                            {capitalize(criterion.change)}
                          </StatusChip>
                        </div>
                        {criterionThreads.length > 0 && (
                          <ReviewThreads
                            threads={criterionThreads}
                            detail={detail}
                            currentSnapshot={currentSnapshot}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>

        {threads.length > 0 && (
          <ReviewThreads
            threads={threads}
            detail={detail}
            currentSnapshot={currentSnapshot}
          />
        )}

        {commenting && (
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
                size="sm"
                touch
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

function InlineReviewDiff({
  segments,
  fallback,
}: {
  segments: InlineReviewDiffSegment[];
  fallback: string;
}): React.JSX.Element {
  return (
    <span className="min-w-0 grow [overflow-wrap:anywhere] whitespace-pre-wrap">
      {segments.length === 0
        ? fallback
        : segments.map((segment, index) => {
            if (segment.kind === "added") {
              return (
                <ins
                  key={`${segment.kind}-${index}`}
                  className="rounded-sm bg-green-glow text-green no-underline"
                >
                  {segment.text}
                </ins>
              );
            }
            if (segment.kind === "removed") {
              return (
                <del
                  key={`${segment.kind}-${index}`}
                  className="rounded-sm bg-red-glow text-red-text line-through"
                >
                  {segment.text}
                </del>
              );
            }
            return <span key={`${segment.kind}-${index}`}>{segment.text}</span>;
          })}
    </span>
  );
}

function reviewHeadline(view: ReviewElementView | null): string | null {
  if (view === null) return null;
  const payload = view.entry.version.payload;
  switch (payload.kind) {
    case "section":
      return payload.body;
    case "requirement":
      return payload.statement;
    case "criterion":
      return payload.text;
    case "decision":
      return payload.title;
    case "task":
      return payload.title;
  }
}

function shouldShowExpandedBody(view: ReviewElementView | null): boolean {
  if (view === null) return false;
  if (view.body !== reviewHeadline(view)) return true;
  return /(\*\*|__|`|\[[^\]]+\]\(|^#{1,6}\s|^\s*[-*+]\s)/m.test(view.body);
}

function RevisionValue({
  label,
  body,
}: {
  label: string;
  body: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0 bg-bg-base px-md py-sm">
      <span className="font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
        {label}
      </span>
      <div className="mt-sm">
        <CompactMarkdown content={body} />
      </div>
    </div>
  );
}

function ReviewThreads({
  threads,
  detail,
  currentSnapshot,
}: {
  threads: ReturnType<typeof groupThreads>;
  detail: SpecDetailView;
  currentSnapshot: SpecRevisionSnapshot;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Review threads"
      className="grid gap-sm border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-md py-sm"
    >
      {threads.map((thread) => {
        const original = thread.comments[0];
        if (original === undefined) return null;
        const anchor = parseAnchor(original.anchor_json);
        const currentBody = bodyForElement(
          currentSnapshot,
          original.element_id,
        );
        const state =
          anchor === null
            ? { status: "stale" as const }
            : reanchorSpecThread(anchor, currentBody);
        const originalRevision = detail.revisions.find(
          (revision) => revision.id === original.revision_id,
        );

        return (
          <article
            key={thread.threadId}
            data-testid={`review-thread-${thread.threadId}`}
            className="rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-xs">
              {original.blocking === 1 && (
                <StatusChip
                  tone={original.resolution === "open" ? "red" : "green"}
                >
                  Blocking · {original.resolution}
                </StatusChip>
              )}
              <StatusChip tone={anchorTone[state.status]}>
                {anchorLabel[state.status]}
              </StatusChip>
              <span className="font-mono text-[0.7rem] text-text-tertiary">
                Original revision {originalRevision?.number ?? "unknown"}
              </span>
            </div>
            {anchor !== null && (
              <blockquote className="mt-sm mb-0 border-x-0 border-t-0 border-b-0 border-l-2 border-solid border-cyan-dim pl-sm text-[0.7rem] leading-relaxed text-text-tertiary">
                “{anchor.quote}”
              </blockquote>
            )}
            <div className="mt-sm grid gap-xs">
              {thread.comments.map((comment) => (
                <p
                  key={comment.id}
                  className="m-0 font-mono text-[0.74rem] leading-relaxed text-text-secondary"
                >
                  {comment.body}
                </p>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function toDiffRows(snapshot: SpecRevisionSnapshot): RevisionElement[] {
  return snapshot.elements.map((entry) => ({
    elementId: entry.element.id,
    parentElementId: entry.element.parentElementId,
    payloadHash: entry.version.payloadHash,
    payload: entry.version.payload,
  }));
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
  change: SemanticChange,
  current: ReviewElementView | null,
  handle: string,
): string {
  const detailPath = detailPathFor(projectName, slug);
  if (
    change.change === "removed" ||
    current?.entry.version.payload.kind === "section"
  ) {
    return `${detailPath}?view=review&change=${encodeURIComponent(change.elementId)}`;
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
): string {
  const detailPath = detailPathFor(projectName, slug);
  return criterion.change === "removed"
    ? `${detailPath}?view=review&change=${encodeURIComponent(criterion.elementId)}`
    : `${detailPath}?el=${encodeURIComponent(handle)}`;
}

function reviewChangeTargetId(elementId: string): string {
  return `review-change-${elementId}`;
}

function groupThreads(detail: SpecDetailView): Array<{
  threadId: string;
  comments: SpecDetailView["comments"];
}> {
  const grouped = new Map<string, SpecDetailView["comments"]>();
  for (const comment of detail.comments) {
    const comments = grouped.get(comment.thread_id) ?? [];
    comments.push(comment);
    grouped.set(comment.thread_id, comments);
  }
  return [...grouped.entries()].map(([threadId, comments]) => ({
    threadId,
    comments: comments.toSorted((left, right) =>
      left.created_at.localeCompare(right.created_at),
    ),
  }));
}

function parseAnchor(anchorJson: string): CommentAnchor | null {
  try {
    const parsed = commentAnchorSchema.safeParse(JSON.parse(anchorJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
