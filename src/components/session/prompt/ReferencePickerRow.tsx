"use client";

import { AutocompleteOption } from "@/components/ui/Autocomplete";
import { IconButton } from "@/components/ui/IconButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import type {
  PickerGlyph,
  PickerItemRow,
  PickerMoreRow,
} from "@/lib/prompt-editor/reference-picker";
import type {
  ReferenceItemFact,
  ReferenceItemMeta,
  ReferenceStatusTone,
} from "@/lib/prompt-editor/reference-registry";
import { cn } from "@/lib/ui/cn";

// One row shape serves every kind, so a kind only chooses which slots it fills.
// Kind identity is carried by the leading glyph's colour: files read as neutral
// chrome, conversations cyan, specs violet, tickets amber, notepads blue.
const GLYPH_PATHS: Record<PickerGlyph, string> = {
  file: "M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6ZM13 3v6h6",
  conversation: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  spec: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  ticket:
    "M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4Z",
  notepad:
    "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6M8 13h7M8 17h4",
};

const GLYPH_COLOR_CLASS: Record<PickerGlyph, string> = {
  file: "text-text-secondary",
  conversation: "text-cyan",
  spec: "text-violet",
  ticket: "text-amber",
  notepad: "text-blue",
};

const STATUS_DOT_CLASS: Record<ReferenceStatusTone, string> = {
  cyan: "bg-cyan",
  amber: "bg-amber",
  green: "bg-green",
  red: "bg-red",
  neutral: "bg-text-tertiary",
};

const STATUS_TEXT_CLASS: Record<ReferenceStatusTone, string> = {
  cyan: "text-cyan",
  amber: "text-amber",
  green: "text-green",
  red: "text-red",
  neutral: "text-text-secondary",
};

const FACT_CLASS: Record<ReferenceItemFact["tone"], string> = {
  accent: "text-cyan",
  muted: "text-text-tertiary",
};

export function PickerGlyphIcon({
  glyph,
}: {
  glyph: PickerGlyph;
}): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      className={cn("shrink-0", GLYPH_COLOR_CLASS[glyph])}
    >
      <path
        d={GLYPH_PATHS[glyph]}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

/**
 * A label with three character classes: the dimmed prefix a file path uses for
 * its directory, matched characters, and everything else. Runs of the same
 * class are coalesced so a long title is a handful of spans, not one per char.
 */
export function PickerLabel({
  label,
  matchIndices,
  dimPrefixLength,
}: {
  label: string;
  matchIndices: readonly number[];
  dimPrefixLength: number;
}): React.JSX.Element {
  const matched = new Set(matchIndices);
  const runs: { className: string; text: string }[] = [];
  for (let index = 0; index < label.length; index++) {
    const className = matched.has(index)
      ? "text-cyan"
      : index < dimPrefixLength
        ? "text-text-secondary"
        : "text-text-primary";
    const last = runs.at(-1);
    if (last && last.className === className) last.text += label[index];
    else runs.push({ className, text: label[index] ?? "" });
  }
  return (
    <span className="min-w-0 shrink overflow-hidden text-[0.78rem] font-medium text-ellipsis whitespace-nowrap">
      {runs.map((run, index) => (
        <span key={index} className={run.className}>
          {run.text}
        </span>
      ))}
    </span>
  );
}

function PickerMeta({ meta }: { meta: ReferenceItemMeta }): React.JSX.Element {
  return (
    <span className="shrink-0 text-[0.68rem] text-text-tertiary">
      {meta.kind === "text"
        ? meta.value
        : formatRelativeTime(meta.iso, { style: "short" })}
    </span>
  );
}

export interface ReferencePickerItemRowProps {
  row: PickerItemRow;
  id: string;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
  onOpen: () => void;
}

export function ReferencePickerItemRow({
  row,
  id,
  active,
  onHover,
  onSelect,
  onOpen,
}: ReferencePickerItemRowProps): React.JSX.Element {
  // Muting the cells rather than the row keeps the active accent rail and its
  // glow at full strength on a finished or archived row.
  const cellTone = row.muted ? "opacity-55" : undefined;
  return (
    <AutocompleteOption
      id={id}
      semanticRole="row"
      active={active}
      onHover={onHover}
      onSelect={onSelect}
    >
      <div
        role="gridcell"
        className={cn(
          "relative z-raised flex min-w-0 flex-1 items-center gap-sm",
          cellTone,
        )}
      >
        <PickerGlyphIcon glyph={row.glyph} />
        {row.idLabel === null ? null : (
          <span className="shrink-0 text-[0.7rem] font-semibold text-cyan">
            {row.idLabel}
          </span>
        )}
        <PickerLabel
          label={row.label}
          matchIndices={row.matchIndices}
          dimPrefixLength={row.dimPrefixLength}
        />
        <span className="min-w-0 flex-1 overflow-hidden text-[0.72rem] text-ellipsis whitespace-nowrap text-text-tertiary">
          {row.description}
        </span>
        {row.status === null ? null : (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-xs text-[0.7rem]",
              STATUS_TEXT_CLASS[row.status.tone],
            )}
          >
            <span
              className={cn(
                "size-[6px] shrink-0 rounded-full",
                STATUS_DOT_CLASS[row.status.tone],
              )}
            />
            {row.status.label}
          </span>
        )}
        {row.facts.map((fact) => (
          <span
            key={fact.label}
            className={cn(
              "shrink-0 text-[0.7rem] max-960:hidden",
              FACT_CLASS[fact.tone],
            )}
          >
            {fact.label}
          </span>
        ))}
      </div>
      <div
        role="gridcell"
        className={cn(
          "relative z-raised ml-auto flex shrink-0 items-center gap-xs",
          cellTone,
        )}
      >
        {row.meta === null ? null : <PickerMeta meta={row.meta} />}
        {row.openablePath === null ? null : (
          <WithTooltip label="Open in Markdown viewer">
            <IconButton
              type="button"
              aria-label={`Open ${row.openablePath} in Markdown viewer`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpen();
              }}
            >
              <OpenDocumentIcon />
            </IconButton>
          </WithTooltip>
        )}
      </div>
    </AutocompleteOption>
  );
}

export function ReferencePickerMoreRow({
  row,
  id,
  active,
  onHover,
  onSelect,
}: {
  row: PickerMoreRow;
  id: string;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <AutocompleteOption
      id={id}
      semanticRole="row"
      active={active}
      onHover={onHover}
      onSelect={onSelect}
    >
      <span
        role="gridcell"
        className="relative z-raised flex-1 text-[0.72rem] text-text-secondary"
      >
        {row.label}
      </span>
      <span
        role="gridcell"
        className="relative z-raised shrink-0 text-[0.65rem] text-text-tertiary max-768:hidden"
      >
        Enter to open scope
      </span>
    </AutocompleteOption>
  );
}

function OpenDocumentIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M14 3v5h5M13 11l7-7m-5 0h5v5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
