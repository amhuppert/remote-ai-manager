"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { HoverCard } from "radix-ui";
import type { StatusChipTone } from "@/components/ui/StatusChip";
import {
  buildSpecReadCommand,
  buildSpecSectionReadCommand,
  type SpecElementMentionAttrs,
  type SpecElementRefAttrs,
  type SpecMentionAttrs,
  type SpecRefAttrs,
  type SpecSectionMentionAttrs,
  type SpecSectionRefAttrs,
} from "@/lib/prompt-editor/spec-reference-contract";
import {
  useSpecElementQuery,
  useSpecSummaryQuery,
} from "@/lib/specs/reference-queries";
import type { SpecPhaseProjection } from "@/lib/specs/phase-view-schemas";
import type {
  SpecElementGetResponse,
  SpecElementReferenceState,
  SpecSummaryView,
} from "@/lib/specs/reference-view-schemas";
import { cn } from "@/lib/ui/cn";

interface QueryShape<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

export interface SpecRefChipDeps {
  useSpecSummary(
    projectName: string,
    slug: string,
  ): QueryShape<SpecSummaryView>;
  useSpecElement(
    projectName: string,
    slug: string,
    handle: string,
    observedRevision: number,
  ): QueryShape<SpecElementGetResponse>;
}

const referenceChipBase =
  "inline-flex items-center gap-[5px] rounded-full border border-solid px-sm py-2xs align-middle font-mono text-[0.7rem] leading-[1.4] no-underline transition-[border-color,background,box-shadow] duration-150 ease-[ease] hover:shadow-[0_0_0_2px_var(--cyan-glow)] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";
const specReferenceChipClass =
  "border-[var(--cc-cyan-a25)] bg-cyan-glow text-cyan hover:border-cyan-dim hover:bg-bg-hover";
const elementReferenceChipClass =
  "border-border-default bg-bg-raised text-text-secondary hover:border-border-strong hover:bg-bg-hover";
export function specStudioHref(
  projectName: string,
  slug: string,
  handle?: string,
): string {
  const base = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
  if (!handle) return base;
  return `${base}?${new URLSearchParams({ el: handle }).toString()}`;
}

export function isSpecElementReferenceStale(
  state: SpecElementReferenceState | null,
): boolean {
  return (
    state !== null && state.observedPayloadHash !== state.latestPayloadHash
  );
}

