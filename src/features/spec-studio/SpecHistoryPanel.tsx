"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/Button";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/SegmentedControl";
import type { StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { ActorProvenance } from "@/lib/specs/schemas";
import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionSnapshot } from "@/lib/specs/schemas";
import type { SpecImportRecordView } from "@/lib/specs/view-schemas";
import { cn } from "@/lib/ui/cn";

import { SpecActorAttribution } from "./SpecActorAttribution";
import { importProvenance } from "./presentation";

const logger = createClientLogger("spec-studio-history");

export type SpecHistoryKind =
  | "spec"
  | "revision"
  | "approval"
  | "admission"
  | "gate"
  | "execution"
  | "waiver"
  | "attention"
  | "comment";

export type SpecHistoryEmphasis = "human" | "policy" | "system";

export interface SpecHistoryEvent {
  id: string;
  kind: SpecHistoryKind;
  emphasis: SpecHistoryEmphasis;
  tone: StatusChipTone;
  label: string;
  detail: string;
  occurredAt: string;
  href: string | null;
  priority: number;
  audit?: {
    actor: ActorProvenance | null;
    operation: string;
    changes: readonly SpecHistoryFieldChange[];
  };
}

interface SpecHistoryFieldChange {
  field: string;
  before: string;
  after: string;
}

type HistoryFilter =
  | "all"
  | "approvals"
  | "admissions"
  | "attention"
  | "gates"
  | "executions";

const FILTERS: ReadonlyArray<{ value: HistoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "approvals", label: "Human approvals" },
  { value: "admissions", label: "Policy admissions" },
  { value: "attention", label: "Attention records" },
  { value: "gates", label: "Gate changes" },
  { value: "executions", label: "Executions" },
];

type AdmissionReviewState = "idle" | "open" | "acknowledged" | "objected";

