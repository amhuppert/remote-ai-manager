"use client";

import { useCallback, useMemo, useState } from "react";
import { CloseIcon } from "@/components/icons";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import type { SessionListItem } from "@/lib/sessions/schemas";
import { useBulkSessionsMutation } from "@/lib/sessions/mutations";
import { applyFilters } from "../components/apply-filters";
import SessionRows, { type SortState } from "../components/SessionRows";
import SectionHeader from "../components/SectionHeader";
import BulkConfirmModal, {
  type BulkConfirmKind,
} from "../components/BulkConfirmModal";
import {
  pruneMissingSelections,
  selectedBulkActionKind,
} from "../components/bulk-selection";
import type { FilterToken } from "../components/filter-tokens";
import SessionsFilterPopover from "./SessionsFilterPopover";

export interface SessionsPanelProps {
  id?: string;
  hidden?: boolean;
  projectName: string;
  sessions: SessionListItem[];
  /** Shared filter-token state (also driven by the composer's filter mode). */
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  onBranch?: (sessionName: string) => void;
}

// Grid `sessions` area in the cockpit; visible only in the sessions workspace
// view. On the ≤768px spine the cockpit becomes a single-panel flex column, so
// the panel hides unless sessions is the active view (data driven from the
// cockpit `group`). Desktop-first `max-768:` transcribes the legacy media rules.
const ROOT_CLASS =
  "[grid-area:sessions] flex flex-col min-h-0 min-w-0 h-full bg-bg-base overflow-hidden " +
  "group-data-[workspace-view=conversations]:hidden " +
  "max-768:hidden max-768:group-data-[workspace-view=sessions]:flex " +
  "max-768:group-data-[workspace-view=sessions]:flex-1 max-768:group-data-[workspace-view=sessions]:min-h-0";

const HEADER_CLASS =
  "flex flex-col gap-sm p-md border-x-0 border-t-0 border-b border-solid border-border-dim shrink-0";

const SEARCH_CLASS =
  "flex-1 min-w-0 bg-bg-surface border border-solid border-border-subtle rounded-md px-sm py-xs " +
  "text-text-primary font-mono text-[0.78rem] focus:outline-none focus:border-cyan " +
  "focus:shadow-[0_0_0_1px_var(--color-cyan-glow)]";

const CHIP_CLASS =
  "inline-flex items-center gap-2xs px-xs py-2xs rounded-full bg-amber-glow border border-solid " +
  "border-amber-glow text-amber font-mono text-[0.7rem]";

const CHIP_REMOVE_CLASS =
  "inline-flex border-0 bg-transparent text-inherit cursor-pointer p-0 leading-none";

const CHIP_CLEAR_CLASS =
  "border-0 bg-transparent text-text-tertiary font-mono text-[0.7rem] cursor-pointer hover:text-text-primary";

/**
 * The cockpit's sessions column (and the full-width first-run table): a
 * dedicated plain-text search (name/branch) + a filter popover sharing one
 * token state with the composer, active-token chips with per-chip remove and
 * clear-all, the existing `SessionRows` table, and empty-results messaging that
 * distinguishes a search term from a filter.
 */
