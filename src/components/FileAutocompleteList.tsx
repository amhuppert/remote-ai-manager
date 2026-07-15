"use client";

import {
  FileAutocompleteListView,
  type FileAutocompleteRow,
} from "./FileAutocompleteListView";

export interface FileAutocompleteListItem {
  id: string;
  /** Relative file path (e.g. `src/lib/foo.ts`) */
  path: string;
  /** Indices in `path` to highlight as fuzzy-match hits */
  matchIndices?: number[];
  openable?: boolean;
}

export interface FileAutocompleteListProps {
  items: FileAutocompleteListItem[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: FileAutocompleteListItem) => void;
  onOpen?: (item: FileAutocompleteListItem) => void;
  /** Total before display capping; used for the `N of M` footer label */
  totalCount?: number;
  loading?: boolean;
  error?: string | null;
  /** Label rendered in the header showing the file source (e.g. "From project root"). */
  sourceLabel?: string;
  /** When true, the underlying scan was truncated by the server — flags the count. */
  truncated?: boolean;
}

/**
 * Grid-semantics file autocomplete used by the `@`-mention popup: rows carry a
 * secondary Markdown-open action, so the popup is `role="grid"` and each row is
 * `role="row"`. Selection state is owned by the host (`selectedIndex`). The
 * count/header/loading/error/empty/footer chrome and file-row projection are
 * owned by {@link FileAutocompleteListView}.
 */
export function FileAutocompleteList({
  items,
  selectedIndex,
  onHover,
  onSelect,
  onOpen,
  totalCount,
  loading,
  error,
  sourceLabel,
  truncated,
}: FileAutocompleteListProps) {
  const rows: FileAutocompleteRow[] = items;

  return (
    <FileAutocompleteListView
      items={rows}
      selectedIndex={selectedIndex}
      onHover={onHover}
      onSelect={(item) => onSelect(item)}
      onOpen={onOpen ? (item) => onOpen(item) : undefined}
      popupRole="grid"
      optionIdPrefix="file-autocomplete-list-option"
      totalCount={totalCount}
      loading={loading}
      error={error}
      sourceLabel={sourceLabel}
      truncated={truncated}
    />
  );
}
