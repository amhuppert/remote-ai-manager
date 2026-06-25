"use client";

import { cn } from "@/lib/ui/cn";
import {
  AutocompleteListbox,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./ui/Autocomplete";

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
  return (
    <AutocompleteListbox
      label={headerLabel}
      activeIndex={selectedIndex}
      maxHeightClassName="max-h-[340px]"
      loading={loading}
      loadingLabel={`Loading ${headerLabel.toLowerCase()}...`}
      error={error}
      isEmpty={items.length === 0}
      empty={emptyLabel}
      header={
        <div className={autocompleteHeaderClass}>
          <span>{headerLabel}</span>
          <span className={autocompleteHeaderCountClass}>
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </div>
      }
      footer={<AutocompleteNavFooter />}
    >
      {items.map((item, i) => (
        <AutocompleteOption
          key={item.id}
          id={`command-autocomplete-option-${i}`}
          active={i === selectedIndex}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item)}
        >
          <AutocompleteMatchText
            text={item.name}
            indices={item.matchIndices ?? []}
            className="shrink-0 text-[0.8rem] whitespace-nowrap text-text-primary"
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
                item.badge === "skill" && "bg-[var(--cc-green-a12)] text-green",
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
        </AutocompleteOption>
      ))}
    </AutocompleteListbox>
  );
}
