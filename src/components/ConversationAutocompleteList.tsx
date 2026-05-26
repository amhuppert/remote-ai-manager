"use client";

import { useEffect, useRef } from "react";
import type { ConversationStatus } from "@/lib/conversations/schemas";

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
    <div className="conversation-autocomplete">
      <div className="conversation-header">
        <span>Conversations — current project first</span>
        <span className="conversation-header-cluster">
          <span className="conversation-header-count">{countLabel}</span>
          <button
            type="button"
            className="conversation-header-toggle"
            aria-pressed={includeArchived}
            onClick={onToggleArchived}
          >
            Archived
          </button>
        </span>
      </div>

      <div className="conversation-list" ref={listRef}>
        {loading && (
          <div className="conversation-loading">Loading conversations...</div>
        )}

        {error && !loading && <div className="conversation-error">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="conversation-empty">No matching conversations</div>
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

      <div className="conversation-footer">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> select
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
        <span>
          <kbd>Alt+A</kbd> archived
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
  const classes = ["conversation-item"];
  if (active) classes.push("active");
  if (item.archived) classes.push("conversation-item--archived");

  const showDot =
    item.status === "running" || item.status === "waiting_for_input";

  const projectLabel = item.isCurrentProject ? "current" : item.projectName;

  return (
    <div
      className={classes.join(" ")}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <div className="conversation-item__main">
        {showDot && (
          <span
            className="conversation-item__status-dot"
            data-status={item.status}
          />
        )}
        <HighlightedLabel
          label={item.displayLabel}
          indices={item.matchIndices}
        />
        {item.archived && (
          <span className="conversation-item__archived-badge">archived</span>
        )}
      </div>
      <div className="conversation-item__sub">
        <span className="conversation-item__sub-left">
          <span className="conversation-item__caret">▸ </span>
          <span className="conversation-item__project">{projectLabel}</span>
          <span className="conversation-item__sep"> · </span>
          <span className="conversation-item__session">{item.sessionName}</span>
        </span>
        <span className="conversation-item__sub-right">
          <span
            className="conversation-item__backend"
            data-backend={item.backend}
          >
            {item.model ? `${item.backend} · ${item.model}` : item.backend}
          </span>
          <span className="conversation-item__time">
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
  if (indices.length === 0) {
    return <span className="conversation-item__label">{label}</span>;
  }
  const indexSet = new Set(indices);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < label.length; i++) {
    if (indexSet.has(i)) {
      parts.push(
        <span key={i} className="conversation-match">
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
  return <span className="conversation-item__label">{parts}</span>;
}
