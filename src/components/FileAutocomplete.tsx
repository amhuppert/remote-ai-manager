"use client";

import { useState, useCallback, useImperativeHandle, forwardRef } from "react";
import {
  FileAutocompleteListView,
  type FileAutocompleteRow,
} from "./FileAutocompleteListView";

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

  const rows: FileAutocompleteRow[] = items.map((scored) => ({
    id: scored.item.path,
    path: scored.item.path,
    matchIndices: scored.indices,
  }));

  return (
    <FileAutocompleteListView
      items={rows}
      selectedIndex={activeIndex}
      onHover={setActiveIndex}
      onSelect={(item) => onSelect(item.path)}
      popupRole="listbox"
      optionIdPrefix="file-autocomplete-option"
      totalCount={totalCount}
      loading={loading}
      error={error}
      sourceLabel={sourceLabel}
      truncated={truncated}
    />
  );
});
