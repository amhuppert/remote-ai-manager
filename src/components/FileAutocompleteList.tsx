"use client";

import {
  AutocompleteListbox,
  AutocompleteNavFooter,
  AutocompleteOption,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./ui/Autocomplete";

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
  const displayCount = items.length;
  const hasMore = totalCount != null && totalCount > displayCount;
  const countLabel = hasMore
    ? `${displayCount} of ${totalCount}`
    : `${displayCount} ${displayCount === 1 ? "file" : "files"}`;

  return (
    <AutocompleteListbox
      label={sourceLabel ? `Files — ${sourceLabel}` : "Files"}
      activeIndex={selectedIndex}
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
      {items.map((item, i) => (
        <AutocompleteOption
          key={item.id}
          id={`file-autocomplete-list-option-${i}`}
          active={i === selectedIndex}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item)}
        >
          <FilePath path={item.path} indices={item.matchIndices ?? []} />
          <FileExtBadge path={item.path} />
        </AutocompleteOption>
      ))}
    </AutocompleteListbox>
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
