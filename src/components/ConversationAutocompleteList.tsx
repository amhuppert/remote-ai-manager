"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/ui/cn";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import {
  autocompleteEmptyClass,
  autocompleteErrorClass,
  autocompleteFooterClass,
  autocompleteFooterKbdClass,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
  autocompleteListClass,
  autocompletePopupClass,
} from "./CommandAutocompleteList";

// ── Conversation-row recipe (two-line layout, status dot, archived dim) ──

const conversationItemClass =
  "relative flex min-h-[40px] cursor-pointer flex-col gap-[2px] border-y-0 border-r-0 border-l-2 border-solid border-l-transparent px-sm py-xs transition-[background] duration-100 ease-[ease] hover:bg-bg-hover data-[active=true]:border-l-cyan data-[active=true]:bg-bg-hover data-[active=true]:after:pointer-events-none data-[active=true]:after:absolute data-[active=true]:after:inset-0 data-[active=true]:after:bg-[linear-gradient(90deg,var(--cyan-glow)_0%,transparent_60%)] data-[active=true]:after:content-[''] data-[archived=true]:opacity-50 max-768:min-h-[44px] max-768:py-sm";

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
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[selectedIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  const displayCount = items.length;
  const hasMore = totalCount > displayCount;
  const countLabel = hasMore
    ? `${displayCount} of ${totalCount}`
    : `${displayCount} ${displayCount === 1 ? "conversation" : "conversations"}`;

  return (
    <div className={cn(autocompletePopupClass, "max-h-[380px]")}>
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

      <div className={autocompleteListClass} ref={listRef}>
        {loading && (
          <div className={autocompleteEmptyClass}>Loading conversations...</div>
        )}

        {error && !loading && (
          <div className={autocompleteErrorClass}>{error}</div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className={autocompleteEmptyClass}>
            No matching conversations
          </div>
        )}

        {!loading &&
          !error &&
          items.map((item, i) => (
            <ConversationRow
              key={item.id}
              item={item}
              active={i === selectedIndex}
              onHover={() => onHover(i)}
              onSelect={() => onSelect(item)}
            />
          ))}
      </div>

      <div className={cn(autocompleteFooterClass, "max-768:hidden")}>
        <span>
          <kbd className={autocompleteFooterKbdClass}>↑</kbd>{" "}
          <kbd className={autocompleteFooterKbdClass}>↓</kbd> navigate
        </span>
        <span>
          <kbd className={autocompleteFooterKbdClass}>Enter</kbd> select
        </span>
        <span>
          <kbd className={autocompleteFooterKbdClass}>Esc</kbd> close
        </span>
        <span>
          <kbd className={autocompleteFooterKbdClass}>Alt+A</kbd> archived
        </span>
      </div>
    </div>
  );
}

interface ConversationRowProps {
  item: ConversationAutocompleteListItem;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}

function ConversationRow({
  item,
  active,
  onHover,
  onSelect,
}: ConversationRowProps) {
  const showDot =
    item.status === "running" || item.status === "waiting_for_input";

  const projectLabel = item.isCurrentProject ? "current" : item.projectName;

  return (
    <div
      data-active={active}
      data-archived={item.archived}
      className={conversationItemClass}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <div className="relative z-raised flex items-center gap-xs text-[0.82rem] text-text-primary">
        {showDot && (
          <span
            data-status={item.status}
            className={cn(statusDotBaseClass, statusDotToneClass[item.status])}
          />
        )}
        <HighlightedLabel
          label={item.displayLabel}
          indices={item.matchIndices}
        />
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
    </div>
  );
}

function HighlightedLabel({
  label,
  indices,
}: {
  label: string;
  indices: number[];
}) {
  const labelClass =
    "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap";
  if (indices.length === 0) {
    return <span className={labelClass}>{label}</span>;
  }
  const indexSet = new Set(indices);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < label.length; i++) {
    if (indexSet.has(i)) {
      parts.push(
        <span key={i} className="text-cyan">
          {label[i]}
        </span>,
      );
    } else {
      const last = parts[parts.length - 1];
      if (typeof last === "string") {
        parts[parts.length - 1] = last + label[i];
      } else {
        parts.push(label[i]);
      }
    }
  }
  return <span className={labelClass}>{parts}</span>;
}
