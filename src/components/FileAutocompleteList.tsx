"use client";

import { useEffect, useRef } from "react";

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
}

export function FileAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  totalCount,
  loading,
  error,
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

  return (
    <div className="file-autocomplete">
      <div className="file-header">
        <span>Files</span>
        <span className="file-header-count">
          {hasMore
            ? `${displayCount} of ${totalCount}`
            : `${displayCount} ${displayCount === 1 ? "file" : "files"}`}
        </span>
      </div>

      <div className="file-list" ref={listRef}>
        {loading && <div className="file-loading">Scanning files...</div>}

        {error && <div className="file-error">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="file-empty">No matching files</div>
        )}

        {!loading &&
          !error &&
          items.map((item, i) => (
            <div
              key={item.id}
              className={`file-item${i === selectedIndex ? " active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(item)}
            >
              <FilePath path={item.path} indices={item.matchIndices ?? []} />
              <FileExtBadge path={item.path} />
            </div>
          ))}
      </div>

      <div className="file-footer">
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

function FilePath({ path, indices }: { path: string; indices: number[] }) {
  const lastSlash = path.lastIndexOf("/");
  const indexSet = new Set(indices);

  const chars: React.ReactNode[] = [];
  for (let i = 0; i < path.length; i++) {
    const isDir = i <= lastSlash;
    const isMatch = indexSet.has(i);

    let className = isDir ? "file-dir-char" : "file-name-char";
    if (isMatch) className += " file-match";

    chars.push(
      <span key={i} className={className}>
        {path[i]}
      </span>,
    );
  }

  return <span className="file-path">{chars}</span>;
}

function FileExtBadge({ path }: { path: string }) {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot <= lastSlash) return null;

  const ext = path.slice(lastDot);
  return <span className="file-ext">{ext}</span>;
}
