"use client";

import { useEffect, useRef } from "react";
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

export interface FileAutocompleteListItem {
  id: string;
  /** Relative file path (e.g. `src/lib/foo.ts`) */
  path: string;
  /** Indices in `path` to highlight as fuzzy-match hits */
  matchIndices?: number[];
}

export interface FileAutocompleteListProps {
  items: FileAutocompleteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: FileAutocompleteListItem) => void;
  /** Total before display capping; used for the `N of M` footer label */
  totalCount?: number;
  loading?: boolean;
  error?: string | null;
  /** Label rendered in the header showing the file source (e.g. "From project root"). */
  sourceLabel?: string;
  /** When true, the underlying scan was truncated by the server — flags the count. */
  truncated?: boolean;
}

export function FileAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  totalCount,
  loading,
  error,
  sourceLabel,
  truncated,
}: FileAutocompleteListProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[selectedIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

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
          items.map((item, i) => (
            <div
              key={item.id}
              data-active={i === selectedIndex}
              className={autocompleteItemClass}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(item)}
            >
              <FilePath path={item.path} indices={item.matchIndices ?? []} />
              <FileExtBadge path={item.path} />
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

/** Directory chars dimmed, filename chars bright; matched indices override to cyan. */
export const filePathClass =
  "flex-1 min-w-0 overflow-hidden text-[0.8rem] text-ellipsis whitespace-nowrap";

/** One color utility per char (never two — Tailwind orders color utils by palette, not source). */
export function fileCharClass(isDir: boolean, isMatch: boolean): string {
  if (isMatch) return "text-cyan";
  return isDir ? "text-text-secondary" : "text-text-primary";
}

export const fileExtBadgeClass =
  "shrink-0 rounded-full bg-[var(--cc-cyan-a08)] px-[6px] py-px text-[0.7rem] whitespace-nowrap text-text-tertiary max-768:hidden";

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

function FileExtBadge({ path }: { path: string }) {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot <= lastSlash) return null;

  const ext = path.slice(lastDot);
  return <span className={fileExtBadgeClass}>{ext}</span>;
}
