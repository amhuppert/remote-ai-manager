"use client";

import { useState } from "react";
import { cn } from "@/lib/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { Button } from "@/components/ui/Button";
import type {
  AnchoredNote,
  CommandEntry,
  CompactionEnvelope,
  Decision,
  FileEntry,
} from "@/lib/context-artifacts/schemas";
import type { SourceRef } from "@/lib/conversations/schemas";

/**
 * Row-level generation metadata for the footer. `ContextArtifactDetail`
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

const sectionLabelClass =
  "text-[0.7rem] font-bold uppercase tracking-[0.1em] text-text-tertiary";

const decisionStatusClass: Record<Decision["status"], string> = {
  proposed: "text-amber",
  accepted: "text-green",
  rejected: "text-red",
  superseded: "text-text-tertiary",
};

const commandOutcomeClass: Record<CommandEntry["outcome"], string> = {
  succeeded: "text-green",
  failed: "text-red",
  mixed: "text-amber",
  unknown: "text-text-tertiary",
};

// Chip label must clear WCAG AA 4.5:1 on bg-raised (#172033):
// text-text-secondary #7b899f = 4.59:1; text-text-tertiary #738699 = 4.33:1
// fails at this 10.5px size while staying the visually-subtle choice below
// full-brightness text-text-primary.
const chipBaseClass =
  "inline-flex items-center rounded-full border border-solid border-border-subtle bg-bg-raised px-[6px] py-0 font-mono text-[0.7rem] leading-[1.6] text-text-secondary";

const tagClass =
  "font-mono text-[0.7rem] font-medium uppercase tracking-[0.05em]";

function SourceRefChips({
  refs,
  onNavigateToMessage,
}: {
  refs: SourceRef[];
  onNavigateToMessage?: (messageIndex: number) => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-xs">
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
              "cursor-pointer transition-colors duration-150 ease-[ease] hover:border-border-strong hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
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

function EnvelopeSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger>
        <span className={sectionLabelClass}>{label}</span>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {count}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-sm px-md py-xs">{children}</div>
      </CollapsibleContent>
    </Collapsible>
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
    <div className="flex flex-wrap items-baseline gap-sm">
      <span className="text-text-primary">{note.text}</span>
      <SourceRefChips
        refs={note.sourceRefs}
        onNavigateToMessage={onNavigateToMessage}
      />
    </div>
  );
}

/**
 * Renders a compaction envelope (design §12.1/§12.2): the canonical JSON as a
 * dense, information-first operator surface — never a prose article. Shared by
 * the inline message viewer and the conversation-level artifact panel.
 */