export function createSpecRefChips(deps: SpecRefChipDeps) {
  function SpecRefTranscriptChip({
    attrs,
  }: {
    attrs: SpecRefAttrs;
  }): React.JSX.Element {
    const projectName = attrs["project-name"];
    const query = deps.useSpecSummary(projectName, attrs.slug);
    const summary = query.data;
    const name = summary?.spec.name || attrs.name;
    const phase = summary
      ? formatSpecPhase(summary.phase)
      : query.isError
        ? "Unavailable"
        : "Loading";
    const tone = summary ? specPhaseTone(summary.phase.primary) : "neutral";

    return (
      <HoverCard.Root openDelay={100} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <Link
            href={specStudioHref(projectName, attrs.slug)}
            className={cn(referenceChipBase, specReferenceChipClass)}
            aria-label={`${name} ${phase}`}
            data-spec-ref-chip=""
          >
            <SpecGlyph />
            <span className="font-semibold text-cyan">{attrs.slug}</span>
            <ReferenceStatusLabel label={phase} tone={tone} density="chip" />
          </Link>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            sideOffset={6}
            collisionPadding={8}
            aria-label="Spec summary"
            className="z-popover w-[320px] max-w-[calc(100vw-16px)] rounded-lg border border-solid border-border-default bg-bg-elevated p-md text-text-primary shadow-lg"
          >
            <div className="flex items-start justify-between gap-md">
              <div className="min-w-0 truncate font-mono text-[0.78rem] font-semibold">
                {name}
              </div>
              <ReferenceStatusLabel label={phase} tone={tone} density="peek" />
            </div>
            {summary ? (
              <SpecPeekSummary summary={summary} projectName={projectName} />
            ) : (
              <div className="mt-md font-mono text-[0.7rem] text-text-tertiary">
                {query.isError
                  ? "Live spec state is unavailable."
                  : "Loading live spec state…"}
              </div>
            )}
            <HoverCard.Arrow className="fill-border-default" />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    );
  }

  function SpecElementRefTranscriptChip({
    attrs,
  }: {
    attrs: SpecElementRefAttrs;
  }): React.JSX.Element {
    const observedRevision = Number.parseInt(attrs.revision, 10);
    const query = deps.useSpecElement(
      attrs["project-name"],
      attrs.slug,
      attrs.handle,
      observedRevision,
    );
    const statement = query.data ? elementDisplayName(query.data) : attrs.name;
    // Q/A records are not revision-scoped, so they carry no reference state
    // and the stale indicator degrades to "never stale".
    const referenceState =
      query.data !== undefined && "referenceState" in query.data
        ? query.data.referenceState
        : null;
    const stale = isSpecElementReferenceStale(referenceState);
    const address = `${attrs.slug}/${attrs.handle}`;
    const href = specStudioHref(
      attrs["project-name"],
      attrs.slug,
      attrs.handle,
    );
    const approval = elementApprovalState(query.data);

    return (
      <HoverCard.Root openDelay={100} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <Link
            href={href}
            className={cn(referenceChipBase, elementReferenceChipClass)}
            aria-label={`${address} ${statement}${stale ? " Changed" : ""}`}
            title={statement}
            data-spec-element-ref-chip=""
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-[5px] shrink-0 rounded-full",
                stale
                  ? "bg-amber shadow-[0_0_4px_var(--amber-glow)]"
                  : "bg-text-tertiary",
              )}
            />
            <span className="font-semibold text-text-primary">
              {attrs.handle}
            </span>
            <span className="max-w-[180px] truncate text-text-secondary">
              {statement}
            </span>
          </Link>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            sideOffset={6}
            collisionPadding={8}
            aria-label="Spec element summary"
            className="z-popover w-[340px] max-w-[calc(100vw-16px)] rounded-lg border border-solid border-border-default bg-bg-elevated p-md text-text-primary shadow-lg"
          >
            <div className="flex items-start justify-between gap-md">
              <span className="min-w-0 truncate font-mono text-[0.74rem] font-semibold text-text-primary">
                {address}
              </span>
              {approval !== null && (
                <ReferenceStatusLabel
                  label={approval.label}
                  tone={approval.tone}
                  density="peek"
                  stale={approval.tone === "amber"}
                />
              )}
            </div>
            <div className="mt-xs font-mono text-[0.74rem] leading-[1.5] text-text-secondary">
              {statement}
            </div>
            {referenceState !== null && (
              <div className="mt-sm font-mono text-[0.7rem]">
                <div className="flex flex-wrap items-center gap-[6px]">
                  <span className="text-text-tertiary">
                    rev {referenceState.observedRevision} observed
                  </span>
                  <RevisionArrowIcon stale={stale} />
                  <span
                    className={stale ? "text-amber" : "text-text-secondary"}
                  >
                    rev {referenceState.latestContainingRevision} current —{" "}
                    {stale
                      ? "changed since referenced"
                      : "unchanged since referenced"}
                  </span>
                </div>
              </div>
            )}
            <div className="mt-sm flex justify-end">
              <Link
                href={href}
                className="font-mono text-[0.7rem] text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                open in Spec Studio <ExternalLinkIcon />
              </Link>
            </div>
            <HoverCard.Arrow className="fill-border-default" />
          </HoverCard.Content>
        </HoverCard.Portal>
      </HoverCard.Root>
    );
  }

  /**
   * A prose section's chip. Sections carry no handle, so none of the live
   * element reads — all addressed by `<slug>/<handle>` — resolve one: the chip
   * renders the title and revision the reference captured, and the deep link
   * lands on the spec page where the revision's prose sections are rendered.
   */
  function SpecSectionRefTranscriptChip({
    attrs,
  }: {
    attrs: SpecSectionRefAttrs;
  }): React.JSX.Element {
    const title = attrs.name || attrs["element-id"];
    return (
      <Link
        href={specStudioHref(attrs["project-name"], attrs.slug)}
        className={cn(referenceChipBase, elementReferenceChipClass)}
        aria-label={`${attrs.slug} section ${title} revision ${attrs.revision}`}
        title={title}
        data-spec-section-ref-chip=""
      >
        <SectionGlyph />
        <span className="font-semibold text-text-primary">{attrs.slug}</span>
        <span className="max-w-[180px] truncate text-text-secondary">
          {title}
        </span>
        <span className="shrink-0 text-text-tertiary">
          rev {attrs.revision}
        </span>
      </Link>
    );
  }

  function SpecRefEditorChip(
    props: ReactNodeViewProps<HTMLElement>,
  ): React.JSX.Element {
    const { node, selected, deleteNode } = props;
    const normalized = normalizeEditorAttrs(node.attrs);
    const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      deleteNode();
    };

    return (
      <NodeViewWrapper
        as="span"
        className="inline-flex items-center gap-[2px] rounded-md data-[selected=true]:shadow-[0_0_0_2px_var(--cyan-glow)]"
        data-selected={selected ? "true" : "false"}
        contentEditable={false}
      >
        {"handle" in normalized ? (
          <SpecElementRefTranscriptChip
            attrs={elementMentionToWireAttrs(normalized)}
          />
        ) : "elementId" in normalized ? (
          <SpecSectionRefTranscriptChip
            attrs={sectionMentionToWireAttrs(normalized)}
          />
        ) : (
          <SpecRefTranscriptChip attrs={specMentionToWireAttrs(normalized)} />
        )}
        <button
          type="button"
          className="h-[16px] w-[16px] cursor-pointer rounded-[3px] border-0 bg-transparent p-0 text-[12px] leading-none text-text-tertiary hover:bg-red-glow hover:text-red-text"
          onClick={handleRemove}
          onMouseDown={(event) => event.preventDefault()}
          aria-label={`Remove spec reference ${normalized.slug}`}
        >
          &times;
        </button>
      </NodeViewWrapper>
    );
  }

  return {
    SpecRefEditorChip,
    SpecRefTranscriptChip,
    SpecElementRefTranscriptChip,
    SpecSectionRefTranscriptChip,
  };
}

