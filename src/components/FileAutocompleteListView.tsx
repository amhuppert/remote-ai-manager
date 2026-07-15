"use client";

import {
  AutocompleteListbox,
  AutocompleteNavFooter,
  AutocompleteOption,
  AutocompleteKbd,
  autocompleteHeaderClass,
  autocompleteHeaderCountClass,
} from "./ui/Autocomplete";
import { IconButton } from "./ui/IconButton";
import { WithTooltip } from "./ui/WithTooltip";

/**
 * The single owner of the file-autocomplete popup body: count/header,
 * loading/error/empty states, footer key hints, and file-row projection
 * (`FilePath` + `FileExtBadge`). Both file-mention surfaces render through this
 * one module so their labels, `N of M`/`N files` count semantics, truncation
 * flag, and ARIA roles cannot drift.
 *
 * The two surfaces differ only in three axes, all parameterized here:
 *   - selected-index ownership — the caller passes `selectedIndex`; the listbox
 *     host owns index state internally, the grid host threads it from a hook.
 *   - popup semantics — `listbox`/`option` (single-action choices) vs
 *     `grid`/`row` (rows with a secondary Open control), via {@link popupRole}.
 *   - optional per-row open action — {@link onOpen} enables the trailing
 *     Markdown-open `IconButton` and the `Alt+Enter open` footer hint; omitted
 *     for the create-session surface.
 *
 * Trigger-specific keyboard adaptation (arrow/enter/tab/escape/alt-enter) stays
 * in each host and drives `selectedIndex`/`onSelect`/`onOpen`.
 */
export interface FileAutocompleteRow {
  /** Stable key + `aria-activedescendant` target for this row. */
  id: string;
  /** Relative file path (e.g. `src/lib/foo.ts`). */
  path: string;
  /** Indices in `path` to highlight as fuzzy-match hits. */
  matchIndices?: number[];
  /** When true (and {@link FileAutocompleteListViewProps.onOpen} is set), the
   *  trailing Markdown-open action renders for this row. */
  openable?: boolean;
}

export interface FileAutocompleteListViewProps {
  items: FileAutocompleteRow[];
  /** Index of the active/highlighted row. */
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: FileAutocompleteRow, index: number) => void;
  /** Enables the per-row Open action and the `Alt+Enter open` footer hint. */
  onOpen?: (item: FileAutocompleteRow, index: number) => void;
  /** Popup ARIA semantics; `grid` is required when a row has a secondary control. */
  popupRole?: "listbox" | "grid";
  /**
   * Prefix for each row's DOM id, disambiguating the two surfaces' options in
   * the same document (`file-autocomplete-option` vs `file-autocomplete-list-option`).
   */
  optionIdPrefix: string;
  /** Total before display capping; used for the `N of M` count label. */
  totalCount?: number;
  loading?: boolean;
  error?: string | null;
  /** Label rendered in the header showing the file source (e.g. "From project root"). */
  sourceLabel?: string;
  /** When true, the underlying scan was truncated by the server — flags the count. */
  truncated?: boolean;
}

export function FileAutocompleteListView({
  items,
  selectedIndex,
  onHover,
  onSelect,
  onOpen,
  popupRole = "listbox",
  optionIdPrefix,
  totalCount,
  loading,
  error,
  sourceLabel,
  truncated,
}: FileAutocompleteListViewProps) {
  const label = sourceLabel ? `Files — ${sourceLabel}` : "Files";
  const displayCount = items.length;
  const hasMore = totalCount != null && totalCount > displayCount;
  const countLabel = hasMore
    ? `${displayCount} of ${totalCount}`
    : `${displayCount} ${displayCount === 1 ? "file" : "files"}`;
  const isGrid = popupRole === "grid";
  const openEnabled = onOpen !== undefined;

  return (
    <AutocompleteListbox
      label={label}
      popupRole={popupRole}
      activeIndex={selectedIndex}
      maxHeightClassName="max-h-[340px]"
      loading={loading}
      loadingLabel="Scanning files..."
      error={error}
      isEmpty={items.length === 0}
      empty="No matching files"
      header={
        <div className={autocompleteHeaderClass}>
          <span>{label}</span>
          <span className={autocompleteHeaderCountClass}>
            {countLabel}
            {truncated ? " (truncated)" : ""}
          </span>
        </div>
      }
      footer={
        <AutocompleteNavFooter
          extra={
            openEnabled && items.some((item) => item.openable) ? (
              <span>
                <AutocompleteKbd>Alt+Enter</AutocompleteKbd> open
              </span>
            ) : null
          }
        />
      }
    >
      {items.map((item, i) => (
        <AutocompleteOption
          key={item.id}
          id={`${optionIdPrefix}-${i}`}
          semanticRole={isGrid ? "row" : "option"}
          active={i === selectedIndex}
          onHover={() => onHover(i)}
          onSelect={() => onSelect(item, i)}
        >
          {isGrid ? (
            <>
              <div
                role="gridcell"
                className="relative z-raised flex min-w-0 flex-1 items-center gap-sm"
              >
                <FilePath path={item.path} indices={item.matchIndices ?? []} />
                <FileExtBadge path={item.path} />
              </div>
              <div
                role="gridcell"
                className="relative z-raised ml-auto shrink-0"
              >
                {item.openable && onOpen ? (
                  <WithTooltip label="Open in Markdown viewer">
                    <IconButton
                      type="button"
                      aria-label={`Open ${item.path} in Markdown viewer`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpen(item, i);
                      }}
                    >
                      <OpenFileIcon />
                    </IconButton>
                  </WithTooltip>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <FilePath path={item.path} indices={item.matchIndices ?? []} />
              <FileExtBadge path={item.path} />
            </>
          )}
        </AutocompleteOption>
      ))}
    </AutocompleteListbox>
  );
}

function OpenFileIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      <path
        d="M14 3v5h5M13 11l7-7m-5 0h5v5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
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

/**
 * Renders a file path with directory chars dimmed and filename chars bright.
 * Matched character indices are highlighted in cyan. Shared by both file
 * autocomplete surfaces (listbox and grid).
 */
export function FilePath({
  path,
  indices,
}: {
  path: string;
  indices: number[];
}) {
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

/** Renders a small extension badge (e.g., .tsx, .css) at the row's trailing edge. */
export function FileExtBadge({ path }: { path: string }) {
  const lastDot = path.lastIndexOf(".");
  const lastSlash = path.lastIndexOf("/");
  if (lastDot <= lastSlash) return null;

  const ext = path.slice(lastDot);
  return <span className={fileExtBadgeClass}>{ext}</span>;
}
