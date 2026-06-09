"use client";

import { useCallback, useMemo, useState } from "react";
import { CloseIcon } from "@/components/icons";
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
import "./styles/cockpit.css";

export interface SessionsPanelProps {
  projectName: string;
  sessions: SessionListItem[];
  /** Shared filter-token state (also driven by the composer's filter mode). */
  tokens: FilterToken[];
  onTokensChange: (next: FilterToken[]) => void;
  onBranch?: (sessionName: string) => void;
}

/**
 * The cockpit's sessions column (and the full-width first-run table): a
 * dedicated plain-text search (name/branch) + a filter popover sharing one
 * token state with the composer, active-token chips with per-chip remove and
 * clear-all, the existing `SessionRows` table, and empty-results messaging that
 * distinguishes a search term from a filter.
 */
export default function SessionsPanel({
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
    <div className="plc-sessions">
      <div className="plc-sessions-header">
        <div className="plc-sessions-searchrow">
          <input
            type="search"
            className="plc-sessions-search"
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
          <div className="plc-chips">
            {tokens.map((token) => (
              <span key={`${token.cat}:${token.value}`} className="plc-chip">
                {token.key}:{token.value}
                <button
                  type="button"
                  className="plc-chip-remove"
                  aria-label={`Remove ${token.key}:${token.value} filter`}
                  onClick={() => removeToken(token)}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            ))}
            <button
              type="button"
              className="plc-chip-clear"
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

      <div className="plc-sessions-body">
        {noSessionsAtAll ? (
          <div className="empty-state">
            <div className="empty-state-title">No sessions yet</div>
            <div className="empty-state-desc">
              Create a session to start working in this project.
            </div>
          </div>
        ) : emptyAfterFilter ? (
          <div className="empty-state">
            <div className="empty-state-title">No sessions match</div>
            <div className="empty-state-desc">
              {hasSearch && hasTokens
                ? `Nothing matches “${search}” with the active filters.`
                : hasSearch
                  ? `Nothing matches “${search}”.`
                  : "Nothing matches the active filters."}
            </div>
          </div>
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
