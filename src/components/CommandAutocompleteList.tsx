"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/ui/cn";

// ── Shared autocomplete-popup recipes (command / file families) ──
// Translucent surface backgrounds (--cc-surface-a85/a95), skill-badge green
// (--cc-green-a12), and cyan badge fills (--cc-cyan-a12/a08) are all token-backed.

/**
 * Floating popup shell: anchored above the prompt input, cyan accent line on top.
 * Caller appends its own `max-h-[…]` (340px for command/file, 380px for
 * conversation) — a single max-height utility avoids a same-property collision.
 */
export const autocompletePopupClass =
  "absolute inset-x-0 bottom-full z-header flex flex-col overflow-hidden rounded-t-lg border border-b-0 border-solid border-border-default bg-[var(--cc-surface-a85)] font-mono backdrop-blur-[20px] backdrop-saturate-150 animate-[cmdReveal_0.18s_ease] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--cyan)_20%,var(--cyan)_80%,transparent)] before:opacity-60 before:content-['']";

export const autocompleteHeaderClass =
  "sticky top-0 z-raised flex items-center justify-between border-x-0 border-t-0 border-b border-solid border-border-subtle bg-[var(--cc-surface-a95)] px-sm py-xs text-[0.7rem] text-text-tertiary";

export const autocompleteHeaderCountClass = "text-text-secondary";

export const autocompleteListClass =
  "flex-1 overflow-y-auto overscroll-contain";

/** Selectable row: left accent border + cyan glow when active; touch-sized on mobile. */
export const autocompleteItemClass =
  "relative flex min-h-[32px] cursor-pointer items-center gap-sm border-y-0 border-r-0 border-l-2 border-solid border-l-transparent px-sm py-xs transition-[background] duration-100 ease-[ease] hover:bg-bg-hover data-[active=true]:border-l-cyan data-[active=true]:bg-bg-hover data-[active=true]:after:pointer-events-none data-[active=true]:after:absolute data-[active=true]:after:inset-0 data-[active=true]:after:bg-[linear-gradient(90deg,var(--cyan-glow)_0%,transparent_60%)] data-[active=true]:after:content-[''] max-768:min-h-[44px] max-768:py-sm";

export const autocompleteFooterClass =
  "sticky bottom-0 z-raised flex items-center gap-md border-x-0 border-b-0 border-t border-solid border-border-subtle bg-[var(--cc-surface-a95)] px-sm py-xs text-[0.7rem] text-text-tertiary";

export const autocompleteFooterKbdClass =
  "inline-block rounded-sm border border-solid border-border-default bg-bg-raised px-[4px] py-0 font-mono text-[0.7rem] leading-[1.4] text-text-secondary";

export const autocompleteEmptyClass =
  "p-md text-center text-[0.75rem] text-text-tertiary";

export const autocompleteErrorClass =
  "px-md py-sm text-center text-[0.72rem] text-red";

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
    <div className={cn(autocompletePopupClass, "max-h-[340px]")}>
      <div className={autocompleteHeaderClass}>
        <span>{headerLabel}</span>
        <span className={autocompleteHeaderCountClass}>
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
      </div>

      <div className={autocompleteListClass} ref={listRef}>
        {loading && (
          <div className={autocompleteEmptyClass}>
            Loading {headerLabel.toLowerCase()}...
          </div>
        )}

        {error && <div className={autocompleteErrorClass}>{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className={autocompleteEmptyClass}>{emptyLabel}</div>
        )}

        {!loading &&
          !error &&
          items.map((item, i) => (
            <div
              key={item.id}
              data-active={i === selectedIndex}
              className={autocompleteItemClass}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(item)}
            >
              <HighlightedName
                name={item.name}
                indices={item.matchIndices ?? []}
              />
              {item.description !== undefined && (
                <span className="min-w-0 flex-1 overflow-hidden text-[0.72rem] text-ellipsis whitespace-nowrap text-text-secondary">
                  {item.description}
                </span>
              )}
              {item.badge !== undefined && (
                <span
                  data-type={item.badge}
                  className={cn(
                    "shrink-0 rounded-full px-[6px] py-px text-[0.7rem] tracking-[0.04em] whitespace-nowrap uppercase",
                    item.badge === "command" &&
                      "bg-[var(--cc-cyan-a12)] text-cyan-dim",
                    item.badge === "skill" &&
                      "bg-[var(--cc-green-a12)] text-green",
                  )}
                >
                  {item.badge}
                </span>
              )}
              {item.source !== undefined && (
                <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary max-768:hidden">
                  {item.source}
                </span>
              )}
            </div>
          ))}
      </div>

      <div className={autocompleteFooterClass}>
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
  const nameClass =
    "shrink-0 text-[0.8rem] whitespace-nowrap text-text-primary";
  if (indices.length === 0) return <span className={nameClass}>{name}</span>;
  const indexSet = new Set(indices);
  const chars: React.ReactNode[] = [];
  for (let i = 0; i < name.length; i++) {
    if (indexSet.has(i)) {
      chars.push(
        <span key={i} className="text-cyan">
          {name[i]}
        </span>,
      );
    } else {
      chars.push(<span key={i}>{name[i]}</span>);
    }
  }
  return <span className={nameClass}>{chars}</span>;
}