function SpecPeekSummary({
  summary,
  projectName,
}: {
  summary: SpecSummaryView;
  projectName: string;
}): React.JSX.Element {
  const revision = summary.currentRevision;
  const preset = formatPreset(summary.spec.gatePolicy.preset);
  const approvalTotal =
    summary.counts.requirements +
    summary.counts.decisions +
    (revision === null ? 0 : 1);
  const approvedCount = Math.max(
    0,
    approvalTotal - summary.pendingApprovalCount,
  );
  const progress =
    approvalTotal === 0 ? 0 : Math.round((approvedCount / approvalTotal) * 100);
  const revisionCopy =
    revision === null
      ? "no revision"
      : "rev " + revision.number + " " + revision.state.replaceAll("_", " ");
  return (
    <div className="font-mono text-[0.7rem] text-text-secondary">
      <div className="mt-[1px] text-[0.68rem] text-text-tertiary">
        {summary.spec.slug} · {revisionCopy} · {preset}
      </div>
      <div className="mt-[9px] flex flex-wrap gap-[14px]">
        <span aria-label={summary.counts.requirements + " req"}>
          <strong className="text-text-primary">
            {summary.counts.requirements}
          </strong>{" "}
          req
        </span>
        <span aria-label={summary.counts.decisions + " dec"}>
          <strong className="text-text-primary">
            {summary.counts.decisions}
          </strong>{" "}
          dec
        </span>
        <span aria-label={summary.counts.tasks + " tasks"}>
          <strong className="text-text-primary">{summary.counts.tasks}</strong>{" "}
          tasks
        </span>
        <span aria-label={approvedCount + "/" + approvalTotal + " approvals"}>
          <strong
            className={
              summary.pendingApprovalCount > 0 ? "text-amber" : "text-green"
            }
          >
            {approvedCount}/{approvalTotal}
          </strong>{" "}
          approvals
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={approvedCount + " of " + approvalTotal + " approvals"}
        aria-valuemin={0}
        aria-valuemax={approvalTotal}
        aria-valuenow={approvedCount}
        className="mt-sm h-[3px] overflow-hidden rounded-[2px] bg-bg-raised"
      >
        <div
          className={cn(
            "h-full rounded-[2px]",
            summary.pendingApprovalCount > 0
              ? "bg-amber shadow-[0_0_6px_var(--amber-glow)]"
              : "bg-green shadow-[0_0_6px_var(--green-glow)]",
          )}
          style={{ width: String(progress) + "%" }}
        />
      </div>
      <span className="sr-only">
        {summary.counts.requirements} requirements
      </span>
      <span className="sr-only">
        {summary.counts.criteria} acceptance criteria
      </span>
      <span className="sr-only">
        {summary.pendingApprovalCount > 0
          ? summary.pendingApprovalCount + " approvals pending"
          : "Approval complete"}
      </span>
      <div className="mt-[9px] flex justify-end">
        <Link
          href={specStudioHref(projectName, summary.spec.slug)}
          className="text-cyan-dim no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          open in Spec Studio <ExternalLinkIcon />
        </Link>
      </div>
    </div>
  );
}

