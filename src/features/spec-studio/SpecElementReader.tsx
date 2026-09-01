"use client";

import { useId, useState, type ReactNode } from "react";
import { z } from "zod";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import { Button } from "@/components/ui/Button";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { ApiCallError } from "@/lib/api/errors";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import type { SpecDetailView } from "@/lib/specs/queries";

export type SpecElementReaderKind = "requirements" | "decisions" | "tasks";

export interface SpecElementReaderProps {
  detail: SpecDetailView;
  kind: SpecElementReaderKind;
  /** Route segment the draft-removal action is addressed through. */
  projectName: string;
  criterionEvidence?(criterion: SnapshotElement): ReactNode;
}

type Snapshot = NonNullable<SpecDetailView["currentRevision"]>;
type SnapshotElement = Snapshot["elements"][number];
type ApprovalValidity = SpecDetailView["approvals"][number]["validity"];
type RequirementStatus =
  SpecDetailView["elementStatuses"]["requirements"][number]["status"];
type TaskStatus =
  SpecDetailView["elementStatuses"]["tasks"][number]["status"]["status"];

interface ChipPresentation {
  label: string;
  tone: StatusChipTone;
}

const KIND_COPY: Record<
  SpecElementReaderKind,
  { title: string; singular: string }
> = {
  requirements: { title: "Requirements", singular: "requirement" },
  decisions: { title: "Decisions", singular: "decision" },
  tasks: { title: "Tasks", singular: "task" },
};

const REVISION_PRESENTATION: Record<
  Snapshot["revision"]["state"],
  ChipPresentation
