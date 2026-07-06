"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { disclosureChevron } from "@/components/ui/disclosure-recipe";
import { Button } from "@/components/ui/Button";
import { ChevronDownIcon } from "@/components/icons";
import type {
  AnchoredNote,
  CommandEntry,
  CompactionEnvelope,
  Decision,
  FileEntry,
} from "@/lib/context-artifacts/schemas";
import type { SourceRef } from "@/lib/conversations/schemas";

/**
 * Row-level generation metadata for the meta rail. `ContextArtifactDetail`
 * satisfies this structurally, so callers can pass the fetched row directly.
 */
export interface CompactionProvenance {
  modelProvider: string;
  model: string;
  effort?: string | null;
  promptVersion: string;
  normalizerVersion: string;
  schemaVersion: number;
  createdBy: string;
  createdAt: string;
}

export interface CompactionEnvelopeViewProps {
  envelope: CompactionEnvelope;
  provenance?: CompactionProvenance;
  /**
   * Drill-through for sourceRef chips. When omitted the chips render as plain
   * non-interactive spans (e.g. hosts without transcript navigation).
   */
  onNavigateToMessage?: (messageIndex: number) => void;
}

/** Shared section-header label recipe (design handoff §4). */
const sectionLabelClass =
  "font-display text-[12px] font-semibold uppercase tracking-[0.1em] text-text-secondary";

const railHeadingClass =
  "font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-tertiary";

const focusRingClass =
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

const decisionStatusClass: Record<Decision["status"], string> = {
  proposed: "text-amber",
  accepted: "text-green",
  rejected: "text-red",
  superseded: "text-text-tertiary",
};

const fileRoleClass: Record<FileEntry["role"], string> = {
  created: "text-green",
  modified: "text-amber",
  deleted: "text-red",
  read: "text-text-tertiary",
  discussed: "text-violet",
};

const commandOutcomeClass: Record<CommandEntry["outcome"], string> = {
  succeeded: "text-green",
  failed: "text-red",
  mixed: "text-amber",
  unknown: "text-text-tertiary",
};

// Chip label must clear WCAG AA 4.5:1 on bg-raised (#172033):
// text-text-secondary #7b899f = 4.59:1; text-text-tertiary #738699 = 4.33:1
// fails at this size while staying the visually-subtle choice below
// full-brightness text-text-primary.
const chipBaseClass =
  "inline-flex items-center rounded-sm border border-solid border-border-subtle bg-bg-raised px-[5px] py-px font-mono text-[10px] leading-[1.6] text-text-secondary";

const tagClass =
  "font-mono text-[10px] font-semibold uppercase tracking-[0.08em]";

/** Anchored-list row: fixed tag column, content, right-aligned ref chips. */
const rowClass =
  "grid grid-cols-[92px_minmax(0,1fr)_max-content] items-baseline gap-x-[14px] gap-y-xs border-x-0 border-t border-b-0 border-solid border-border-dim p-md";

const rowSecondaryLineClass =
  "mt-xs font-mono text-[11.5px] leading-[1.6] text-text-tertiary";

const proseStatementClass =
  "font-body text-[13.5px] leading-[1.55] text-text-primary";

const monoDataClass =
  "font-mono text-[12px] leading-[1.5] break-all text-text-primary";

type StatusTone = "green" | "cyan" | "red";

/**
 * currentState.status is free-form model output; tone is keyed off intent
 * keywords — complete-ish → green, blocked/failed-ish → red, anything else
 * (in-progress) → cyan.
 */
function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (/(block|fail|stuck|halt|error)/.test(normalized)) return "red";
  if (/(complete|resolved|done|finished|merged|shipped)/.test(normalized)) {
    return "green";
  }
  return "cyan";
}

const statusPillClass: Record<StatusTone, string> = {
  green: "bg-green-glow",
  cyan: "bg-cyan-glow",
  red: "bg-red-glow",
};

const statusDotClass: Record<StatusTone, string> = {
  green: "bg-green",
  cyan: "bg-cyan",
  red: "bg-red",
};

const statusTextClass: Record<StatusTone, string> = {
  green: "text-green",
  cyan: "text-cyan",
  red: "text-red",
};

function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-[6px] rounded-full px-[10px] py-[3px]",
        statusPillClass[tone],
      )}
    >
      <span
        className={cn("h-[6px] w-[6px] rounded-full", statusDotClass[tone])}
      />
      <span
        className={cn(
          "font-mono text-[10px] font-semibold tracking-[0.08em] uppercase",
          statusTextClass[tone],
        )}
      >
        {status}
      </span>
    </span>
  );
}