function formatPreset(preset: string): string {
  return preset.charAt(0).toUpperCase() + preset.slice(1);
}

function elementApprovalState(
  view: SpecElementGetResponse | undefined,
): { label: string; tone: StatusChipTone } | null {
  if (view === undefined || !("approvals" in view)) return null;
  const approval = view.approvals.at(-1);
  if (approval === undefined) return null;
  if (approval.validity === "valid") {
    return { label: "Approved", tone: "green" };
  }
  if (approval.validity === "stale") {
    return { label: "Approval stale", tone: "amber" };
  }
  return { label: "Approval closed", tone: "neutral" };
}

function elementDisplayName(view: SpecElementGetResponse): string {
  if ("kind" in view) {
    return view.kind === "question" ? view.question.text : view.assumption.text;
  }
  switch (view.element.version.payload.kind) {
    case "requirement":
      return view.element.version.payload.statement;
    case "decision":
      return view.element.version.payload.title;
    case "task":
      return view.element.version.payload.title;
    case "criterion":
      return view.element.version.payload.text;
    case "section":
      return view.element.version.payload.title;
  }
}

const PHASE_LABELS: Record<SpecPhaseProjection["primary"], string> = {
  abandoned: "Abandoned",
  executing: "Executing",
  in_review: "In review",
  draft: "Draft",
  delivered: "Delivered",
  approved: "Approved",
};

export function formatSpecPhase(phase: SpecPhaseProjection): string {
  const primary = PHASE_LABELS[phase.primary];
  const phaseLabel =
    !phase.authoringFacet || phase.authoringFacet === phase.primary
      ? primary
      : `${primary} · ${PHASE_LABELS[phase.authoringFacet]}`;
  if (phase.authoringStage === undefined) return phaseLabel;
  const stageSuffix =
    phase.primary === "approved"
      ? `${phase.authoringStage} stage`
      : phase.authoringStage;
  return `${phaseLabel} · ${stageSuffix}`;
}

export function specPhaseTone(
  phase: SpecPhaseProjection["primary"],
): StatusChipTone {
  switch (phase) {
    case "approved":
    case "delivered":
      return "green";
    case "executing":
      return "cyan";
    case "in_review":
      return "amber";
    case "abandoned":
      return "red";
    case "draft":
      return "neutral";
  }
}

const referenceStatusTextClass: Record<StatusChipTone, string> = {
  neutral: "text-text-tertiary",
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
  violet: "text-violet",
};

const referenceStatusDotClass: Record<StatusChipTone, string> = {
  neutral: "bg-text-tertiary",
  cyan: "bg-cyan",
  amber: "bg-amber",
  green: "bg-green",
  red: "bg-red",
  violet: "bg-violet",
};

const referenceStatusDensityClass = {
  chip: "font-medium",
  peek: "font-semibold",
} as const;

