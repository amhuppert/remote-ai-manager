"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/Button";
import type { StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecRevisionSnapshot } from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

const logger = createClientLogger("spec-studio-history");

export type SpecHistoryKind =
  | "spec"
  | "revision"
  | "approval"
  | "admission"
  | "gate"
  | "execution"
  | "waiver"
  | "question"
  | "assumption"
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
}

type HistoryFilter =
  | "all"
  | "approvals"
  | "admissions"
  | "gates"
  | "executions";

const FILTERS: ReadonlyArray<{ value: HistoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "approvals", label: "Human approvals" },
  { value: "admissions", label: "Policy admissions" },
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
    if (filter === "executions") return event.kind === "execution";
    if (filter === "gates") return event.kind === "gate";
    return (
      event.kind === "approval" ||
      event.kind === "waiver" ||
      event.kind === "question" ||
      event.kind === "assumption" ||
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
        <div
          role="radiogroup"
          aria-label="Filter spec history"
          className="flex flex-wrap items-center gap-xs"
        >
          {FILTERS.map((option) => {
            const selected = filter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  "inline-flex h-[22px] cursor-pointer items-center rounded-full border border-solid px-sm font-mono text-[0.66rem] font-semibold transition-colors duration-150 focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
                  selected
                    ? "border-cyan-glow-strong bg-cyan-glow text-cyan"
                    : "border-border-default bg-transparent text-text-secondary hover:border-border-strong hover:text-text-primary",
                )}
                onClick={() => selectFilter(option.value)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
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
      events.push({
        id: `${revision.id}:signed-off`,
        kind: "revision",
        emphasis: "human",
        tone: "green",
        label: `${revisionLabel} signed off`,
        detail:
          "The approved revision is immutable and can anchor execution scope.",
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
          ? reviewHref(projectName, detail.spec.slug, revision.id)
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
      tone: admission.basis === "notify_policy" ? "amber" : "green",
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

  for (const question of detail.questions) {
    events.push({
      id: `${question.id}:created`,
      kind: "question",
      emphasis: "system",
      tone: "neutral",
      label: `${question.handle} opened`,
      detail: "A durable question was attached to the spec.",
      occurredAt: question.createdAt,
      href: elementHref(projectName, detail.spec.slug, question.handle),
      priority: 15,
    });
    if (question.answeredAt !== null) {
      events.push({
        id: `${question.id}:answered`,
        kind: "question",
        emphasis: "human",
        tone: "green",
        label: `${question.handle} answered`,
        detail: "The question received an explicit answer.",
        occurredAt: question.answeredAt,
        href: elementHref(projectName, detail.spec.slug, question.handle),
        priority: 55,
      });
    }
  }

  for (const assumption of detail.assumptions) {
    events.push({
      id: `${assumption.id}:created`,
      kind: "assumption",
      emphasis: "system",
      tone: "neutral",
      label: `${assumption.handle} proposed`,
      detail: "An assumption was recorded for explicit disposition.",
      occurredAt: assumption.createdAt,
      href: elementHref(projectName, detail.spec.slug, assumption.handle),
      priority: 15,
    });
    if (
      assumption.disposedAt !== null &&
      assumption.disposition !== "proposed"
    ) {
      events.push({
        id: `${assumption.id}:disposed`,
        kind: "assumption",
        emphasis: "human",
        tone: assumption.disposition === "confirmed" ? "green" : "red",
        label: `${assumption.handle} ${assumption.disposition}`,
        detail: "A human disposition was recorded against the assumption.",
        occurredAt: assumption.disposedAt,
        href: elementHref(projectName, detail.spec.slug, assumption.handle),
        priority: 55,
      });
    }
  }

  for (const comment of detail.comments) {
    const subject = handles.get(comment.element_id) ?? "Element";
    events.push({
      id: comment.id,
      kind: "comment",
      emphasis: "human",
      tone:
        comment.blocking === 1 && comment.resolution === "open"
          ? "amber"
          : "neutral",
      label: `${subject} comment recorded`,
      detail:
        comment.resolution === "open"
          ? "Review thread remains open."
          : "Review thread resolved.",
      occurredAt: comment.created_at,
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
    case "question":
      return "Question";
    case "assumption":
      return "Assumption";
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
): string {
  return `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=review&revision=${encodeURIComponent(revisionId)}`;
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
