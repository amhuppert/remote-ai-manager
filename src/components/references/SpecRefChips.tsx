"use client";

import Link from "next/link";
import { useState, type MouseEvent } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { HoverCard } from "radix-ui";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import {
  buildSpecReadCommand,
  buildSpecReferenceXml,
  type SpecElementMentionAttrs,
  type SpecElementRefAttrs,
  type SpecMentionAttrs,
  type SpecReferenceType,
  type SpecRefAttrs,
} from "@/lib/prompt-editor/spec-reference-contract";
import type { SpecPhaseProjection } from "@/lib/specs/phase";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  useSpecElementQuery,
  useSpecSummaryQuery,
  type SpecElementGetResponse,
  type SpecElementReferenceState,
  type SpecSummaryView,
} from "@/lib/specs/queries";

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

const referenceChipClass =
  "inline-flex items-center gap-xs rounded-md border border-solid border-border-default bg-bg-raised px-[6px] py-[2px] align-baseline font-mono text-[0.78rem] leading-none text-inherit no-underline transition-[border-color,background,box-shadow] duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:shadow-[0_0_0_2px_var(--cyan-glow)] focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";
const logger = createClientLogger("references.spec");

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
    const phase = summary ? formatSpecPhase(summary.phase) : "Loading";
    const tone = summary ? specPhaseTone(summary.phase.primary) : "neutral";

    return (
      <HoverCard.Root openDelay={100} closeDelay={80}>
        <HoverCard.Trigger asChild>
          <Link
            href={specStudioHref(projectName, attrs.slug)}
            className={referenceChipClass}
            aria-label={`${name} ${phase}`}
            data-spec-ref-chip=""
          >
            <SpecGlyph />
            <span className="text-text-primary">{name}</span>
            <StatusChip tone={tone} appearance="flat">
              {phase}
            </StatusChip>
          </Link>
        </HoverCard.Trigger>
        <HoverCard.Portal>
          <HoverCard.Content
            sideOffset={6}
            collisionPadding={8}
            aria-label="Spec summary"
            className="z-popover w-[280px] rounded-md border border-solid border-border-default bg-bg-raised p-md text-text-primary shadow-lg"
          >
            <div className="flex items-start justify-between gap-md">
              <div className="min-w-0">
                <div className="truncate font-mono text-[0.78rem] font-semibold">
                  {name}
                </div>
                <div className="mt-xs font-mono text-[0.68rem] text-text-tertiary">
                  {attrs.slug}
                </div>
              </div>
              <StatusChip tone={tone}>{phase}</StatusChip>
            </div>
            {summary ? <SpecPeekSummary summary={summary} /> : null}
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
    const stale = isSpecElementReferenceStale(
      query.data !== undefined && "referenceState" in query.data
        ? query.data.referenceState
        : null,
    );
    const address = `${attrs.slug}/${attrs.handle}`;

    return (
      <Link
        href={specStudioHref(attrs["project-name"], attrs.slug, attrs.handle)}
        className={referenceChipClass}
        aria-label={`${address} ${statement}${stale ? " Changed" : ""}`}
        title={statement}
        data-spec-element-ref-chip=""
      >
        <SpecGlyph />
        <span className="text-cyan">{address}</span>
        <span className="max-w-[260px] truncate text-text-primary">
          {statement}
        </span>
        {stale ? (
          <StatusChip tone="amber" appearance="flat">
            Changed
          </StatusChip>
        ) : null}
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
  };
}

function SpecPeekSummary({
  summary,
}: {
  summary: SpecSummaryView;
}): React.JSX.Element {
  return (
    <div className="mt-md grid gap-xs font-mono text-[0.7rem] text-text-secondary">
      <span>{summary.counts.requirements} requirements</span>
      <span>{summary.counts.criteria} acceptance criteria</span>
      <span>
        Approval {summary.approvalState === "complete" ? "complete" : "pending"}
      </span>
    </div>
  );
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
  if (!phase.authoringFacet || phase.authoringFacet === phase.primary) {
    return primary;
  }
  return `${primary} · ${PHASE_LABELS[phase.authoringFacet]}`;
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

function SpecGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      aria-hidden="true"
      className="h-[12px] w-[12px] shrink-0 text-cyan"
    >
      <path d="M3 2.5h6l4 4v7H3z" />
      <path d="M9 2.5v4h4M5.5 9h5M5.5 11.5h5" />
    </svg>
  );
}

function normalizeEditorAttrs(
  attrs: Record<string, unknown>,
): SpecMentionAttrs | SpecElementMentionAttrs {
  const projectName = stringAttr(attrs["projectName"]);
  const slug = stringAttr(attrs["slug"]);
  const name = stringAttr(attrs["name"]);
  const revision = stringAttr(attrs["revision"]) || "1";
  const handle = stringAttr(attrs["handle"]);
  const readCommand =
    stringAttr(attrs["readCommand"]) ||
    buildSpecReadCommand(projectName, slug, handle || undefined);
  const common = { projectName, slug, name, revision, readCommand };
  return handle ? { ...common, handle } : common;
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

export interface CopyReferenceControlProps {
  referenceType: SpecReferenceType;
  attrs: SpecMentionAttrs | SpecElementMentionAttrs;
}

export interface CopyReferenceControlDeps {
  writeText(text: string): Promise<void>;
}

export function createCopyReferenceControl(deps: CopyReferenceControlDeps) {
  return function CopyReferenceControl({
    referenceType,
    attrs,
  }: CopyReferenceControlProps): React.JSX.Element {
    const [copied, setCopied] = useState(false);
    const reference = buildSpecReferenceXml(referenceType, { ...attrs });
    const handleCopy = async () => {
      setCopied(false);
      try {
        await deps.writeText(reference);
        setCopied(true);
      } catch {
        logger.warn("copy_reference.failed", { referenceType });
      }
    };
    return (
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-xs rounded-sm border border-solid border-border-default bg-transparent px-sm py-xs font-mono text-[0.7rem] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        onClick={() => void handleCopy()}
        aria-label={copied ? "Reference copied" : "Copy reference"}
      >
        {copied ? "Copied" : "Copy reference"}
      </button>
    );
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

export const CopyReferenceControl = createCopyReferenceControl({
  async writeText(text) {
    await navigator.clipboard.writeText(text);
  },
});
