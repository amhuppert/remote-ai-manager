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
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TabsTriggerCount,
} from "@/components/ui/Tabs";
import {
  commentAnchorSchema,
  type CommentAnchor,
} from "@/lib/document-comments/schemas";
import { createClientLogger } from "@/lib/logging/client-logger";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";
import {
  diffRevisions,
  type RevisionElement,
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

import { reanchorSpecThread, type SpecThreadAnchorState } from "./reanchor";
import SpecPhaseFacets from "./SpecPhaseFacets";

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

export default function SpecReviewMode({
  detail,
  projectName,
  highlightedChangeId,
}: {
  detail: SpecDetailView;
  projectName: string;
  highlightedChangeId: string | null;
}): React.JSX.Element {
  const baseSnapshot = detail.baseRevision;
  const currentSnapshot = detail.currentRevision;
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (
    currentSnapshot === null ||
    diff === null ||
    currentSnapshot.revision.state !== "proposed"
  ) {
    return (
      <EmptyState>
        <EmptyStateTitle>Review mode unavailable</EmptyStateTitle>
        <EmptyStateDesc>
          Review mode requires a proposed revision.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  const reviewPath = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(detail.spec.slug)}`;
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
          setFeedback(`Draft revision ${draft.number} opened`);
          logger.info("spec_studio.review_action.completed", {
            action: "request-changes",
            specId: detail.spec.id,
            revisionId,
            draftRevisionId: draft.id,
          });
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
          setFeedback(`Revision ${currentRevision.number} signed off`);
          logger.info("spec_studio.review_action.completed", {
            action: "sign-off",
            specId: detail.spec.id,
            revisionId,
          });
        },
        onError: (mutationError) => reportError("sign-off", mutationError),
      },
    );
  }

  function handleBulkApproval(mode: "requirements" | "remaining"): void {
    const subjects = bulkApprovalSubjects(detail, mode);
    if (subjects.length === 0) return;
    setError(null);
    setFeedback(
      mode === "requirements"
        ? "Approving every requirement…"
        : "Approving every remaining review subject…",
    );
    bulkApprove.mutate(
      { revisionId, subjects },
      {
        onSuccess: (approvals) => {
          setFeedback(`${approvals.length} approval records written`);
          logger.info("spec_studio.review_action.completed", {
            action: `bulk-approve-${mode}`,
            specId: detail.spec.id,
            revisionId,
            approvalCount: approvals.length,
          });
        },
        onError: (mutationError) =>
          reportError(`bulk-approve-${mode}`, mutationError),
      },
    );
  }

  const requirementSubjects = bulkApprovalSubjects(detail, "requirements");
  const remainingSubjects = bulkApprovalSubjects(detail, "remaining");

  return (
    <div className="px-xl py-lg max-768:px-md">
      <header className="flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
        <div>
          <div className="flex flex-wrap items-center gap-sm">
            <h1 className="m-0 font-display text-[1.05rem] font-extrabold text-text-primary">
              Review revision {currentSnapshot.revision.number}
            </h1>
            <StatusChip tone="amber">Proposed</StatusChip>
            <StatusChip tone="neutral">
              {baseSnapshot === null
                ? "Initial proposal"
                : `From revision ${baseSnapshot.revision.number}`}
            </StatusChip>
          </div>
          <p className="mt-sm mb-0 max-w-[760px] text-[0.78rem] leading-relaxed text-text-secondary">
            Review semantic changes first. Comments preserve their original
            revision anchors, and approval validity is projected for this frozen
            proposal.
          </p>
          <div className="mt-sm">
            <SpecPhaseFacets status={detail.status} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <Link
            href={reviewPath}
            className="font-mono text-[0.72rem] font-medium text-text-secondary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Exit review
          </Link>
          <Button
            size="sm"
            variant="success"
            loading={bulkApprove.isPending}
            disabled={requirementSubjects.length === 0}
            onClick={() => handleBulkApproval("requirements")}
          >
            Approve all requirements
          </Button>
          <Button
            size="sm"
            variant="success"
            loading={bulkApprove.isPending}
            disabled={remainingSubjects.length === 0}
            onClick={() => handleBulkApproval("remaining")}
          >
            Approve all remaining
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" loading={requestChanges.isPending}>
                Request changes
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Request changes?</AlertDialogTitle>
              <AlertDialogDescription>
                This ends the current review attempt, withdraws revision{" "}
                {currentSnapshot.revision.number}, and opens a follow-up draft
                based on it.
              </AlertDialogDescription>
              <AlertDialogActions>
                <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
                <AlertDialogAction onClick={handleRequestChanges}>
                  End review — open draft
                </AlertDialogAction>
              </AlertDialogActions>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>

      <div
        aria-live="polite"
        className="min-h-[28px] py-sm font-mono text-[0.7rem] text-cyan"
      >
        {feedback}
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-md rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.72rem] text-red"
        >
          {error}
        </p>
      )}

      <TabsRoot defaultValue="semantic">
        <TabsList layoutClassName="w-fit max-768:w-full">
          <TabsTrigger
            value="semantic"
            fill
            layoutClassName="max-768:grow max-768:basis-0"
          >
            Semantic changes
            <TabsTriggerCount>{diff.changeList.length}</TabsTriggerCount>
          </TabsTrigger>
          <TabsTrigger
            value="raw"
            fill
            layoutClassName="max-768:grow max-768:basis-0"
          >
            Raw diff
          </TabsTrigger>
        </TabsList>
        <TabsContent value="semantic" layoutClassName="mt-lg">
          <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-xl max-1180:grid-cols-1">
            <section
              aria-label="Semantic changes"
              className="grid min-w-0 gap-md"
            >
              {diff.changeList.length === 0 ? (
                <EmptyState>
                  <EmptyStateTitle>No semantic changes</EmptyStateTitle>
                  <EmptyStateDesc>
                    The proposed revision matches its base.
                  </EmptyStateDesc>
                </EmptyState>
              ) : (
                diff.changeList.map((change) => (
                  <ReviewChangeCard
                    key={change.elementId}
                    change={change}
                    detail={detail}
                    projectName={projectName}
                    baseSnapshot={baseSnapshot}
                    currentSnapshot={currentSnapshot}
                    onFeedback={setFeedback}
                    onError={setError}
                  />
                ))
              )}
            </section>
            <ReviewThreads detail={detail} currentSnapshot={currentSnapshot} />
          </div>
        </TabsContent>
        <TabsContent value="raw" layoutClassName="mt-lg">
          <section className="rounded-lg border border-solid border-border-subtle bg-bg-surface">
            <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
              <h2 className="m-0 font-display text-[0.88rem] font-bold text-text-primary">
                Raw diff
              </h2>
              <p className="mt-xs mb-0 font-mono text-[0.68rem] text-text-tertiary">
                Secondary view — semantic changes are the review contract.
              </p>
            </div>
            <pre className="m-0 max-h-[65vh] overflow-auto p-md font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap text-text-secondary">
              {formatRawDiff(baseSnapshot, currentSnapshot, diff.changeList)}
            </pre>
          </section>
        </TabsContent>
      </TabsRoot>

      <footer className="mt-xl flex flex-wrap items-center justify-between gap-md border-x-0 border-t border-b-0 border-solid border-border-dim pt-lg">
        <p className="m-0 max-w-[680px] text-[0.76rem] leading-relaxed text-text-secondary">
          Sign-off freezes revision {currentSnapshot.revision.number}. The
          server will refuse it while required approvals, blocking threads, or
          gates remain.
        </p>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="success" loading={signOff.isPending}>
              Sign off revision
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Sign off revision?</AlertDialogTitle>
            <AlertDialogDescription>
              This is the explicit human act that freezes revision{" "}
              {currentSnapshot.revision.number} as approved.
            </AlertDialogDescription>
            <AlertDialogActions>
              <AlertDialogCancel>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction onClick={handleSignOff}>
                Sign off — freeze revision
              </AlertDialogAction>
            </AlertDialogActions>
          </AlertDialogContent>
        </AlertDialog>
      </footer>
    </div>
  );
}

export function bulkApprovalSubjects(
  detail: SpecDetailView,
  mode: "requirements" | "remaining",
): BulkApprovalSubject[] {
  const snapshot = detail.currentRevision;
  if (snapshot === null || snapshot.revision.state !== "proposed") return [];

  const elementSubjects = snapshot.elements.flatMap(
    (entry): ApprovalTarget[] => {
      if (entry.version.payload.kind === "requirement") {
        return [{ subjectKind: "requirement", elementId: entry.element.id }];
      }
      if (entry.version.payload.kind === "decision") {
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

  const remaining: BulkApprovalSubject[] = elementSubjects.filter(
    (subject) =>
      latestSubjectApproval(detail.approvals, subject)?.validity !== "valid",
  );
  const planSubject = { subjectKind: "plan" as const, elementId: null };
  if (
    latestSubjectApproval(detail.approvals, planSubject)?.validity !== "valid"
  ) {
    remaining.push(planSubject);
  }
  return remaining;
}

function latestSubjectApproval(
  approvals: SpecApprovalRow[],
  subject: BulkApprovalSubject,
): SpecApprovalRow | null {
  return (
    approvals
      .filter(
        (approval) =>
          approval.subject_kind === subject.subjectKind &&
          approval.element_id === subject.elementId,
      )
      .toSorted((left, right) =>
        left.granted_at === right.granted_at
          ? left.id.localeCompare(right.id)
          : left.granted_at.localeCompare(right.granted_at),
      )
      .at(-1) ?? null
  );
}

function ReviewChangeCard({
  change,
  detail,
  projectName,
  baseSnapshot,
  currentSnapshot,
  onFeedback,
  onError,
}: {
  change: SemanticChange;
  detail: SpecDetailView;
  projectName: string;
  baseSnapshot: SpecRevisionSnapshot | null;
  currentSnapshot: SpecRevisionSnapshot;
  onFeedback(feedback: string | null): void;
  onError(error: string | null): void;
}): React.JSX.Element {
  const [commenting, setCommenting] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const base = viewForElement(baseSnapshot, change.elementId);
  const current = viewForElement(currentSnapshot, change.elementId);
  const display = current ?? base;
  const handle = display?.handle ?? change.elementId;
  const approvalTarget = approvalTargetFor(
    current ?? base,
    currentSnapshot,
    baseSnapshot,
  );
  const approval =
    approvalTarget === null
      ? null
      : approvalFor(detail.approvals, approvalTarget);

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

  return (
    <article
      id={reviewChangeTargetId(change.elementId)}
      data-testid={`review-change-${change.elementId}`}
      tabIndex={-1}
      className="rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-xs">
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
                className="font-mono text-[0.7rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                {handle}
              </Link>
            )}
            {approval?.validity === "stale" && (
              <StatusChip tone="amber">Approval stale</StatusChip>
            )}
            {approval?.validity === "valid" && (
              <StatusChip tone="green">Approved</StatusChip>
            )}
          </div>
          <h2 className="mt-sm mb-0 text-[0.82rem] font-semibold text-text-primary">
            {change.summary}
          </h2>
        </div>
        <div className="flex flex-wrap gap-xs">
          <Button size="sm" onClick={() => setCommenting((open) => !open)}>
            Comment
          </Button>
          <Button
            size="sm"
            variant="success"
            disabled={approvalTarget === null || change.change === "removed"}
            loading={approve.isPending}
            onClick={approveItem}
            title={
              approvalTarget === null
                ? "This element has no independent approval gate"
                : undefined
            }
          >
            Approve item
          </Button>
        </div>
      </div>

      {change.change === "modified" ? (
        <div className="grid grid-cols-2 gap-px bg-border-dim max-768:grid-cols-1">
          <RevisionValue
            label={
              baseSnapshot === null
                ? "Empty baseline"
                : `Revision ${baseSnapshot.revision.number}`
            }
            body={base?.body ?? "Not present"}
          />
          <RevisionValue
            label={`Revision ${currentSnapshot.revision.number}`}
            body={current?.body ?? "Not present"}
          />
        </div>
      ) : (
        <div className="px-md py-sm text-[0.76rem] leading-relaxed text-text-secondary">
          {(current ?? base)?.body ?? "Element content unavailable"}
        </div>
      )}

      {commenting && (
        <div className="border-x-0 border-t border-b-0 border-solid border-border-dim px-md py-sm">
          <label
            htmlFor={`comment-${change.elementId}`}
            className="mb-xs block font-mono text-[0.68rem] font-semibold tracking-[0.06em] text-text-secondary uppercase"
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
            className="box-border w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[9px] font-mono text-[0.78rem] text-text-primary outline-0 placeholder:text-text-tertiary hover:border-border-strong focus:border-cyan focus:shadow-[0_0_0_3px_var(--cyan-glow)]"
            placeholder="Leave review context for this element"
          />
          <div className="mt-sm flex justify-end">
            <Button
              size="sm"
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
  );
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
      <span className="font-mono text-[0.64rem] tracking-[0.06em] text-text-tertiary uppercase">
        {label}
      </span>
      <p className="mt-sm mb-0 text-[0.76rem] leading-relaxed whitespace-pre-wrap text-text-secondary">
        {body}
      </p>
    </div>
  );
}

function ReviewThreads({
  detail,
  currentSnapshot,
}: {
  detail: SpecDetailView;
  currentSnapshot: SpecRevisionSnapshot;
}): React.JSX.Element {
  const threads = groupThreads(detail);

  return (
    <aside
      aria-label="Review threads"
      className="sticky top-[calc(var(--topbar-height)+var(--space-lg))] rounded-lg border border-solid border-border-subtle bg-bg-surface max-1180:static"
    >
      <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-display text-[0.86rem] font-bold text-text-primary">
          Review threads
        </h2>
        <p className="mt-xs mb-0 font-mono text-[0.66rem] text-text-tertiary">
          Original anchors remain authoritative
        </p>
      </div>
      <div className="grid max-h-[65vh] gap-sm overflow-y-auto p-sm max-1180:max-h-none">
        {threads.length === 0 ? (
          <p className="m-0 px-sm py-md font-mono text-[0.7rem] text-text-tertiary">
            No review threads
          </p>
        ) : (
          threads.map((thread) => {
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
                className="rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-xs">
                  <StatusChip tone={anchorTone[state.status]}>
                    {anchorLabel[state.status]}
                  </StatusChip>
                  <span className="font-mono text-[0.64rem] text-text-tertiary">
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
                      className="m-0 text-[0.74rem] leading-relaxed text-text-secondary"
                    >
                      {comment.body}
                    </p>
                  ))}
                </div>
              </article>
            );
          })
        )}
      </div>
    </aside>
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
    body: bodyFor(entry),
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

function bodyFor(entry: SpecRevisionElement): string {
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
    case "task":
      return `${payload.title}\n${payload.instructions}`;
  }
}

function bodyForElement(
  snapshot: SpecRevisionSnapshot,
  elementId: string,
): string | null {
  const entry = snapshot.elements.find(
    (candidate) => candidate.element.id === elementId,
  );
  return entry === undefined ? null : bodyFor(entry);
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
  const detailPath = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
  if (
    change.change === "removed" ||
    current?.entry.version.payload.kind === "section"
  ) {
    return `${detailPath}?view=review&change=${encodeURIComponent(change.elementId)}`;
  }
  return `${detailPath}?el=${encodeURIComponent(handle)}`;
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
