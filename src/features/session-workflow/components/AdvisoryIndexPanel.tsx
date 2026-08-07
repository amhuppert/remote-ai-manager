"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import type { GraphWorkflowAdvisoryIndexEntry } from "@/lib/workflow-graph/schemas";

type IndexedKind = GraphWorkflowAdvisoryIndexEntry["kind"];

/**
 * Where an indexed advisory was raised. The round travels with the context
 * because round numbering is per context and a context outlives its rounds: a
 * link carrying only the context would land wherever that context has since
 * got to, which is not where the advisory is.
 */
export interface AdvisoryOrigin {
  contextId: string;
  roundSeq: number;
}

const KIND_LABEL: Record<IndexedKind, string> = {
  plan: "Plan",
  out_of_scope: "Out of scope",
};

// The same informational coding the round history uses, so one advisory reads
// identically wherever the operator meets it. Red stays reserved for blocking
// issues — nothing in this panel can fail a context.
const KIND_TONE: Record<IndexedKind, StatusChipTone> = {
  plan: "amber",
  out_of_scope: "neutral",
};

const originClass =
  "font-mono text-[0.68rem] text-text-tertiary transition-colors duration-150";

const originButtonClass = cn(
  originClass,
  "cursor-pointer appearance-none border-0 bg-transparent p-0 text-left hover:text-text-primary",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
);

/**
 * Every `plan` and `out_of_scope` advisory the run has raised, read straight off
 * the execution-level index projection rather than by scanning rounds.
 *
 * These are the advisories that outlive the round that raised them (D9), and
 * their audience — the human reading the run now, the owning agent of roadmap
 * D8 later — should not have to open every context's history to find them. The
 * origin is a link rather than a label because the advisory's full text,
 * delivery, and disposition stay on the round record; this panel is the way in,
 * not a second copy.
 */
export default function AdvisoryIndexPanel({
  index,
  contextTitles,
  onOpenOrigin,
}: {
  index: readonly GraphWorkflowAdvisoryIndexEntry[];
  /** Execution-context titles by id; a missing id falls back to the id itself. */
  contextTitles: Readonly<Record<string, string>>;
  /** Opens the originating round; absent when the host cannot navigate. */
  onOpenOrigin?: (origin: AdvisoryOrigin) => void;
}): React.JSX.Element | null {
  if (index.length === 0) return null;

  return (
    <ul
      className="m-0 flex list-none flex-col gap-[6px] p-0"
      data-testid="advisory-index"
    >
      {index.map((entry) => {
        const { roundSeq, assignmentId, ordinal } = entry.identity;
        const originLabel = `${contextTitles[entry.contextId] ?? entry.contextId} · Round ${roundSeq} · ${assignmentId}`;
        return (
          <li
            key={`${entry.contextId}:${roundSeq}:${assignmentId}:${ordinal}`}
            data-testid="advisory-index-entry"
            data-context-id={entry.contextId}
            data-kind={entry.kind}
            className="flex flex-col gap-[4px] rounded-sm border border-solid border-border-dim bg-bg-raised px-[10px] py-[8px]"
          >
            <div className="flex flex-wrap items-center gap-[6px]">
              <StatusChip
                tone={KIND_TONE[entry.kind]}
                data-testid="advisory-index-kind"
              >
                {KIND_LABEL[entry.kind]}
              </StatusChip>
              <span className="text-[0.74rem] font-semibold text-text-primary">
                {entry.title}
              </span>
            </div>
            {onOpenOrigin === undefined ? (
              <span className={originClass} data-testid="advisory-index-origin">
                {originLabel}
              </span>
            ) : (
              <button
                type="button"
                className={originButtonClass}
                data-testid="advisory-index-origin"
                onClick={() =>
                  onOpenOrigin({ contextId: entry.contextId, roundSeq })
                }
              >
                {originLabel}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
