"use client";

import { useState, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  AutocompleteListbox,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./ui/Autocomplete";
import {
  fileCharClass,
  fileExtBadgeClass,
  filePathClass,
} from "./FileAutocompleteList";

/** A file item from the project file index */
interface FileItem {
  /** Relative path from project root (e.g., "src/components/FileAutocomplete.tsx") */
  path: string;
}

/** A file item scored and annotated by fuzzy matching */
export interface ScoredFileItem {
  item: FileItem;
  tier: import("@/lib/shared/fuzzy").MatchTier;
  coverage: number;
  /** Character indices in the path that matched the query */
  indices: number[];
}

export interface FileAutocompleteHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

export interface FileAutocompleteProps {
  /** Filtered and scored file items to display */
  items: ScoredFileItem[];
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Whether data is loading */
  loading?: boolean;
  /** Error message if loading failed */
  error?: string | null;
  /** Total number of matches (before capping to display limit) */
  totalCount?: number;
  /** Label rendered in the header showing the file source (e.g. "From project root"). */
  sourceLabel?: string;
  /** When true, the underlying scan was truncated by the server. */
  truncated?: boolean;
  /** Called when a file is selected */
  onSelect: (path: string) => void;
  /** Called when the user presses Escape */
  onClose: () => void;
}

export const FileAutocomplete = forwardRef<
  FileAutocompleteHandle,
  FileAutocompleteProps
>(function FileAutocomplete(
  {
    items,
    visible,
    loading,
    error,
    totalCount,
    sourceLabel,
    truncated,
    onSelect,
    onClose,
  },
  ref,
) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset active index when items change (state-during-render pattern)
  const resetKey = items.length;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setActiveIndex(0);
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!visible) return false;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, items.length - 1));
          return true;
        }
        case "ArrowUp": {
          e.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          return true;
        }
        case "Enter":
        case "Tab": {
          e.preventDefault();
          const selected = items[activeIndex];
          if (selected) {
            onSelect(selected.item.path);
          }
          return true;
        }
        case "Escape": {
          e.preventDefault();
          onClose();
          return true;
        }
        default:
          return false;
      }
    },
    [visible, items, activeIndex, onSelect, onClose],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  if (!visible) return null;

  const displayCount = items.length;
  const hasMore = totalCount != null && totalCount > displayCount;
  const countLabel = hasMore
    ? `${displayCount} of ${totalCount}`
    : `${displayCount} ${displayCount === 1 ? "file" : "files"}`;

  return (
    <AutocompleteListbox
      label={sourceLabel ? `Files — ${sourceLabel}` : "Files"}
      activeIndex={activeIndex}
      maxHeightClassName="max-h-[340px]"
      loading={loading}
      loadingLabel="Scanning files..."
      error={error}
      isEmpty={items.length === 0}
      empty="No matching files"
      header={
        <div className={autocompleteHeaderClass}>
          <span>{sourceLabel ? `Files — ${sourceLabel}` : "Files"}</span>
          <span className={autocompleteHeaderCountClass}>
            {countLabel}
            {truncated ? " (truncated)" : ""}
          </span>
        </div>
      }
      footer={<AutocompleteNavFooter />}
    >
      {items.map((scored, i) => (
        <AutocompleteOption
          key={scored.item.path}
          id={`file-autocomplete-option-${i}`}
          active={i === activeIndex}
          onHover={() => setActiveIndex(i)}
          onSelect={() => onSelect(scored.item.path)}
        >
          <FilePath path={scored.item.path} indices={scored.indices} />
          <FileExtBadge path={scored.item.path} />
        </AutocompleteOption>
      ))}
    </AutocompleteListbox>
  );
});

/**
 * Renders a file path with directory chars dimmed and filename chars bright.
 * Matched character indices are highlighted in cyan.
 */
function FilePath({ path, indices }: { path: string; indices: number[] }) {
  const lastSlash = path.lastIndexOf("/");
  const indexSet = new Set(indices);

  const chars: React.ReactNode[] = [];
  for (let i = 0; i < path.length; i++) {
    const isDir = i <= lastSlash;
    const isMatch = indexSet.has(i);

    chars.push(
      <span key={i} className={fileCharClass(isDir, isMatch)}>
        {path[i]}
      </span>,
    );
  }

  return <span className={filePathClass}>{chars}</span>;
}

/** Renders a small extension badge (e.g., .tsx, .css) */
function FileExtBadge({ path }: { path: string }) {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot <= lastSlash) return null;

  const ext = path.slice(lastDot);
  return <span className={fileExtBadgeClass}>{ext}</span>;
}