export default function CompactionEnvelopeView({
  envelope,
  provenance,
  onNavigateToMessage,
}: CompactionEnvelopeViewProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const { source, omissions } = envelope;

  const omissionParts = [
    envelope.omissions.reasoningOmitted ? "reasoning omitted" : null,
    omissions.largeToolOutputsElided > 0
      ? `${omissions.largeToolOutputsElided} large tool outputs elided`
      : null,
  ].filter((part) => part !== null);

  const provenanceLine = provenance
    ? [
        `${provenance.modelProvider} · ${provenance.model}${
          provenance.effort ? ` · ${provenance.effort}` : ""
        }`,
        `prompt ${provenance.promptVersion} · normalizer ${provenance.normalizerVersion} · schema v${provenance.schemaVersion}`,
        `by ${provenance.createdBy}`,
        provenance.createdAt.slice(0, 16).replace("T", " "),
      ].join(" · ")
    : null;

  return (
    <div className="flex flex-col gap-md font-mono text-[0.78rem] leading-[1.5] text-text-secondary">
      <section>
        <div className={cn(sectionLabelClass, "mb-xs")}>Agent brief</div>
        <p className="m-0 whitespace-pre-wrap text-text-primary">
          {envelope.agentBrief}
        </p>
      </section>

      <section>
        <div className={cn(sectionLabelClass, "mb-xs")}>Current state</div>
        <div className="flex flex-col gap-xs">
          <div>
            <span className="text-text-tertiary">status </span>
            <span className="text-cyan">{envelope.currentState.status}</span>
          </div>
          <div>
            <span className="text-text-tertiary">goal </span>
            <span className="text-text-primary">
              {envelope.currentState.latestUserGoal}
            </span>
          </div>
          {envelope.currentState.nextBestActions.length > 0 && (
            <ol className="m-0 flex list-none flex-col gap-[2px] p-0">
              {envelope.currentState.nextBestActions.map((action, i) => (
                <li key={i}>
                  <span className="text-text-tertiary">{i + 1}. </span>
                  <span className="text-text-primary">{action}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <EnvelopeSection label="Decisions" count={envelope.decisions.length}>
        {envelope.decisions.map((decision, i) => (
          <div key={i} className="flex flex-col gap-[2px]">
            <div className="flex flex-wrap items-baseline gap-sm">
              <span
                className={cn(tagClass, decisionStatusClass[decision.status])}
              >
                {decision.status}
              </span>
              <span className="text-text-primary">{decision.statement}</span>
              <SourceRefChips
                refs={decision.sourceRefs}
                onNavigateToMessage={onNavigateToMessage}
              />
            </div>
            {decision.rationale && (
              <div className="text-text-tertiary">{decision.rationale}</div>
            )}
          </div>
        ))}
      </EnvelopeSection>

      <EnvelopeSection label="Files" count={envelope.files.length}>
        {envelope.files.map((file: FileEntry, i) => (
          <div key={i} className="flex flex-col gap-[2px]">
            <div className="flex flex-wrap items-baseline gap-sm">
              <span className={cn(tagClass, "text-text-tertiary")}>
                {file.role}
              </span>
              <span className="break-all text-text-primary">{file.path}</span>
              <SourceRefChips
                refs={file.sourceRefs}
                onNavigateToMessage={onNavigateToMessage}
              />
            </div>
            {file.details && (
              <div className="text-text-tertiary">{file.details}</div>
            )}
          </div>
        ))}
      </EnvelopeSection>

      <EnvelopeSection label="Commands" count={envelope.commands.length}>
        {envelope.commands.map((command, i) => (
          <div key={i} className="flex flex-col gap-[2px]">
            <div className="flex flex-wrap items-baseline gap-sm">
              <span
                className={cn(tagClass, commandOutcomeClass[command.outcome])}
              >
                {command.outcome}
              </span>
              <span className="break-all text-text-primary">
                {command.command}
              </span>
              <SourceRefChips
                refs={command.sourceRefs}
                onNavigateToMessage={onNavigateToMessage}
              />
            </div>
            {command.summary && (
              <div className="text-text-tertiary">{command.summary}</div>
            )}
          </div>
        ))}
      </EnvelopeSection>

      <EnvelopeSection
        label="Open questions"
        count={envelope.openQuestions.length}
      >
        {envelope.openQuestions.map((note, i) => (
          <AnchoredNoteItem
            key={i}
            note={note}
            onNavigateToMessage={onNavigateToMessage}
          />
        ))}
      </EnvelopeSection>

      <EnvelopeSection label="Blockers" count={envelope.blockers.length}>
        {envelope.blockers.map((note, i) => (
          <AnchoredNoteItem
            key={i}
            note={note}
            onNavigateToMessage={onNavigateToMessage}
          />
        ))}
      </EnvelopeSection>

      <footer className="flex flex-col gap-xs border-x-0 border-t border-b-0 border-solid border-border-subtle pt-sm text-[0.7rem] text-text-tertiary">
        <div>
          {[
            `coverage seq ${source.coveredStartSeq}–${source.coveredEndSeq} · ${source.messageCount} messages`,
            ...omissionParts,
          ].join(" · ")}
        </div>
        {provenanceLine && <div>{provenanceLine}</div>}
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRawOpen((open) => !open)}
          >
            {rawOpen ? "Hide raw JSON" : "Raw JSON"}
          </Button>
        </div>
        {rawOpen && (
          <pre className="m-0 max-h-[320px] overflow-auto rounded-sm border border-solid border-border-subtle bg-bg-base p-sm font-mono text-[0.7rem] leading-[1.5] whitespace-pre text-text-secondary">
            {JSON.stringify(envelope, null, 2)}
          </pre>
        )}
      </footer>
    </div>
  );
}