function ReferenceStatusLabel({
  label,
  tone,
  density,
  stale = false,
}: {
  label: string;
  tone: StatusChipTone;
  density: keyof typeof referenceStatusDensityClass;
  stale?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-xs font-mono text-[0.7rem] tracking-[0.05em] uppercase",
        referenceStatusDensityClass[density],
        referenceStatusTextClass[tone],
      )}
    >
      {stale ? (
        <StaleIcon />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-[4px] rounded-full",
            referenceStatusDotClass[tone],
          )}
        />
      )}
      {label}
    </span>
  );
}

function StaleIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2.5 8a5.5 5.5 0 0 1 9.9-3.4m.2-3.2-.2 3.2-3.2-.2M13.5 8a5.5 5.5 0 0 1-9.9 3.4m-.2 3.2.2-3.2 3.2.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RevisionArrowIcon({ stale }: { stale: boolean }): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={stale ? "text-amber" : "text-text-tertiary"}
    >
      <path
        d="M3 8h10m-3.5-3.5L13 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExternalLinkIcon(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="ml-xs inline-block align-[-1px]"
    >
      <path
        d="m5 11 6-6M5.5 4.5h6v6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpecGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      aria-hidden="true"
      className="h-[11px] w-[11px] shrink-0 text-cyan"
    >
      <path d="M3 2.5h6l4 4v7H3z" />
      <path d="M9 2.5v4h4M5.5 9h5M5.5 11.5h5" />
    </svg>
  );
}

/** Prose lines under a heading rule — a narrative section, not a document. */
function SectionGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      aria-hidden="true"
      className="h-[11px] w-[11px] shrink-0 text-text-tertiary"
    >
      <path d="M2.5 3.5h11M2.5 7h8M2.5 10h11M2.5 13h6" />
    </svg>
  );
}

function normalizeEditorAttrs(
  attrs: Record<string, unknown>,
): SpecMentionAttrs | SpecElementMentionAttrs | SpecSectionMentionAttrs {
  const projectName = stringAttr(attrs["projectName"]);
  const slug = stringAttr(attrs["slug"]);
  const name = stringAttr(attrs["name"]);
  const revision = stringAttr(attrs["revision"]) || "1";
  const handle = stringAttr(attrs["handle"]);
  const elementId = stringAttr(attrs["elementId"]);
  const readCommand =
    stringAttr(attrs["readCommand"]) ||
    (elementId
      ? buildSpecSectionReadCommand(projectName, slug, elementId)
      : buildSpecReadCommand(projectName, slug, handle || undefined));
  const common = { projectName, slug, name, revision, readCommand };
  if (handle) return { ...common, handle };
  return elementId ? { ...common, elementId } : common;
}

function stringAttr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function specMentionToWireAttrs(attrs: SpecMentionAttrs): SpecRefAttrs {
  return {
    "project-name": attrs.projectName,
    slug: attrs.slug,
    name: attrs.name,
    revision: attrs.revision,
    "read-command": attrs.readCommand,
  };
}

function elementMentionToWireAttrs(
  attrs: SpecElementMentionAttrs,
): SpecElementRefAttrs {
  return {
    ...specMentionToWireAttrs(attrs),
    handle: attrs.handle,
  };
}

function sectionMentionToWireAttrs(
  attrs: SpecSectionMentionAttrs,
): SpecSectionRefAttrs {
  return {
    ...specMentionToWireAttrs(attrs),
    "element-id": attrs.elementId,
  };
}

const productionChips = createSpecRefChips({
  useSpecSummary: useSpecSummaryQuery,
  useSpecElement: useSpecElementQuery,
});

export const SpecRefEditorChip = productionChips.SpecRefEditorChip;
export const SpecRefTranscriptChip = productionChips.SpecRefTranscriptChip;
export const SpecElementRefTranscriptChip =
  productionChips.SpecElementRefTranscriptChip;
export const SpecSectionRefTranscriptChip =
  productionChips.SpecSectionRefTranscriptChip;

export {
  CopyReferenceControl,
  createCopyReferenceControl,
  type CopyReferenceControlProps,
} from "./CopyReferenceControl";