> = {
  draft: { label: "Draft", tone: "neutral" },
  proposed: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

const TASK_STATUS_PRESENTATION: Record<TaskStatus, ChipPresentation> = {
  pending: { label: "Pending", tone: "neutral" },
  running: { label: "Running", tone: "cyan" },
  interrupted: { label: "Interrupted", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
};

const APPROVAL_PRESENTATION: Record<
  ApprovalValidity | "unapproved",
  ChipPresentation
> = {
  valid: { label: "Approved", tone: "green" },
  stale: { label: "Approval stale", tone: "amber" },
  closed: { label: "Approval closed", tone: "neutral" },
  unapproved: { label: "Not approved", tone: "neutral" },
};

export function SpecElementReader({
  detail,
  kind,
  projectName,
  criterionEvidence,
}: SpecElementReaderProps): React.JSX.Element {
  const readerId = useId();
  const copy = KIND_COPY[kind];
  const titleId = `${readerId}-${kind}-title`;
  const snapshot = detail.currentRevision ?? detail.currentApprovedRevision;
  // Only the current revision is editable, and only while it is a draft: a
  // removal against an approved or proposed revision is refused server-side,
  // so offering the control there would be a button that only ever fails.
  const removal = useDraftElementRemoval({
    projectName,
    slug: detail.spec.slug,
    revision:
      detail.currentRevision !== null &&
      detail.currentRevision.revision.state === "draft"
        ? detail.currentRevision
        : null,
  });

  if (snapshot === null) {
    return (
      <ReaderFrame title={copy.title} titleId={titleId}>
        <EmptyState>
          <EmptyStateTitle>No revision available</EmptyStateTitle>
          <EmptyStateDesc>
            A current or approved revision is required to read {kind}.
          </EmptyStateDesc>
        </EmptyState>
      </ReaderFrame>
    );
  }

  const elements = elementsForKind(snapshot, kind);
  const revision = REVISION_PRESENTATION[snapshot.revision.state];

  return (
    <ReaderFrame
      title={copy.title}
      titleId={titleId}
      metadata={
        <>
          <StatusChip tone="neutral">
            Revision {snapshot.revision.number}
          </StatusChip>
          <StatusChip tone={revision.tone}>{revision.label}</StatusChip>
        </>
      }
      notice={<ReintroductionNotice removal={removal} />}
    >
      {elements.length === 0 ? (
        <EmptyState>
          <EmptyStateTitle>
            No {kind} in revision {snapshot.revision.number}
          </EmptyStateTitle>
          <EmptyStateDesc>
            This revision does not contain a {copy.singular} record.
          </EmptyStateDesc>
        </EmptyState>
      ) : kind === "requirements" ? (
        <RequirementDocument
          detail={detail}
          snapshot={snapshot}
          requirements={elements}
          readerId={readerId}
          removal={removal}
          criterionEvidence={criterionEvidence}
        />
      ) : kind === "decisions" ? (
        <DecisionDocument
          detail={detail}
          snapshot={snapshot}
          decisions={elements}
          readerId={readerId}
          removal={removal}
        />
      ) : (
        <TaskDocument
          detail={detail}
          snapshot={snapshot}
          tasks={elements}
          readerId={readerId}
          removal={removal}
        />
      )}
    </ReaderFrame>
  );
}

function ReaderFrame({
  title,
  titleId,
  metadata,
  notice,
  children,
}: {
  title: string;
  titleId: string;
  metadata?: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={titleId}
      className="mx-auto flex w-full max-w-[1000px] flex-col gap-xl font-mono text-text-primary"
    >
      <div className="flex items-end justify-between gap-lg max-768:flex-col max-768:items-start">
        <div className="flex min-w-0 flex-col gap-xs">
          <span className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
            Full document
          </span>
          <h2
            id={titleId}
            className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-text-primary"
          >
            {title}
          </h2>
        </div>
        {metadata === undefined ? null : (
          <div className="flex flex-wrap items-center gap-sm">{metadata}</div>
        )}
      </div>
      {notice}
      {children}
    </section>
  );
}

/** The draft-remove action answers with nothing but its own success. */
const removeDraftElementResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

/**
 * The structural half of a dangling-reference refusal. Parsed leniently — an
 * older server sends no references at all, and the message alone is still a
 * usable refusal.
 */
const danglingReferencesSchema = z.object({
  references: z.array(
    z
      .object({
        sourceElementId: z.string().min(1),
        targetId: z.string().min(1),
        relation: z.string().min(1),
      })
      .passthrough(),
  ),
});

interface RemovalTarget {
  readonly elementId: string;
  readonly handle: string;
  readonly baseElementVersion: number;
}

/**
 * A refused removal, told apart by whether this surface can diagnose it. A
 * dangling reference is the one refusal the reader can name in the document's
 * own vocabulary and prescribe the fix for; every other refusal — a stale
 * version, a stage boundary, a write that could not be persisted — carries the
 * server's own account, and restating it as "still referenced" would print a
 * false diagnosis and a remedy that does not apply.
 */
type RemovalRefusalCause =
  | { readonly kind: "dangling"; readonly references: string[] }
  | { readonly kind: "refused"; readonly message: string };

type RemovalRefusal = RemovalRefusalCause & { readonly elementId: string };

interface DraftRemoval {
  /** Null when the rendered revision cannot be edited. */
  readonly revisionId: string | null;
  readonly confirmingElementId: string | null;
  readonly pendingElementId: string | null;
  readonly refusal: RemovalRefusal | null;
  readonly removedHandle: string | null;
  readonly slug: string;
  ask(elementId: string): void;
  cancel(): void;
  remove(target: RemovalTarget): void;
}

/**
 * The one draft-element removal path Spec Studio has: the same production
 * `draft-remove` action `cctl spec remove` reaches, addressed by the element's
 * own compare-and-swap version. Refusals are whole — nothing is removed — so
 * the failure is reported against the element that was asked for rather than
 * as a page-level error.
 */
function useDraftElementRemoval({
  projectName,
  slug,
  revision,
}: {
  projectName: string;
  slug: string;
  revision: Snapshot | null;
}): DraftRemoval {
  const [confirmingElementId, setConfirming] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<DraftRemoval["refusal"]>(null);
  const [removedHandle, setRemovedHandle] = useState<string | null>(null);
  const mutation = useSpecActionMutation<
    { revisionId: string; elementId: string; baseElementVersion: number },
    z.infer<typeof removeDraftElementResponseSchema>
  >(projectName, slug, "draft-remove", removeDraftElementResponseSchema);
  const revisionId = revision?.revision.id ?? null;

  return {
    revisionId,
    slug,
    confirmingElementId,
    pendingElementId: mutation.isPending ? confirmingElementId : null,
    refusal,
    removedHandle,
    ask(elementId) {
      setRefusal(null);
      setRemovedHandle(null);
      setConfirming(elementId);
    },
    cancel() {
      setConfirming(null);
      setRefusal(null);
    },
    remove(target) {
      if (revisionId === null || revision === null) return;
      mutation.mutate(
        {
          revisionId,
          elementId: target.elementId,
          baseElementVersion: target.baseElementVersion,
        },
        {
          onSuccess: () => {
            setConfirming(null);
            setRefusal(null);
            setRemovedHandle(target.handle);
          },
          onError: (error) => {
            setConfirming(null);
            setRefusal({
              elementId: target.elementId,
              ...classifyRefusal(error, revision),
            });
          },
        },
      );
    },
  };
}

/**
 * Why the removal was refused. A dangling reference is restated in the
 * vocabulary the document is written in — it names both of its ends by handle,
 * because the ids the server reports address storage and a reviewer reading
 * `R1.1` on the page cannot act on `criterion-1`. Any other refusal is passed
 * through as the server worded it, which is where its own recovery lives.
 */
function classifyRefusal(
  error: Error,
  snapshot: Snapshot,
): RemovalRefusalCause {
  const parsed =
    error instanceof ApiCallError
      ? danglingReferencesSchema.safeParse(error.details)
      : null;
  if (
    parsed === null ||
    !parsed.success ||
    parsed.data.references.length === 0
  ) {
    return { kind: "refused", message: error.message };
  }
  return {
    kind: "dangling",
    references: parsed.data.references.map((reference) => {
      const source = handleOfElementId(snapshot, reference.sourceElementId);
      const target = handleOfElementId(snapshot, reference.targetId);
      return `${source} ${reference.relation} ${target}`;
    }),
  };
}

function handleOfElementId(snapshot: Snapshot, elementId: string): string {
  const entry = snapshot.elements.find(
    (candidate) => candidate.element.id === elementId,
  );
  return entry === undefined ? elementId : handleFor(entry, snapshot);
}

/**
 * Removal's inverse, shown once the element itself is gone from the document.
 * Naming it anywhere on the removed element would put the recovery on the one
 * surface a successful removal deletes.
 */
function ReintroductionNotice({
  removal,
}: {
  removal: DraftRemoval;
}): React.JSX.Element | null {
  if (removal.removedHandle === null) return null;
  return (
    <p
      role="status"
      className="m-0 rounded-md border border-solid border-border-subtle bg-bg-surface p-md text-[0.72rem] leading-[1.6] text-text-secondary"
    >
      Removed {removal.slug}/{removal.removedHandle}. Removal is not deletion —
      the element id is still this spec&rsquo;s, so saving it again with{" "}
      <code>&quot;reintroduceHistorical&quot;: true</code> and a null base
      version brings it back with its original number and handle.
    </p>
  );
}

/**
 * The per-element removal control. Two steps, because the first click is the
 * one an operator makes by accident; both steps stay visible controls rather
 * than a hover affordance, so keyboard and touch reach them identically.
 */
function RemoveElementAction({
  removal,
  target,
  kindLabel,
}: {
  removal: DraftRemoval;
  target: RemovalTarget;
  kindLabel: string;
}): React.JSX.Element | null {
  if (removal.revisionId === null) return null;
  const confirming = removal.confirmingElementId === target.elementId;
  const refusal =
    removal.refusal?.elementId === target.elementId ? removal.refusal : null;

  return (
    <div className="flex flex-col gap-xs">
      <div className="flex flex-wrap items-center gap-xs">
        {confirming ? (
          <>
            <Button
              variant="danger"
              size="sm"
              loading={removal.pendingElementId === target.elementId}
              onClick={() => removal.remove(target)}
            >
              Confirm remove {target.handle}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => removal.cancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => removal.ask(target.elementId)}
          >
            Remove {target.handle}
          </Button>
        )}
      </div>
      {refusal === null ? null : (
        <div
          role="alert"
          className="flex flex-col gap-xs rounded-md border border-solid border-[var(--cc-red-border)] bg-red-glow p-md text-[0.72rem] leading-[1.6] text-text-secondary"
        >
          {refusal.kind === "dangling" ? (
            <>
              <p className="m-0 text-text-primary">
                Nothing was removed — this {kindLabel} is still referenced.
              </p>
              <ul className="m-0 flex list-none flex-col gap-2xs p-0">
                {refusal.references.map((reference) => (
                  <li key={reference}>{reference}</li>
                ))}
              </ul>
              <p className="m-0">
                Rewrite the referring element, or remove it alongside this one
                in a single act — <code>cctl spec remove {removal.slug} …</code>{" "}
                takes both out in one transaction.
              </p>
            </>
          ) : (
            <>
              <p className="m-0 text-text-primary">
                Nothing was removed — {target.handle} is unchanged.
              </p>
              {/* The server's own words: its refusal carries the recovery that
                  actually applies, which this surface cannot infer. */}
              <p className="m-0">{refusal.message}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementDocument({
  detail,
  snapshot,
  requirements,
  readerId,
  removal,
  criterionEvidence,
}: {
  detail: SpecDetailView;
  snapshot: Snapshot;
  requirements: SnapshotElement[];
  readerId: string;
  removal: DraftRemoval;
  criterionEvidence?: (criterion: SnapshotElement) => ReactNode;
}): React.JSX.Element {
  const criteriaByRequirement = new Map<string, SnapshotElement[]>();
  for (const entry of orderedElements(snapshot.elements)) {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.parentElementId === null
    ) {
      continue;
    }
    const criteria =
      criteriaByRequirement.get(entry.element.parentElementId) ?? [];
    criteria.push(entry);
    criteriaByRequirement.set(entry.element.parentElementId, criteria);
  }

  return (
    <div className="flex flex-col gap-lg">
      {requirements.map((entry, index) => {
        if (entry.version.payload.kind !== "requirement") return null;
        const payload = entry.version.payload;
        const handle = handleFor(entry, snapshot);
        const headingId = `${readerId}-requirement-${index}`;
        const criteria = criteriaByRequirement.get(entry.element.id) ?? [];
        const status = detail.elementStatuses.requirements.find(
          (candidate) => candidate.elementId === entry.element.id,
        )?.status;
        const proof = requirementProofPresentation(status);
        const approval = requirementApprovalPresentation(
          detail,
          entry.element.id,
          status,
        );

        return (
          <article
            key={entry.element.id}
            id={handle}
            tabIndex={-1}
            aria-labelledby={headingId}
            data-spec-element={handle}
            className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg"
          >
            <div className="flex flex-col gap-md">
              <h3
                id={headingId}
                aria-label={`${handle} requirement`}
                className="text-[0.875rem] leading-[1.65] font-semibold text-text-primary"
              >
                <StatusChip tone="cyan">{handle}</StatusChip>
              </h3>
              <div className="min-w-0">
                <CompactMarkdown content={textOrDash(payload.statement)} />
              </div>
              <div className="flex flex-wrap items-center gap-sm">
                <StatusChip tone={proof.tone}>{proof.label}</StatusChip>
                <StatusChip tone={approval.tone}>{approval.label}</StatusChip>
                <StatusChip tone="neutral">
                  {sentenceCase(payload.priority)}
                </StatusChip>
                <StatusChip tone={riskTone(payload.risk)}>
                  {sentenceCase(payload.risk)} risk
                </StatusChip>
              </div>
              <RemoveElementAction
                removal={removal}
                kindLabel="requirement"
                target={{
                  elementId: entry.element.id,
                  handle,
                  baseElementVersion: entry.version.elementVersion,
                }}
              />
            </div>
            <CriteriaList
              criteria={criteria}
              snapshot={snapshot}
              headingId={`${headingId}-criteria`}
              removal={removal}
              criterionEvidence={criterionEvidence}
            />
          </article>
        );
      })}
    </div>
  );
}

function CriteriaList({
  criteria,
  snapshot,
  headingId,
  removal,
  criterionEvidence,
}: {
  criteria: SnapshotElement[];
  snapshot: Snapshot;
  headingId: string;
  removal: DraftRemoval;
  criterionEvidence?: (criterion: SnapshotElement) => ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={headingId}
      className="mt-xl border-x-0 border-t border-b-0 border-solid border-border-dim pt-lg"
    >
      <h4
        id={headingId}
        className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase"
      >
        Acceptance criteria
      </h4>
      {criteria.length === 0 ? (
        <p className="mt-md text-[0.78rem] text-text-tertiary">
          No acceptance criteria recorded.
        </p>
      ) : (
        <ol className="mt-md flex list-none flex-col gap-sm">
          {criteria.map((criterion) => {
            if (criterion.version.payload.kind !== "criterion") return null;
            return (
              <li
                key={criterion.element.id}
                id={handleFor(criterion, snapshot)}
                tabIndex={-1}
                aria-label={`${handleFor(criterion, snapshot)} criterion`}
                data-spec-element={handleFor(criterion, snapshot)}
                className="flex items-start gap-sm rounded-md border border-solid border-border-dim bg-bg-base p-md max-768:flex-col"
              >
                <StatusChip tone="neutral">
                  {handleFor(criterion, snapshot)}
                </StatusChip>
                <div className="flex min-w-0 flex-1 flex-col gap-sm">
                  <div className="min-w-0">
                    <CompactMarkdown
                      content={textOrDash(criterion.version.payload.text)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-xs text-[0.72rem] text-text-tertiary">
                    <span className="tracking-[0.08em] uppercase">
                      Validation
                    </span>
                    {criterion.version.payload.validationStrategy.kinds.map(
                      (validationKind) => (
                        <StatusChip key={validationKind} tone="neutral">
                          {sentenceCase(validationKind)}
                        </StatusChip>
                      ),
                    )}
                  </div>
                  {criterion.version.payload.validationStrategy.note ===
                  undefined ? null : (
                    <div className="min-w-0">
                      <CompactMarkdown
                        content={
                          criterion.version.payload.validationStrategy.note
                        }
                      />
                    </div>
                  )}
                  {criterionEvidence?.(criterion)}
                  <RemoveElementAction
                    removal={removal}
                    kindLabel="criterion"
                    target={{
                      elementId: criterion.element.id,
                      handle: handleFor(criterion, snapshot),
                      baseElementVersion: criterion.version.elementVersion,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function DecisionDocument({
  detail,
  snapshot,
  decisions,
  readerId,
  removal,
}: {
  detail: SpecDetailView;
  snapshot: Snapshot;
  decisions: SnapshotElement[];
  readerId: string;
  removal: DraftRemoval;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-lg">
      {decisions.map((entry, index) => {
        if (entry.version.payload.kind !== "decision") return null;
        const payload = entry.version.payload;
        const handle = handleFor(entry, snapshot);
        const headingId = `${readerId}-decision-${index}`;
        const status = decisionStatusPresentation(
          detail,
          snapshot,
          entry.element.id,
        );
        const requirementHandles = elementHandles(
          payload.tracedRequirementElementIds,
          snapshot,
        );

        return (
          <article
            key={entry.element.id}
            id={handle}
            tabIndex={-1}
            aria-labelledby={headingId}
            data-spec-element={handle}
            className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg"
          >
            <div className="flex flex-col gap-md">
              <h3
                id={headingId}
                aria-label={`${handle} ${textOrDash(payload.title)}`}
                className="flex items-start gap-sm text-[0.875rem] leading-[1.65] font-semibold text-text-primary max-768:flex-col"
              >
                <StatusChip tone="cyan">{handle}</StatusChip>
                <span className="[overflow-wrap:anywhere]">
                  {textOrDash(payload.title)}
                </span>
              </h3>
              <div className="flex flex-wrap items-center gap-sm">
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </div>
              <RemoveElementAction
                removal={removal}
                kindLabel="decision"
                target={{
                  elementId: entry.element.id,
                  handle,
                  baseElementVersion: entry.version.elementVersion,
                }}
              />
            </div>
            <DocumentSection title="Chosen approach">
              <DocumentText content={textOrDash(payload.chosenApproach)} />
            </DocumentSection>
            {payload.reason.trim().length === 0 ? null : (
              <DocumentSection title="Rationale">
                <DocumentText content={payload.reason} />
              </DocumentSection>
            )}
            {payload.rejectedAlternatives.length === 0 ? null : (
              <DocumentSection title="Rejected alternatives">
                <ul className="flex list-none flex-col gap-sm">
                  {payload.rejectedAlternatives.map((alternative, altIndex) => (
                    <li
                      key={`${alternative.label}-${altIndex}`}
                      className="rounded-md border border-solid border-border-dim bg-bg-base p-md"
                    >
                      <p className="text-[0.875rem] leading-[1.65] font-semibold [overflow-wrap:anywhere] text-text-primary">
                        {textOrDash(alternative.label)}
                      </p>
                      <div className="mt-xs min-w-0">
                        <CompactMarkdown
                          content={textOrDash(alternative.reason)}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              </DocumentSection>
            )}
            {requirementHandles.length === 0 ? null : (
              <MetadataList
                rows={[
                  {
                    label: "Requirement links",
                    value: <HandleList handles={requirementHandles} />,
                  },
                ]}
              />
            )}
          </article>
        );
      })}
    </div>
  );
}

function TaskDocument({
  detail,
  snapshot,
  tasks,
  readerId,
  removal,
}: {
  detail: SpecDetailView;
  snapshot: Snapshot;
  tasks: SnapshotElement[];
  readerId: string;
  removal: DraftRemoval;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-lg">
      {tasks.map((entry, index) => {
        if (entry.version.payload.kind !== "task") return null;
        const payload = entry.version.payload;
        const handle = handleFor(entry, snapshot);
        const headingId = `${readerId}-task-${index}`;
        const statusValue = detail.elementStatuses.tasks.find(
          (candidate) => candidate.elementId === entry.element.id,
        )?.status.status;
        const status =
          statusValue === undefined
            ? TASK_STATUS_PRESENTATION.pending
            : TASK_STATUS_PRESENTATION[statusValue];
        const dependencies = elementHandles(
          payload.dependsOnTaskElementIds,
          snapshot,
        );
        const requirements = elementHandles(
          payload.tracedRequirementElementIds,
          snapshot,
        );
        const decisions = elementHandles(
          payload.tracedDecisionElementIds,
          snapshot,
        );
        const criteria = elementHandles(
          payload.coveredCriterionElementIds,
          snapshot,
        );
        const rows: Array<{ label: string; value: ReactNode }> = [
          {
            label: "Dependencies",
            value: <HandleList handles={dependencies} />,
          },
          {
            label: "Requirement links",
            value: <HandleList handles={requirements} />,
          },
          {
            label: "Decision links",
            value: <HandleList handles={decisions} />,
          },
          {
            label: "Criterion coverage",
            value: <HandleList handles={criteria} />,
          },
        ];
        if (payload.laneGroup !== undefined) {
          rows.push({ label: "Lane group", value: payload.laneGroup });
        }
        if (payload.executionLane !== undefined) {
          rows.push({ label: "Execution lane", value: payload.executionLane });
        }
        if (payload.touchedPaths !== undefined) {
          rows.push({
            label: "Touched paths",
            value:
              payload.touchedPaths.length === 0
                ? "None"
                : payload.touchedPaths.join(", "),
          });
        }

        return (
          <article
            key={entry.element.id}
            id={handle}
            tabIndex={-1}
            aria-labelledby={headingId}
            data-spec-element={handle}
            className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-xl max-768:p-lg"
          >
            <div className="flex flex-col gap-md">
              <h3
                id={headingId}
                aria-label={`${handle} ${textOrDash(payload.title)}`}
                className="flex items-start gap-sm text-[0.875rem] leading-[1.65] font-semibold text-text-primary max-768:flex-col"
              >
                <StatusChip tone="cyan">{handle}</StatusChip>
                <span className="[overflow-wrap:anywhere]">
                  {textOrDash(payload.title)}
                </span>
              </h3>
              <div className="flex flex-wrap items-center gap-sm">
                <StatusChip tone={status.tone}>{status.label}</StatusChip>
              </div>
              <RemoveElementAction
                removal={removal}
                kindLabel="task"
                target={{
                  elementId: entry.element.id,
                  handle,
                  baseElementVersion: entry.version.elementVersion,
                }}
              />
            </div>
            <DocumentSection title="Instructions">
              <DocumentText content={textOrDash(payload.instructions)} />
            </DocumentSection>
            <MetadataList rows={rows} />
          </article>
        );
      })}
    </div>
  );
}

function DocumentSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-xl border-x-0 border-t border-b-0 border-solid border-border-dim pt-lg">
      <h4 className="mb-md text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

function DocumentText({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <CompactMarkdown content={content} />
    </div>
  );
}

function MetadataList({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}): React.JSX.Element {
  return (
    <dl className="mt-xl flex flex-col gap-sm border-x-0 border-t border-b-0 border-solid border-border-dim pt-lg">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-md max-768:grid-cols-1 max-768:gap-xs"
        >
          <dt className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
            {row.label}
          </dt>
          <dd className="min-w-0 text-[0.875rem] leading-[1.65] [overflow-wrap:anywhere] whitespace-pre-wrap text-text-primary">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function HandleList({ handles }: { handles: string[] }): React.JSX.Element {
  if (handles.length === 0) {
    return <span className="text-text-tertiary">None</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-xs">
      {handles.map((handle) => (
        <StatusChip key={handle} tone="neutral">
          {handle}
        </StatusChip>
      ))}
    </span>
  );
}

function elementsForKind(
  snapshot: Snapshot,
  kind: SpecElementReaderKind,
): SnapshotElement[] {
  const payloadKind =
    kind === "requirements"
      ? "requirement"
      : kind === "decisions"
        ? "decision"
        : "task";
  return orderedElements(snapshot.elements).filter(
    (entry) => entry.version.payload.kind === payloadKind,
  );
}

function orderedElements(elements: SnapshotElement[]): SnapshotElement[] {
  return [...elements].sort((left, right) =>
    left.version.position === right.version.position
      ? left.element.id.localeCompare(right.element.id)
      : left.version.position - right.version.position,
  );
}

function handleFor(entry: SnapshotElement, snapshot: Snapshot): string {
  if (entry.handle !== undefined && entry.handle !== null) return entry.handle;
  const number = entry.element.number;
  switch (entry.version.payload.kind) {
    case "section":
      return entry.element.id;
    case "requirement":
      return number === null ? entry.element.id : `R${number}`;
    case "decision":
      return number === null ? entry.element.id : `D${number}`;
    case "task":
      return number === null ? entry.element.id : `T${number}`;
    case "criterion": {
      const parent = snapshot.elements.find(
        (candidate) => candidate.element.id === entry.element.parentElementId,
      );
      const parentHandle =
        parent === undefined ? null : handleFor(parent, snapshot);
      return number === null || parentHandle === null
        ? entry.element.id
        : `${parentHandle}.${number}`;
    }
  }
}

function elementHandles(elementIds: string[], snapshot: Snapshot): string[] {
  const elements = new Map(
    snapshot.elements.map((entry) => [entry.element.id, entry] as const),
  );
  return elementIds.map((elementId) => {
    const entry = elements.get(elementId);
    return entry === undefined ? elementId : handleFor(entry, snapshot);
  });
}

function latestApprovalValidity(
  detail: SpecDetailView,
  elementId: string,
  subjectKind: "requirement" | "decision",
): ApprovalValidity | "unapproved" {
  const approvals = detail.approvals.filter(
    (approval) =>
      approval.element_id === elementId &&
      approval.subject_kind === subjectKind,
  );
  const latest = approvals.reduce<(typeof approvals)[number] | undefined>(
    (current, approval) => {
      if (current === undefined) return approval;
      if (approval.granted_at !== current.granted_at) {
        return approval.granted_at > current.granted_at ? approval : current;
      }
      return approval.id > current.id ? approval : current;
    },
    undefined,
  );
  return latest?.validity ?? "unapproved";
}

function requirementApprovalPresentation(
  detail: SpecDetailView,
  elementId: string,
  status: RequirementStatus | undefined,
): ChipPresentation {
  const validity =
    status?.approval ??
    latestApprovalValidity(detail, elementId, "requirement");
  if (
    validity === "unapproved" &&
    detail.status.pendingApprovals.some(
      (pending) => pending.elementId === elementId,
    )
  ) {
    return { label: "Awaiting approval", tone: "amber" };
  }
  return APPROVAL_PRESENTATION[validity];
}

function requirementProofPresentation(
  status: RequirementStatus | undefined,
): ChipPresentation {
  switch (status?.proof) {
    case "proven":
      return { label: "Proven", tone: "green" };
    case "waived":
      return { label: "Waived", tone: "amber" };
    case "proven_and_waived":
      return { label: "Proven + waived", tone: "green" };
    // Neutral rather than green: the requirement is settled, but on an import's
    // testimony, and green is this system's success tone for work it saw
    // merged.
    case "delivered_externally":
      return { label: "Delivered externally", tone: "neutral" };
    case "partial":
      return { label: "Proof partial", tone: "amber" };
    case "pending":
      if (status.coverage === "covered") {
        return { label: "Covered", tone: "green" };
      }
      if (status.coverage === "partial") {
        return { label: "Partially covered", tone: "amber" };
      }
      return { label: "Uncovered", tone: "amber" };
    case undefined:
      return { label: "Not assessed", tone: "neutral" };
  }
}

function decisionStatusPresentation(
  detail: SpecDetailView,
  snapshot: Snapshot,
  elementId: string,
): ChipPresentation {
  const validity = latestApprovalValidity(detail, elementId, "decision");
  if (validity !== "unapproved") return APPROVAL_PRESENTATION[validity];
  if (
    detail.status.pendingApprovals.some(
      (pending) => pending.elementId === elementId,
    )
  ) {
    return { label: "Awaiting approval", tone: "amber" };
  }
  return REVISION_PRESENTATION[snapshot.revision.state];
}

function riskTone(risk: "high" | "medium" | "low"): StatusChipTone {
  if (risk === "high") return "red";
  if (risk === "medium") return "amber";
  return "neutral";
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ");
  return normalized.length === 0
    ? normalized
    : normalized[0]!.toUpperCase() + normalized.slice(1);
}

function textOrDash(value: string): string {
  return value.trim().length === 0 ? "—" : value;
}

export default SpecElementReader;
