"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { cn } from "@/lib/ui/cn";
import {
  autocompleteEmptyClass,
  autocompleteErrorClass,
  autocompleteFooterClass,
  autocompleteFooterKbdClass,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
  autocompleteItemClass,
  autocompleteListClass,
  autocompletePopupClass,
} from "./CommandAutocompleteList";
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
  const listRef = useRef<HTMLDivElement>(null);

  // Reset active index when items change (state-during-render pattern)
  const resetKey = items.length;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setActiveIndex(0);
  }

  // Scroll active item into view
  useEffect(() => {
    if (!visible) return;
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible]);

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
    <div className={cn(autocompletePopupClass, "max-h-[340px]")}>
      <div className={autocompleteHeaderClass}>
        <span>{sourceLabel ? `Files — ${sourceLabel}` : "Files"}</span>
        <span className={autocompleteHeaderCountClass}>
          {countLabel}
          {truncated ? " (truncated)" : ""}
        </span>
      </div>

      <div className={autocompleteListClass} ref={listRef}>
        {loading && (
          <div className={autocompleteEmptyClass}>Scanning files...</div>
        )}

        {error && <div className={autocompleteErrorClass}>{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className={autocompleteEmptyClass}>No matching files</div>
        )}

        {!loading &&
          !error &&
          items.map((scored, i) => (
            <div
              key={scored.item.path}
              data-active={i === activeIndex}
              className={autocompleteItemClass}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(scored.item.path)}
            >
              <FilePath path={scored.item.path} indices={scored.indices} />
              <FileExtBadge path={scored.item.path} />
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
