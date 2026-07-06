"use client";

import { cn } from "@/lib/ui/cn";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import {
  AutocompleteKbd,
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./ui/Autocomplete";

const statusDotBaseClass = "h-[6px] w-[6px] shrink-0 rounded-full";

// Static map — never a `data-[status=waiting_for_input]` arbitrary variant
// (Tailwind rewrites the `_` to a space in the selector, silently breaking it).
const statusDotToneClass: Partial<Record<ConversationStatus, string>> = {
  running: "bg-cyan shadow-[0_0_4px_var(--cyan-glow)]",
  waiting_for_input: "bg-amber shadow-[0_0_4px_var(--amber-glow)]",
};

export interface ConversationAutocompleteListItem {
  id: string;
  displayLabel: string;
  matchIndices: number[];
  projectName: string;
  sessionName: string;
  backend: "claude" | "codex";
  /** Optional sub-row label; rendered only when set. */
  model: string | null;
  /** Pre-rendered relative time string, e.g. "8m", "2h", "1d". */
  lastActivityRelative: string;
  status: ConversationStatus;
  isCurrentProject: boolean;
  archived: boolean;
  /** Shows the fresh-compaction badge (design §12.4). */
  compactFresh?: boolean;
}

export interface ConversationAutocompleteListProps {
  items: ConversationAutocompleteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: ConversationAutocompleteListItem) => void;
  totalCount: number;
  loading: boolean;
  error: string | null;
  includeArchived: boolean;
  onToggleArchived: () => void;
}

export function ConversationAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  totalCount,
  loading,
  error,
  includeArchived,
  onToggleArchived,
}: ConversationAutocompleteListProps) {
  const displayCount = items.length;
  const hasMore = totalCount > displayCount;
  const countLabel = hasMore
    ? `${displayCount} of ${totalCount}`
    : `${displayCount} ${displayCount === 1 ? "conversation" : "conversations"}`;

  return (
    <AutocompleteListbox
      label="Conversations"
      activeIndex={selectedIndex}
      maxHeightClassName="max-h-[380px]"
      loading={loading}
      loadingLabel="Loading conversations..."
      error={error}
      isEmpty={items.length === 0}
      empty="No matching conversations"
      header={
        <div className={cn(autocompleteHeaderClass, "gap-sm")}>
          <span>Conversations — current project first</span>
          <span className="flex items-center gap-sm">
            <span className={autocompleteHeaderCountClass}>{countLabel}</span>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-[4px] rounded-full border border-solid border-border-default bg-transparent px-[8px] py-[2px] font-mono text-[0.7rem] text-text-tertiary transition-[border-color,color,background] duration-150 ease-[ease] aria-pressed:border-amber-dim aria-pressed:text-amber [&[aria-pressed=false]]:hover:border-border-strong [&[aria-pressed=false]]:hover:text-text-secondary"
              aria-pressed={includeArchived}
              onClick={onToggleArchived}
            >
              Archived
            </button>
          </span>
        </div>
      }
      footer={
        <AutocompleteNavFooter
          layoutClassName="max-768:hidden"
          extra={
            <span>
              <AutocompleteKbd>Alt+A</AutocompleteKbd> archived
            </span>
          }
        />
      }
    >
      {items.map((item, i) => (
        <ConversationRow
          key={item.id}
          id={`conversation-autocomplete-option-${i}`}
          item={item}
          active={i === selectedIndex}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item)}
        />
      ))}
    </AutocompleteListbox>
  );
}

interface ConversationRowProps {
  id: string;
  item: ConversationAutocompleteListItem;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}

function ConversationRow({
  id,
  item,
  active,
  onHover,
  onSelect,
}: ConversationRowProps) {
  const showDot =
    item.status === "running" || item.status === "waiting_for_input";

  const projectLabel = item.isCurrentProject ? "current" : item.projectName;

  return (
    <AutocompleteOption
      id={id}
      variant="conversation"
      active={active}
      archived={item.archived}
      onHover={onHover}
      onSelect={onSelect}
    >
      <div className="relative z-raised flex items-center gap-xs text-[0.82rem] text-text-primary">
        {showDot && (
          <span
            data-status={item.status}
            className={cn(statusDotBaseClass, statusDotToneClass[item.status])}
          />
        )}
        <AutocompleteMatchText
          text={item.displayLabel}
          indices={item.matchIndices}
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
        />
        {item.compactFresh && (
          <span
            title="Fresh compaction available"
            className="rounded-full bg-green-glow px-[5px] py-px text-[0.7rem] tracking-[0.04em] text-green uppercase"
          >
            compacted
          </span>
        )}
        {item.archived && (
          <span className="rounded-full bg-[var(--cc-white-a04)] px-[5px] py-px text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
            archived
          </span>
        )}
      </div>
      <div className="relative z-raised flex items-center gap-xs text-[0.72rem] text-text-secondary">
        <span className="inline-flex min-w-0 flex-1 items-center gap-[4px] overflow-hidden text-ellipsis whitespace-nowrap">
          <span className="text-text-tertiary">▸ </span>
          <span className="text-text-secondary">{projectLabel}</span>
          <span> · </span>
          <span className="text-text-tertiary">{item.sessionName}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-sm text-text-tertiary">
          <span
            data-backend={item.backend}
            className="text-[0.7rem] max-768:hidden"
          >
            {item.model ? `${item.backend} · ${item.model}` : item.backend}
          </span>
          <span className="text-[0.7rem] max-768:hidden">
            {item.lastActivityRelative}
          </span>
        </span>
      </div>
    </AutocompleteOption>
  );
}