export default function SessionsPanel({
  id,
  hidden,
  projectName,
  sessions,
  tokens,
  onTokensChange,
  onBranch,
}: SessionsPanelProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({
    id: "lastActivityAt",
    desc: true,
  });
  const [rawSelection, setSelection] = useState<Set<string>>(() => new Set());
  const [confirmKind, setConfirmKind] = useState<BulkConfirmKind | null>(null);
  const bulkMutation = useBulkSessionsMutation(projectName);

  // Drop selections for sessions that no longer exist (e.g. after a bulk
  // delete or an external removal); keeps the count and bulk op accurate.
  const selection = useMemo(
    () => pruneMissingSelections(rawSelection, sessions),
    [rawSelection, sessions],
  );

  const filtered = useMemo(
    () => applyFilters(sessions, tokens, search),
    [sessions, tokens, search],
  );

  const removeToken = useCallback(
    (token: FilterToken) =>
      onTokensChange(
        tokens.filter((t) => !(t.cat === token.cat && t.value === token.value)),
      ),
    [tokens, onTokensChange],
  );

  const handleToggleSelect = useCallback(
    (sessionName: string, next: boolean) =>
      setSelection((prev) => {
        const out = new Set(prev);
        if (next) out.add(sessionName);
        else out.delete(sessionName);
        return out;
      }),
    [],
  );

  const handleToggleAll = useCallback(
    (next: boolean) =>
      setSelection(() =>
        next ? new Set(filtered.map((s) => s.sessionName)) : new Set(),
      ),
    [filtered],
  );

  const bulkActionKind = selectedBulkActionKind(selection, sessions);

  const runBulkOp = useCallback(() => {
    if (confirmKind === null || selection.size === 0) return;
    bulkMutation.mutate(
      { op: confirmKind, sessionNames: [...selection] },
      {
        onSuccess: () => {
          setSelection(new Set());
          setConfirmKind(null);
        },
      },
    );
  }, [bulkMutation, confirmKind, selection]);

  const hasSearch = search.trim().length > 0;
  const hasTokens = tokens.length > 0;
  const noSessionsAtAll = sessions.length === 0;
  const emptyAfterFilter = !noSessionsAtAll && filtered.length === 0;

  return (
    <div
      id={id}
      className={ROOT_CLASS}
      role="tabpanel"
      aria-label="Sessions"
      hidden={hidden}
    >
      <div className={HEADER_CLASS}>
        <div className="flex gap-sm items-center">
          <input
            type="search"
            className={SEARCH_CLASS}
            placeholder="Search name or branch"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search sessions"
          />
          <SessionsFilterPopover
            tokens={tokens}
            onTokensChange={onTokensChange}
            sessions={sessions}
          />
        </div>
        {hasTokens && (
          <div className="flex flex-wrap gap-xs items-center">
            {tokens.map((token) => (
              <span key={`${token.cat}:${token.value}`} className={CHIP_CLASS}>
                {token.key}:{token.value}
                <button
                  type="button"
                  className={CHIP_REMOVE_CLASS}
                  aria-label={`Remove ${token.key}:${token.value} filter`}
                  onClick={() => removeToken(token)}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className={CHIP_CLEAR_CLASS}
              onClick={() => onTokensChange([])}
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {selection.size > 0 && (
        <SectionHeader
          filteredCount={filtered.length}
          tokenCount={tokens.length}
          selectionSize={selection.size}
          bulkActionKind={bulkActionKind}
          isBulkPending={bulkMutation.isPending}
          onClearFilters={() => onTokensChange([])}
          onDeselect={() => setSelection(new Set())}
          onBulkArchive={() => setConfirmKind("archive")}
          onBulkUnarchive={() => setConfirmKind("unarchive")}
          onBulkDelete={() => setConfirmKind("delete")}
        />
      )}

      <BulkConfirmModal
        open={confirmKind !== null}
        kind={confirmKind ?? "archive"}
        count={selection.size}
        isPending={bulkMutation.isPending}
        onConfirm={runBulkOp}
        onClose={() => setConfirmKind(null)}
      />

      <div className="flex-1 min-h-0 overflow-y-auto p-sm">
        {noSessionsAtAll ? (
          <EmptyState>
            <EmptyStateTitle>No sessions yet</EmptyStateTitle>
            <EmptyStateDesc>
              Create a session to start working in this project.
            </EmptyStateDesc>
          </EmptyState>
        ) : emptyAfterFilter ? (
          <EmptyState>
            <EmptyStateTitle>No sessions match</EmptyStateTitle>
            <EmptyStateDesc>
              {hasSearch && hasTokens
                ? `Nothing matches “${search}” with the active filters.`
                : hasSearch
                  ? `Nothing matches “${search}”.`
                  : "Nothing matches the active filters."}
            </EmptyStateDesc>
          </EmptyState>
        ) : (
          <SessionRows
            sessions={filtered}
            projectName={projectName}
            sort={sort}
            onSortChange={setSort}
            selection={selection}
            onToggleSelect={handleToggleSelect}
            onToggleAll={handleToggleAll}
            {...(onBranch ? { onBranch } : {})}
          />
        )}
      </div>
    </div>
  );
}
