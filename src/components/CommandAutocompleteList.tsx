"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Item shape consumed by the presentational command/skill popup. The
 * surrounding host (Tiptap suggestion render callback) decides how items
 * are sourced, scored, and labelled.
 */
export interface CommandAutocompleteListItem {
  id: string;
  /** Short label rendered prominently (e.g. `/spec-init`) */
  name: string;
  /** Secondary description text */
  description?: string;
  /** Right-aligned badge text (e.g. `command`, `skill`) */
  badge?: string;
  /** Tertiary source label (e.g. `user`, `project`) */
  source?: string;
  /** Indices in `name` to highlight as fuzzy-match hits */
  matchIndices?: number[];
}

export interface CommandAutocompleteListProps {
  items: CommandAutocompleteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: CommandAutocompleteListItem) => void;
  /** Header label (e.g. `Commands`, `Skills`, `Features`) */
  headerLabel: string;
  emptyLabel: string;
  loading?: boolean;
  error?: string | null;
}

export function CommandAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  headerLabel,
  emptyLabel,
  loading,
  error,
}: CommandAutocompleteListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[selectedIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div className="cmd-autocomplete">
      <div className="cmd-header">
        <span>{headerLabel}</span>
        <span className="cmd-header-count">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="cmd-list" ref={listRef}>
        {loading && (
          <div className="cmd-loading">
            Loading {headerLabel.toLowerCase()}...
          </div>
        )}

        {error && <div className="cmd-error">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="cmd-empty">{emptyLabel}</div>
        )}

        {!loading &&
          !error &&
          items.map((item, i) => (
            <div
              key={item.id}
              className={`cmd-item${i === selectedIndex ? " active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(item)}
            >
              <HighlightedName
                name={item.name}
                indices={item.matchIndices ?? []}
              />
              {item.description !== undefined && (
                <span className="cmd-desc">{item.description}</span>
              )}
              {item.badge !== undefined && (
                <span className="cmd-badge" data-type={item.badge}>
                  {item.badge}
                </span>
              )}
              {item.source !== undefined && (
                <span className="cmd-source">{item.source}</span>
              )}
            </div>
          ))}
      </div>

      <div className="cmd-footer">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> select
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  );
}

function HighlightedName({
  name,
  indices,
}: {
  name: string;
  indices: number[];
}) {
  if (indices.length === 0) return <span className="cmd-name">{name}</span>;
  const indexSet = new Set(indices);
  const chars: React.ReactNode[] = [];
  for (let i = 0; i < name.length; i++) {
    if (indexSet.has(i)) {
      chars.push(
        <span key={i} className="cmd-match">
          {name[i]}
        </span>,
      );
    } else {
      chars.push(<span key={i}>{name[i]}</span>);
    }
  }
  return <span className="cmd-name">{chars}</span>;
}

/**
 * Hook helper for the suggestion popup's selectedIndex bookkeeping. Resets
 * to 0 when the items list changes (state-during-render pattern).
 */
export function useSelectedIndex(itemsKey: number | string): {
  selectedIndex: number;
  setSelectedIndex: (i: number) => void;
} {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prevKey, setPrevKey] = useState(itemsKey);
  if (prevKey !== itemsKey) {
    setPrevKey(itemsKey);
    setSelectedIndex(0);
  }
  return { selectedIndex, setSelectedIndex };
}