export default function SpecHistoryPanel({
  detail,
  projectName,
  showHeading = true,
}: {
  detail: SpecDetailView;
  projectName: string;
  showHeading?: boolean;
}): React.JSX.Element {
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [admissionReview, setAdmissionReview] = useState<
    Record<string, AdmissionReviewState>
  >({});
  const events = useMemo(
    () => buildSpecHistory(detail, projectName),
    [detail, projectName],
  );
  const visibleEvents = events.filter((event) => {
    if (filter === "all") return true;
    if (filter === "admissions") return event.kind === "admission";
    if (filter === "attention") return event.kind === "attention";
    if (filter === "executions") return event.kind === "execution";
    if (filter === "gates") return event.kind === "gate";
    // A policy admission is never a human approval, whatever it is admitting.
    // Without this the imported answer and disposition rows list here on their
    // kind alone, and the filter's own name misdescribes them.
    if (event.emphasis === "policy") return false;
    return (
      event.kind === "approval" ||
      event.kind === "waiver" ||
      (event.kind === "revision" && event.emphasis === "human")
    );
  });

  function selectFilter(nextFilter: HistoryFilter): void {
    setFilter(nextFilter);
    logger.info("spec_studio.history.filter_selected", {
      filter: nextFilter,
      specId: detail.spec.id,
    });
  }

  function setAdmissionState(
    admissionId: string,
    state: AdmissionReviewState,
  ): void {
    setAdmissionReview((current) => ({
      ...current,
      [admissionId]: state,
    }));
    logger.info("spec_studio.history.admission_review_updated", {
      admissionId,
      state,
      specId: detail.spec.id,
    });
  }

  return (
    <section
      aria-labelledby={showHeading ? "spec-history-heading" : undefined}
      aria-label={showHeading ? undefined : "Spec history events"}
      className="mx-auto max-w-[1000px]"
    >
      {showHeading && (
        <div className="border-x-0 border-t-0 border-b border-solid border-border-dim pb-md">
          <div>
            <h2
              id="spec-history-heading"
              className="m-0 font-display text-[1rem] font-extrabold text-text-primary"
            >
              History
            </h2>
            <p className="mt-xs mb-0 max-w-[620px] font-mono text-[0.72rem] leading-relaxed text-text-tertiary">
              Human decisions are recorded separately from policy admissions and
              execution lifecycle events.
            </p>
          </div>
        </div>
      )}

      <div
        className={cn(
          "flex flex-wrap items-center gap-sm",
          showHeading && "mt-md",
        )}
      >
        <SegmentedControl
          aria-label="Filter spec history"
          value={filter}
          onValueChange={(value) => selectFilter(value as HistoryFilter)}
          layoutClassName="flex flex-wrap"
        >
          {FILTERS.map((option) => (
            <SegmentedControlItem
              key={option.value}
              value={option.value}
              layoutClassName="min-h-[44px] min-w-[44px]"
            >
              {option.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="ml-auto flex items-center gap-md font-mono text-[0.64rem] text-text-tertiary max-768:ml-0 max-768:w-full">
          <span className="inline-flex items-center gap-xs">
            <span
              aria-hidden="true"
              className="size-[8px] rounded-full bg-green"
            />
            human act
          </span>
          <span className="inline-flex items-center gap-xs">
            <span
              aria-hidden="true"
              className="size-[8px] rounded-full border border-dashed border-border-strong bg-transparent"
            />
            policy admission
          </span>
        </div>
      </div>

      {visibleEvents.length === 0 ? (
        <p className="mt-lg rounded-lg border border-dashed border-border-dim bg-bg-base p-lg font-mono text-[0.72rem] text-text-tertiary">
          No recorded activity matches this filter.
        </p>
      ) : (
        <ol
          aria-label="Spec history"
          className="m-0 mt-md list-none overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-base px-lg py-sm"
        >
          {visibleEvents.map((event) => {
            const heavyweight = isSignoffEvent(event);
            const reviewState = admissionReview[event.id] ?? "idle";
            return (
              <li
                key={event.id}
                className="grid grid-cols-[96px_14px_minmax(0,1fr)] gap-md max-768:grid-cols-[14px_minmax(0,1fr)] max-768:gap-sm"
              >
                <time
                  dateTime={event.occurredAt}
                  className="pt-md text-right font-mono text-[0.64rem] text-text-tertiary tabular-nums max-768:hidden"
                >
                  {formatHistoryTime(event.occurredAt)}
                </time>
                <span
                  aria-hidden="true"
                  className="flex justify-center pt-[14px]"
                >
                  <span
                    className={cn(
                      "size-[8px] rounded-full border",
                      event.emphasis === "policy"
                        ? "border-dashed border-border-strong bg-transparent"
                        : event.emphasis === "human"
                          ? markerClass[event.tone]
                          : "border-dashed border-border-strong bg-transparent",
                    )}
                  />
                </span>
                <article
                  data-tone={event.tone}
                  data-emphasis={event.emphasis}
                  className={cn(
                    "min-w-0 font-mono",
                    heavyweight
                      ? "my-xs rounded-md border border-solid border-green-dim bg-green-glow px-md py-sm"
                      : "border-x-0 border-t-0 border-b border-solid border-border-dim py-sm",
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-sm">
                    <span
                      className={cn(
                        "inline-flex shrink-0 rounded-full border bg-transparent px-sm py-2xs text-[0.56rem] font-bold tracking-[0.06em] uppercase",
                        event.emphasis === "policy"
                          ? "border-dashed border-border-default text-text-tertiary"
                          : kindClass[event.tone],
                      )}
                    >
                      {historyKindLabel(event.kind)}
                    </span>
                    <h3
                      className={cn(
                        "m-0 text-[0.75rem] text-text-primary",
                        event.emphasis === "human"
                          ? "font-semibold"
                          : "font-medium text-text-secondary",
                        heavyweight && "font-bold text-green",
                      )}
                    >
                      {event.label}
                    </h3>
                    {event.href !== null && (
                      <Link
                        href={event.href}
                        className="ml-auto font-mono text-[0.64rem] font-semibold text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
                      >
                        Open subject →
                      </Link>
                    )}
                  </div>
                  <p
                    className={cn(
                      "mt-2xs mb-0 max-w-[760px] text-[0.66rem] leading-relaxed",
                      heavyweight ? "text-text-primary" : "text-text-tertiary",
                    )}
                  >
                    {event.detail}
                  </p>
                  {event.audit !== undefined && (
                    <div className="mt-xs border-x-0 border-t border-b-0 border-solid border-border-dim pt-xs">
                      <SpecActorAttribution
                        action={`${capitalize(event.audit.operation)} by`}
                        actor={event.audit.actor}
                        occurredAt={event.occurredAt}
                      />
                      {event.audit.changes.length > 0 && (
                        <dl
                          aria-label={`${event.label} field changes`}
                          className="mt-xs mb-0 grid gap-xs"
                        >
                          {event.audit.changes.map((change) => (
                            <div
                              key={change.field}
                              className="grid min-w-0 grid-cols-[112px_minmax(0,1fr)_minmax(0,1fr)] gap-sm rounded-sm bg-bg-raised px-sm py-xs max-768:grid-cols-1 max-768:gap-2xs"
                            >
                              <dt className="font-semibold text-text-secondary">
                                {change.field}
                              </dt>
                              <dd className="m-0 min-w-0 break-words whitespace-pre-wrap text-text-tertiary">
                                <span className="sr-only">Before: </span>
                                {change.before}
                              </dd>
                              <dd className="m-0 min-w-0 break-words whitespace-pre-wrap text-text-primary">
                                <span className="sr-only">After: </span>
                                {change.after}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  )}
                  {event.kind === "admission" && (
                    <AdmissionReviewControls
                      state={reviewState}
                      onOpen={() => setAdmissionState(event.id, "open")}
                      onAcknowledge={() =>
                        setAdmissionState(event.id, "acknowledged")
                      }
                      onObject={() => setAdmissionState(event.id, "objected")}
                    />
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-sm mb-0 font-mono text-[0.64rem] leading-relaxed text-text-tertiary">
        append-only — every row deep-links to its subject; objecting to an
        admission opens the comment → amendment loop and never mutates history.
      </p>
    </section>
  );
}

const markerClass: Record<StatusChipTone, string> = {
  neutral: "border-border-strong bg-bg-raised",
  cyan: "border-cyan bg-cyan",
  amber: "border-amber bg-amber",
  green: "border-green bg-green",
  red: "border-red bg-red",
  violet: "border-violet bg-violet",
};

const kindClass: Record<StatusChipTone, string> = {
  neutral: "border-border-default text-text-secondary",
  cyan: "border-cyan text-cyan",
  amber: "border-amber text-amber",
  green: "border-green text-green",
  red: "border-red text-red",
  violet: "border-violet text-violet",
};

function isSignoffEvent(event: SpecHistoryEvent): boolean {
  return event.kind === "revision" && event.label.endsWith("signed off");
}

function AdmissionReviewControls({
  state,
  onOpen,
  onAcknowledge,
  onObject,
}: {
  state: AdmissionReviewState;
  onOpen(): void;
  onAcknowledge(): void;
  onObject(): void;
}): React.JSX.Element {
  if (state === "acknowledged") {
    return (
      <p className="mt-xs mb-0 font-mono text-[0.66rem] text-green">
        ✓ reviewed — acknowledged by you · just now
      </p>
    );
  }
  if (state === "objected") {
    return (
      <p className="mt-xs mb-0 font-mono text-[0.66rem] text-amber">
        Objection recorded — routed to the comment → amendment loop. The
        admission stands; history never mutates.
      </p>
    );
  }
  if (state === "open") {
    return (
      <div className="mt-xs flex flex-wrap items-center gap-sm">
        <span className="font-mono text-[0.64rem] text-text-tertiary">
          post-hoc review — nothing here rewinds the transition:
        </span>
        <Button size="sm" variant="success" onClick={onAcknowledge}>
          Acknowledge
        </Button>
        <Button size="sm" variant="danger" onClick={onObject}>
          Object — request amendment
        </Button>
      </div>
    );
  }
  return (
    <Button size="sm" variant="ghost" layoutClassName="mt-xs" onClick={onOpen}>
      Review admission…
    </Button>
  );
}

export function buildSpecHistory(
  detail: SpecDetailView,
  projectName = projectNameFor(detail),
): SpecHistoryEvent[] {
  const handles = elementHandles(detail.currentRevision);
  // Read from the admissions rather than the import event: the event carries
  // the import's detail and goes null when that detail is unreadable, but the
  // provenance itself must never go with it.
  const imported = importProvenance(detail.gateAdmissions);
  const events: SpecHistoryEvent[] = [
    {
      id: `${detail.spec.id}:created`,
      kind: "spec",
      emphasis: "system",
      tone: "neutral",
      label: "Spec created",
      detail: `${detail.spec.slug} received its durable identity.`,
      occurredAt: detail.spec.createdAt,
      href: null,
      priority: 5,
    },
  ];

  if (detail.importRecord !== null) {
    events.push({
      id: `${detail.spec.id}:imported`,
      kind: "spec",
      emphasis: "system",
      tone: "neutral",
      label: "Spec imported",
      detail: `Imported from ${detail.importRecord.sourceLabel} — ${importedContentSummary(
        detail.importRecord.counts,
      )}. Imported content is not human-approved here.`,
      occurredAt: detail.importRecord.occurredAt,
      href: null,
      // Above the admissions and the revision rows it commits alongside: an
      // import writes them all in one transaction, so at an identical
      // timestamp the row that explains the rest reads first.
      priority: 65,
    });
  }

  if (detail.spec.abandonedAt !== null) {
    events.push({
      id: `${detail.spec.id}:abandoned`,
      kind: "spec",
      emphasis: "system",
      tone: "red",
      label: "Spec abandoned",
      detail: detail.spec.abandonedReason ?? "The spec became read-only.",
      occurredAt: detail.spec.abandonedAt,
      href: null,
      priority: 70,
    });
  }

  for (const revision of detail.revisions) {
    const revisionLabel = `Revision ${revision.number}`;
    if (revision.state === "approved" && revision.approvedAt !== null) {
      // The imported revision is born approved on its source document's word.
      // A filled marker reads as a human act in this feed's own legend, and the
      // "Human approvals" filter selects on exactly that emphasis, so a
      // sign-off row here would hand the import a human decision it never got.
      const admittedByImport = revision.id === imported?.revisionId;
      events.push({
        id: `${revision.id}:${admittedByImport ? "import-admitted" : "signed-off"}`,
        kind: "revision",
        emphasis: admittedByImport ? "policy" : "human",
        tone: admittedByImport ? "neutral" : "green",
        label: admittedByImport
          ? `${revisionLabel} admitted by import`
          : `${revisionLabel} signed off`,
        detail: admittedByImport
          ? "Admitted on the imported source's word — no human signed this revision off."
          : "The approved revision is immutable and can anchor execution scope.",
        occurredAt: revision.approvedAt,
        href: null,
        priority: 30,
      });
      events.push({
        id: `${revision.id}:created`,
        kind: "revision",
        emphasis: "system",
        tone: "neutral",
        label: `${revisionLabel} created`,
        detail: "Revision content was captured as a durable snapshot.",
        occurredAt: revision.createdAt,
        href: null,
        priority: 10,
      });
      continue;
    }

    if (revision.proposedAt !== null) {
      events.push({
        id: `${revision.id}:proposed`,
        kind: "revision",
        emphasis: "system",
        tone: "amber",
        label: `${revisionLabel} proposed`,
        detail: "The revision entered semantic review.",
        occurredAt: revision.proposedAt,
        // History is where a reader meets a proposal they cannot see anywhere
        // else, so the row is the way back to the surface that can act on it
        // (#50) — not a dead line of text. Only while it is still live: Review
        // selects out of the live-proposals projection, so a row linked after
        // the proposal was dismissed or sent back would land on a different
        // proposal or on an empty tab. A link that lies is the #50 shape
        // again, so an ended proposal keeps its row and loses its link.
        href: detail.liveProposals.some(
          (entry) => entry.revision.id === revision.id,
        )
          ? reviewHref(
              projectName,
              detail.spec.slug,
              revision.id,
              revision.authoringStage,
            )
          : null,
        priority: 20,
      });
      continue;
    }

    events.push({
      id: `${revision.id}:created`,
      kind: "revision",
      emphasis: "system",
      tone: "neutral",
      label: `${revisionLabel} created`,
      detail: "Revision content was captured as a durable snapshot.",
      occurredAt: revision.createdAt,
      href: null,
      priority: 10,
    });
  }

  for (const approval of detail.approvals) {
    const subject =
      approval.element_id === null
        ? "Plan"
        : (handles.get(approval.element_id) ?? approval.subject_kind);
    events.push({
      id: approval.id,
      kind: "approval",
      emphasis: "human",
      tone: approval.validity === "valid" ? "green" : "amber",
      label: `${subject} approved`,
      detail: `${approval.approver} recorded an explicit ${approval.subject_kind} approval.`,
      occurredAt: approval.granted_at,
      href: elementHref(projectName, detail.spec.slug, subject),
      priority: 50,
    });
  }

  for (const admission of detail.gateAdmissions) {
    const gate = gateLabel(admission.gate);
    events.push({
      id: admission.id,
      kind: "admission",
      emphasis: "policy",
      // Import shares Notify's attention tone: a gate crossed on an external
      // document's word is something to review, not a settled approval.
      tone:
        admission.basis === "notify_policy" || admission.basis === "import"
          ? "amber"
          : "green",
      label: `${gate} admitted by ${admissionBasisLabel(admission.basis)}`,
      detail:
        "This policy admission is not a human approval and remains auditable.",
      occurredAt: admission.createdAt,
      href: null,
      priority: 40,
    });
  }

  for (const execution of detail.executions) {
    const presentation = executionHistoryPresentation(execution.state);
    events.push({
      id: execution.id,
      kind: "execution",
      emphasis: "system",
      tone: presentation.tone,
      label: presentation.label,
      detail:
        execution.sessionName === null
          ? `Execution ${execution.id}`
          : `Session ${execution.sessionName}`,
      occurredAt: execution.deliveredAt ?? execution.createdAt,
      href: null,
      priority: 35,
    });
  }

  for (const waiver of detail.waivers) {
    const subject = handles.get(waiver.criterion_element_id) ?? "Criterion";
    events.push({
      id: waiver.id,
      kind: "waiver",
      emphasis: "human",
      tone: waiver.stale === 0 ? "amber" : "neutral",
      label: `${subject} waived`,
      detail: waiver.reason,
      occurredAt: waiver.waived_at,
      href: elementHref(projectName, detail.spec.slug, subject),
      priority: 60,
    });
  }

  for (const attentionEvent of detail.attentionAuditEvents ?? []) {
    events.push(attentionHistoryEvent(attentionEvent, detail, projectName));
  }

  for (const comment of detail.comments) {
    const subject = handles.get(comment.elementId) ?? "Element";
    events.push({
      id: comment.id,
      kind: "comment",
      emphasis: "human",
      tone:
        comment.blocking && comment.resolution === "open" ? "amber" : "neutral",
      label: `${subject} comment recorded`,
      detail:
        comment.resolution === "open"
          ? "Review thread remains open."
          : "Review thread resolved.",
      occurredAt: comment.createdAt,
      href: elementHref(projectName, detail.spec.slug, subject),
      priority: 45,
    });
  }

  return events.toSorted((left, right) => {
    const timeOrder = right.occurredAt.localeCompare(left.occurredAt);
    if (timeOrder !== 0) return timeOrder;
    if (right.priority !== left.priority) return right.priority - left.priority;
    return left.id.localeCompare(right.id);
  });
}

type AttentionAuditEvent = SpecDetailView["attentionAuditEvents"][number];

function attentionHistoryEvent(
  event: AttentionAuditEvent,
  detail: SpecDetailView,
  projectName: string,
): SpecHistoryEvent {
  if (event.kind === "record") {
    const handle = `${event.payload.recordKind === "question" ? "Q" : "A"}${event.payload.recordNumber}`;
    const operationLabel = recordOperationLabel(event);
    const changes = recordFieldChanges(event, detail);
    return {
      id: `attention:${event.eventId}`,
      kind: "attention",
      emphasis:
        event.payload.operation === "imported"
          ? "policy"
          : event.actor?.kind === "human"
            ? "human"
            : "system",
      tone: recordOperationTone(event),
      label: `${handle} ${operationLabel}`,
      detail:
        event.payload.reason ??
        `${capitalize(event.payload.operation)} recorded ${changes.length} changed ${changes.length === 1 ? "field" : "fields"}.`,
      occurredAt: event.occurredAt,
      href: attentionHref(projectName, detail.spec.slug, handle),
      priority: 55,
      audit: {
        actor: event.actor,
        operation: event.payload.operation,
        changes,
      },
    };
  }

  const changedHandles = citationAssumptionHandles(event);
  const revision = detail.revisions.find(
    (candidate) => candidate.id === event.payload.revisionId,
  );
  const subject =
    changedHandles.length === 0
      ? revision === undefined
        ? "Revision"
        : `Revision ${revision.number}`
      : changedHandles.join(", ");
  return {
    id: `attention:${event.eventId}`,
    kind: "attention",
    emphasis: event.actor?.kind === "human" ? "human" : "system",
    tone: "cyan",
    label: `${subject} citations updated`,
    detail: "The draft revision's pinned assumption citation set changed.",
    occurredAt: event.occurredAt,
    href:
      changedHandles[0] === undefined
        ? reviewHref(
            projectName,
            detail.spec.slug,
            event.payload.revisionId,
            revision?.authoringStage,
          )
        : attentionHref(projectName, detail.spec.slug, changedHandles[0]),
    priority: 54,
    audit: {
      actor: event.actor,
      operation: "citations updated",
      changes: citationFieldChanges(event, detail),
    },
  };
}

function recordOperationLabel(
  event: Extract<AttentionAuditEvent, { kind: "record" }>,
): string {
  if (event.payload.operation === "imported") {
    if (
      event.payload.after.kind === "question" &&
      event.payload.after.status === "answered"
    ) {
      return "answered at import";
    }
    if (
      event.payload.after.kind === "assumption" &&
      event.payload.after.disposition !== "proposed"
    ) {
      return `${event.payload.after.disposition} at import`;
    }
  }
  if (
    event.payload.operation === "disposed" &&
    event.payload.after.kind === "assumption"
  ) {
    return event.payload.after.disposition;
  }
  return event.payload.operation;
}

function recordOperationTone(
  event: Extract<AttentionAuditEvent, { kind: "record" }>,
): StatusChipTone {
  if (event.payload.operation === "imported") return "neutral";
  if (event.payload.operation === "answered") return "green";
  if (
    event.payload.operation === "disposed" &&
    event.payload.after.kind === "assumption"
  ) {
    if (event.payload.after.disposition === "confirmed") return "green";
    if (event.payload.after.disposition === "rejected") return "red";
    return "amber";
  }
  if (
    event.payload.operation === "withdrawn" ||
    event.payload.operation === "superseded"
  ) {
    return "amber";
  }
  if (event.payload.operation === "edited") return "cyan";
  return "neutral";
}

function recordFieldChanges(
  event: Extract<AttentionAuditEvent, { kind: "record" }>,
  detail: SpecDetailView,
): SpecHistoryFieldChange[] {
  const before = event.payload.before;
  const after = event.payload.after;
  const changes: SpecHistoryFieldChange[] = [];
  const add = (field: string, beforeValue: unknown, afterValue: unknown) => {
    const previous = historyFieldValue(beforeValue);
    const next = historyFieldValue(afterValue);
    if (before !== null && previous === next) return;
    if (before === null && next === "—" && field !== "Record version") return;
    changes.push({ field, before: previous, after: next });
  };
  const attachment = (elementId: string | null | undefined): string => {
    if (elementId === null || elementId === undefined) return "Spec";
    return elementHandles(detail.currentRevision).get(elementId) ?? elementId;
  };

  add("Text", before?.text, after.text);
  add(
    "Attachment",
    before === null ? undefined : attachment(before.elementId),
    attachment(after.elementId),
  );
  add("Record version", before?.recordVersion, after.recordVersion);
  if (after.kind === "question") {
    add(
      "Status",
      before?.kind === "question" ? before.status : undefined,
      after.status,
    );
    add(
      "Answer",
      before?.kind === "question" ? before.answer : undefined,
      after.answer,
    );
    add(
      "Answered at",
      before?.kind === "question" ? before.answeredAt : undefined,
      after.answeredAt,
    );
    add(
      "Withdrawn at",
      before?.kind === "question" ? before.withdrawnAt : undefined,
      after.withdrawnAt,
    );
    return changes;
  }

  add(
    "Disposition",
    before?.kind === "assumption" ? before.disposition : undefined,
    after.disposition,
  );
  add(
    "Disposed at",
    before?.kind === "assumption" ? before.disposedAt : undefined,
    after.disposedAt,
  );
  add(
    "Withdrawn at",
    before?.kind === "assumption" ? before.withdrawnAt : undefined,
    after.withdrawnAt,
  );
  add(
    "Supersedes",
    assumptionHandleForId(
      detail,
      before?.kind === "assumption" ? before.supersedesAssumptionId : undefined,
    ),
    assumptionHandleForId(detail, after.supersedesAssumptionId),
  );
  add(
    "Superseded by",
    assumptionHandleForId(
      detail,
      before?.kind === "assumption"
        ? before.supersededByAssumptionId
        : undefined,
    ),
    assumptionHandleForId(detail, after.supersededByAssumptionId),
  );
  return changes;
}

function citationFieldChanges(
  event: Extract<AttentionAuditEvent, { kind: "citations" }>,
  detail: SpecDetailView,
): SpecHistoryFieldChange[] {
  const payload = event.payload;
  const changes: SpecHistoryFieldChange[] = [
    {
      field: "Citation version",
      before: String(payload.beforeCitationVersion),
      after: String(payload.afterCitationVersion),
    },
    {
      field: "Citation hash",
      before: shortHash(payload.beforeCitationHash),
      after: shortHash(payload.afterCitationHash),
    },
  ];
  if (payload.added.length > 0) {
    changes.push({
      field: "Added",
      before: "—",
      after: payload.added
        .map((entry) => citationEntryLabel(entry, detail))
        .join(", "),
    });
  }
  if (payload.removed.length > 0) {
    changes.push({
      field: "Removed",
      before: payload.removed
        .map((entry) => citationEntryLabel(entry, detail))
        .join(", "),
      after: "—",
    });
  }
  if (payload.refreshed.length > 0) {
    changes.push({
      field: "Refreshed",
      before: payload.refreshed
        .map(
          (entry) =>
            `${citationSubjectLabel(entry.elementId, entry.beforeSnapshot.number, detail)} v${entry.beforeSnapshot.recordVersion}`,
        )
        .join(", "),
      after: payload.refreshed
        .map(
          (entry) =>
            `${citationSubjectLabel(entry.elementId, entry.afterSnapshot.number, detail)} v${entry.afterSnapshot.recordVersion}`,
        )
        .join(", "),
    });
  }
  return changes;
}

function citationAssumptionHandles(
  event: Extract<AttentionAuditEvent, { kind: "citations" }>,
): string[] {
  return [
    ...event.payload.added.map((entry) => entry.snapshot.number),
    ...event.payload.removed.map((entry) => entry.snapshot.number),
    ...event.payload.refreshed.map((entry) => entry.afterSnapshot.number),
  ]
    .filter((number, index, numbers) => numbers.indexOf(number) === index)
    .sort((left, right) => left - right)
    .map((number) => `A${number}`);
}

function citationEntryLabel(
  entry: Extract<
    AttentionAuditEvent,
    { kind: "citations" }
  >["payload"]["added"][number],
  detail: SpecDetailView,
): string {
  return citationSubjectLabel(entry.elementId, entry.snapshot.number, detail);
}

function citationSubjectLabel(
  elementId: string,
  assumptionNumber: number,
  detail: SpecDetailView,
): string {
  const element =
    elementHandles(detail.currentRevision).get(elementId) ?? elementId;
  return `${element} → A${assumptionNumber}`;
}

function assumptionHandleForId(
  detail: SpecDetailView,
  assumptionId: string | null | undefined,
): string | undefined {
  if (assumptionId === null || assumptionId === undefined) return undefined;
  return (
    detail.assumptions.find((assumption) => assumption.id === assumptionId)
      ?.handle ?? assumptionId
  );
}

function historyFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function attentionHref(
  projectName: string,
  slug: string,
  handle: string,
): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=requirements&el=${encodeURIComponent(handle)}`;
}

/**
 * What the import brought in, naming only the kinds it actually carried: a
 * summary that listed every kind at zero would read as a report about content
 * the bundle never claimed.
 */
function importedContentSummary(
  counts: SpecImportRecordView["counts"],
): string {
  const parts = [
    pluralize(counts.sections, "section"),
    pluralize(counts.requirements, "requirement"),
    pluralize(counts.criteria, "criterion", "criteria"),
    pluralize(counts.decisions, "decision"),
    pluralize(counts.questions, "question"),
    pluralize(counts.assumptions, "assumption"),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "no content" : parts.join(", ");
}

function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

function elementHandles(
  snapshot: SpecRevisionSnapshot | null,
): Map<string, string> {
  const handles = new Map<string, string>();
  if (snapshot === null) return handles;
  const requirementHandles = new Map<string, string>();
  for (const entry of snapshot.elements) {
    if (entry.element.number === null) continue;
    const payload = entry.version.payload;
    if (payload.kind === "requirement") {
      const handle = `R${entry.element.number}`;
      handles.set(entry.element.id, handle);
      requirementHandles.set(entry.element.id, handle);
    } else if (payload.kind === "decision") {
      handles.set(entry.element.id, `D${entry.element.number}`);
    } else if (payload.kind === "task") {
      handles.set(entry.element.id, `T${entry.element.number}`);
    }
  }
  for (const entry of snapshot.elements) {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      continue;
    }
    const parent = requirementHandles.get(entry.element.parentElementId);
    if (parent !== undefined) {
      handles.set(entry.element.id, `${parent}.${entry.element.number}`);
    }
  }
  return handles;
}

function executionHistoryPresentation(
  state: SpecDetailView["executions"][number]["state"],
): {
  label: string;
  tone: StatusChipTone;
} {
  switch (state) {
    case "definition_review":
      return { label: "Execution definition proposed", tone: "amber" };
    case "running":
      return { label: "Execution started", tone: "cyan" };
    case "delivered":
      return { label: "Execution delivered", tone: "green" };
    case "abandoned":
      return { label: "Execution abandoned", tone: "red" };
    case "abandoning":
      // Amber, not red: cleanup is in flight and may still be waiting on the
      // linked workflow, so this is an attention state rather than a settled one.
      return { label: "Execution abandonment in progress", tone: "amber" };
  }
}

function historyKindLabel(kind: SpecHistoryKind): string {
  switch (kind) {
    case "spec":
      return "Spec";
    case "revision":
      return "Revision";
    case "approval":
      return "Human approval";
    case "admission":
      return "Policy admission";
    case "gate":
      return "Gate change";
    case "execution":
      return "Execution";
    case "waiver":
      return "Waiver";
    case "attention":
      return "Attention record";
    case "comment":
      return "Review";
  }
}

function gateLabel(
  gate: SpecDetailView["gateAdmissions"][number]["gate"],
): string {
  if (gate === "execution_start") return "Execution start";
  return `${gate.slice(0, 1).toUpperCase()}${gate.slice(1)}`;
}

function admissionBasisLabel(
  basis: SpecDetailView["gateAdmissions"][number]["basis"],
): string {
  switch (basis) {
    case "notify_policy":
      return "notify policy";
    case "off_policy":
      return "off policy";
    case "human_approval":
      return "human approval";
    case "import":
      return "import provenance";
  }
}

function projectNameFor(detail: SpecDetailView): string {
  return detail.spec.projectPath.split("/").filter(Boolean).at(-1) ?? "project";
}

/** The Review entry for one revision — the surface that can act on it. */
function reviewHref(
  projectName: string,
  slug: string,
  revisionId: string,
  authoringStage:
    | SpecDetailView["revisions"][number]["authoringStage"]
    | undefined,
): string | null {
  if (authoringStage === undefined || authoringStage === "plan") return null;
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=${authoringStage}&revision=${encodeURIComponent(revisionId)}`;
}

function elementHref(
  projectName: string,
  slug: string,
  handle: string,
): string | null {
  if (!/^(?:R\d+(?:\.\d+)?|D\d+|T\d+|Q\d+|A\d+)$/.test(handle)) return null;
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?el=${encodeURIComponent(handle)}`;
}

function formatHistoryTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