function SourceRefChips({
  refs,
  onNavigateToMessage,
}: {
  refs: SourceRef[];
  onNavigateToMessage?: (messageIndex: number) => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-xs">
      {refs.map((ref, i) => {
        const title = `seq ${ref.seqStart}–${ref.seqEnd}${
          ref.quote ? ` · “${ref.quote}”` : ""
        }`;
        const label = `#${ref.messageIndex}`;
        if (!onNavigateToMessage) {
          return (
            <span key={i} className={chipBaseClass} title={title}>
              {label}
            </span>
          );
        }
        return (
          <button
            key={i}
            type="button"
            className={cn(
              chipBaseClass,
              "cursor-pointer transition-colors duration-150 ease-[ease] hover:border-border-strong hover:text-cyan",
              focusRingClass,
            )}
            title={title}
            aria-label={`Go to message ${ref.messageIndex}`}
            onClick={() => onNavigateToMessage(ref.messageIndex)}
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-[10px]">
      <span className={sectionLabelClass}>{label}</span>
      <span className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

/**
 * Anchored-list section card (design handoff §7): darker surface, collapsible
 * from a custom header trigger, hairline-divided rows.
 */
function EnvelopeSection({
  label,
  count,
  sectionRef,
  children,
}: {
  label: string;
  count: number;
  sectionRef: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section
      ref={sectionRef}
      className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-base"
    >
      <Collapsible defaultOpen>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "group flex w-full cursor-pointer items-center gap-[10px] border-0 bg-transparent px-md py-[10px] text-left transition-colors duration-150 ease-[ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]",
            )}
          >
            <span className={sectionLabelClass}>{label}</span>
            <span className="font-mono text-[11px] text-text-tertiary">
              {count}
            </span>
            <ChevronDownIcon size={14} className={disclosureChevron} />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function AnchoredNoteItem({
  note,
  onNavigateToMessage,
}: {
  note: AnchoredNote;
  onNavigateToMessage?: (messageIndex: number) => void;
}) {
  return (
    <div className={cn(rowClass, "grid-cols-[minmax(0,1fr)_max-content]")}>
      <div className={proseStatementClass}>{note.text}</div>
      <SourceRefChips
        refs={note.sourceRefs}
        onNavigateToMessage={onNavigateToMessage}
      />
    </div>
  );
}

interface SectionEntry {
  key: string;
  label: string;
  count: number | null;
}

/** "No blockers recorded." / "No files or commands recorded." */
function formatEmptySectionsNote(labels: string[]): string {
  const names = labels.map((label) => label.toLowerCase());
  const list =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? `${names[0]} or ${names[1]}`
        : `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
  return `No ${list} recorded.`;
}

function formatTimestamp(createdAt: string): string {
  return createdAt.slice(0, 16).replace("T", " ");
}

function ProvenanceLines({
  provenance,
  conversationId,
}: {
  provenance: CompactionProvenance;
  conversationId: string;
}) {
  return (
    <>
      <span>
        {provenance.modelProvider} · {provenance.model}
        {provenance.effort ? ` · ${provenance.effort}` : ""}
      </span>
      <span>
        prompt {provenance.promptVersion} · normalizer{" "}
        {provenance.normalizerVersion} · schema v{provenance.schemaVersion}
      </span>
      <span>
        by {provenance.createdBy} · conv {conversationId.slice(0, 8)}
      </span>
    </>
  );
}

/**
 * Renders a compaction envelope (design handoff "Artifact Pane"): prose fields
 * in the body font, machine data in mono, anchored-list sections as collapsible
 * cards, and a sticky meta rail (status, coverage, TOC, provenance, raw JSON).
 * Shared by the inline message viewer and the conversation-level artifact
 * panel; below an 880px container width the rail collapses into a compact meta
 * line + mono footer.
 */
export default function CompactionEnvelopeView({
  envelope,
  provenance,
  onNavigateToMessage,
}: CompactionEnvelopeViewProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const sectionRefs = useRef(new Map<string, HTMLElement | null>());
  const { source, currentState, omissions } = envelope;

  const setSectionRef = (key: string) => (el: HTMLElement | null) => {
    sectionRefs.current.set(key, el);
  };
  const scrollToSection = (key: string) => {
    sectionRefs.current.get(key)?.scrollIntoView({ block: "start" });
  };

  const briefParagraphs = envelope.agentBrief
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const anchoredSections: SectionEntry[] = [
    { key: "decisions", label: "Decisions", count: envelope.decisions.length },
    { key: "files", label: "Files", count: envelope.files.length },
    { key: "commands", label: "Commands", count: envelope.commands.length },
    {
      key: "openQuestions",
      label: "Open questions",
      count: envelope.openQuestions.length,
    },
    { key: "blockers", label: "Blockers", count: envelope.blockers.length },
  ];
  const emptySectionLabels = anchoredSections
    .filter((entry) => entry.count === 0)
    .map((entry) => entry.label);

  const tocEntries: SectionEntry[] = [
    { key: "brief", label: "Agent brief", count: null },
    {
      key: "state",
      label: "Current state",
      count: currentState.nextBestActions.length || null,
    },
    ...anchoredSections.filter((entry) => entry.count !== 0),
  ];

  const omissionSummary = [
    omissions.reasoningOmitted ? "reasoning" : null,
    omissions.largeToolOutputsElided > 0
      ? `${omissions.largeToolOutputsElided} tool outputs`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");

  const rawToggle = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setRawOpen((open) => !open)}
    >
      {rawOpen ? "Hide raw JSON" : "Raw JSON"}
    </Button>
  );

  return (
    <div className="@container">
      <div className="flex flex-col gap-[20px]">
        {/* Narrow-container stand-in for the rail's status card (design
            handoff §Responsive): pill + one compact mono meta line. */}
        <div className="hidden flex-wrap items-center gap-sm @max-[880px]:flex">
          <StatusPill status={currentState.status} />
          <span className="font-mono text-[10px] text-text-tertiary">
            conv {source.conversationId.slice(0, 8)} · seq{" "}
            {source.coveredStartSeq}–{source.coveredEndSeq} ·{" "}
            {source.messageCount} messages
            {provenance
              ? ` · updated ${formatTimestamp(provenance.createdAt)}`
              : ""}
          </span>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_248px] items-start gap-[28px] @max-[880px]:grid-cols-[minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-xl">
            <section
              ref={setSectionRef("brief")}
              className="flex flex-col gap-[10px]"
            >
              <SectionHeading label="Agent brief" />
              <div className="flex max-w-[76ch] flex-col gap-md font-body text-[14px] leading-[1.72] text-text-primary">
                {briefParagraphs.map((paragraph, i) => (
                  <p key={i} className="m-0">
                    {paragraph}
                  </p>
                ))}
              </div>
            </section>

            <section
              ref={setSectionRef("state")}
              className="flex flex-col gap-[10px]"
            >
              <SectionHeading label="Current state" />
              <p className="m-0 max-w-[76ch] font-body text-[14px] leading-[1.6] text-text-primary">
                <span className="text-text-tertiary">Goal — </span>
                {currentState.latestUserGoal}
              </p>
              {currentState.nextBestActions.length > 0 && (
                <ol className="m-0 flex max-w-[76ch] list-none flex-col gap-[7px] p-0">
                  {currentState.nextBestActions.map((action, i) => (
                    <li key={i} className="flex gap-[10px]">
                      <span className="min-w-[14px] text-right font-mono text-[11.5px] text-cyan">
                        {i + 1}
                      </span>
                      <span className={proseStatementClass}>{action}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <EnvelopeSection
              label="Decisions"
              count={envelope.decisions.length}
              sectionRef={setSectionRef("decisions")}
            >
              {envelope.decisions.map((decision, i) => (
                <div key={i} className={rowClass}>
                  <span
                    className={cn(
                      tagClass,
                      decisionStatusClass[decision.status],
                    )}
                  >
                    {decision.status}
                  </span>
                  <div>
                    <div className={cn(proseStatementClass, "font-semibold")}>
                      {decision.statement}
                    </div>
                    {decision.rationale && (
                      <div className={rowSecondaryLineClass}>
                        {decision.rationale}
                      </div>
                    )}
                  </div>
                  <SourceRefChips
                    refs={decision.sourceRefs}
                    onNavigateToMessage={onNavigateToMessage}
                  />
                </div>
              ))}
            </EnvelopeSection>

            <EnvelopeSection
              label="Files"
              count={envelope.files.length}
              sectionRef={setSectionRef("files")}
            >
              {envelope.files.map((file, i) => (
                <div key={i} className={rowClass}>
                  <span className={cn(tagClass, fileRoleClass[file.role])}>
                    {file.role}
                  </span>
                  <div>
                    <div className={monoDataClass}>{file.path}</div>
                    {file.details && (
                      <div className={rowSecondaryLineClass}>
                        {file.details}
                      </div>
                    )}
                  </div>
                  <SourceRefChips
                    refs={file.sourceRefs}
                    onNavigateToMessage={onNavigateToMessage}
                  />
                </div>
              ))}
            </EnvelopeSection>

            <EnvelopeSection
              label="Commands"
              count={envelope.commands.length}
              sectionRef={setSectionRef("commands")}
            >
              {envelope.commands.map((command, i) => (
                <div key={i} className={rowClass}>
                  <span
                    className={cn(
                      tagClass,
                      commandOutcomeClass[command.outcome],
                    )}
                  >
                    {command.outcome}
                  </span>
                  <div>
                    <div className={monoDataClass}>{command.command}</div>
                    {command.summary && (
                      <div className={rowSecondaryLineClass}>
                        {command.summary}
                      </div>
                    )}
                  </div>
                  <SourceRefChips
                    refs={command.sourceRefs}
                    onNavigateToMessage={onNavigateToMessage}
                  />
                </div>
              ))}
            </EnvelopeSection>

            <EnvelopeSection
              label="Open questions"
              count={envelope.openQuestions.length}
              sectionRef={setSectionRef("openQuestions")}
            >
              {envelope.openQuestions.map((note, i) => (
                <AnchoredNoteItem
                  key={i}
                  note={note}
                  onNavigateToMessage={onNavigateToMessage}
                />
              ))}
            </EnvelopeSection>

            <EnvelopeSection
              label="Blockers"
              count={envelope.blockers.length}
              sectionRef={setSectionRef("blockers")}
            >
              {envelope.blockers.map((note, i) => (
                <AnchoredNoteItem
                  key={i}
                  note={note}
                  onNavigateToMessage={onNavigateToMessage}
                />
              ))}
            </EnvelopeSection>

            {emptySectionLabels.length > 0 && (
              <div className="font-mono text-[11px] text-text-tertiary">
                {formatEmptySectionsNote(emptySectionLabels)}
              </div>
            )}

            {/* Narrow-container stand-in for the rail's provenance card: the
                two-line mono footer + raw-JSON toggle. */}
            <footer className="hidden flex-col items-start gap-xs border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm font-mono text-[10px] leading-[1.6] text-text-tertiary @max-[880px]:flex">
              {omissionSummary && <span>omitted {omissionSummary}</span>}
              {provenance && (
                <ProvenanceLines
                  provenance={provenance}
                  conversationId={source.conversationId}
                />
              )}
              {rawToggle}
            </footer>
          </div>

          <aside className="sticky top-[20px] flex flex-col gap-md @max-[880px]:hidden">
            <div className="flex flex-col gap-[10px] rounded-md border border-solid border-border-subtle bg-bg-base p-md">
              <div className="flex flex-wrap items-center gap-sm">
                <StatusPill status={currentState.status} />
                {provenance && (
                  <span className="font-mono text-[10px] text-text-tertiary">
                    {formatTimestamp(provenance.createdAt)}
                  </span>
                )}
              </div>
              <div className="h-px bg-border-dim" />
              <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-md gap-y-[6px] font-mono text-[10.5px]">
                <span className="tracking-[0.08em] text-text-tertiary uppercase">
                  Coverage
                </span>
                <span className="text-text-secondary">
                  seq {source.coveredStartSeq}–{source.coveredEndSeq}
                </span>
                <span className="tracking-[0.08em] text-text-tertiary uppercase">
                  Messages
                </span>
                <span className="text-text-secondary">
                  {source.messageCount}
                </span>
                {omissionSummary && (
                  <>
                    <span className="tracking-[0.08em] text-text-tertiary uppercase">
                      Omitted
                    </span>
                    <span className="text-text-secondary">
                      {omissionSummary}
                    </span>
                  </>
                )}
              </div>
            </div>

            <nav
              aria-label="On this artifact"
              className="flex flex-col rounded-md border border-solid border-border-subtle bg-bg-base p-[6px]"
            >
              <div className={cn(railHeadingClass, "px-sm py-[6px]")}>
                On this artifact
              </div>
              {tocEntries.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={cn(
                    "flex w-full cursor-pointer items-baseline justify-between gap-sm rounded-sm border-0 bg-transparent px-sm py-[5px] text-left font-mono text-[11px] text-text-secondary transition-colors duration-150 ease-[ease] hover:bg-bg-hover hover:text-cyan",
                    focusRingClass,
                  )}
                  onClick={() => scrollToSection(entry.key)}
                >
                  <span>{entry.label}</span>
                  {entry.count !== null && (
                    <span className="text-text-tertiary">{entry.count}</span>
                  )}
                </button>
              ))}
            </nav>

            {provenance && (
              <div className="flex flex-col gap-xs rounded-md border border-solid border-border-subtle bg-bg-base p-md font-mono text-[10px] leading-[1.6] text-text-tertiary">
                <span className="font-bold tracking-[0.12em] uppercase">
                  Provenance
                </span>
                <ProvenanceLines
                  provenance={provenance}
                  conversationId={source.conversationId}
                />
              </div>
            )}

            {rawToggle}
          </aside>
        </div>

        {rawOpen && (
          <pre className="m-0 max-h-[320px] overflow-auto rounded-sm border border-solid border-border-subtle bg-bg-base p-[10px] font-mono text-[11px] leading-[1.5] whitespace-pre text-text-secondary">
            {JSON.stringify(envelope, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
