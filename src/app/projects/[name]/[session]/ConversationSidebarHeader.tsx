"use client";

import { useCallback, type RefObject } from "react";
import {
  useSidebarFilter,
  useSetSidebarFilter,
} from "@/stores/session-detail.store";
import type { SidebarListFilter } from "./ConversationSidebar.helpers";

interface Props {
  counts: Record<SidebarListFilter, number>;
  activeFilter: SidebarListFilter;
  onFilterChange: (value: SidebarListFilter) => void;
  /** Optional ref to the search input — used by parent to focus from a hotkey. */
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

const FILTER_OPTIONS: {
  value: SidebarListFilter;
  label: string;
  title: string;
}[] = [
  { value: "all", label: "All", title: "All active conversations" },
  { value: "needs", label: "Needs", title: "Conversations awaiting Alex" },
  { value: "running", label: "Run", title: "Currently running conversations" },
  {
    value: "session",
    label: "Session",
    title: "Only conversations in the current session",
  },
];

export default function ConversationSidebarHeader({
  counts,
  activeFilter,
  onFilterChange,
  searchInputRef,
}: Props): React.JSX.Element {
  const filter = useSidebarFilter();
  const setFilter = useSetSidebarFilter();

  const handleClear = useCallback(() => setFilter(""), [setFilter]);

  return (
    <div className="convo-sidebar-controls">
      <div className="convo-sidebar-search">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Filter conversations..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Search conversations"
        />
        {filter.length > 0 && (
          <button
            type="button"
            className="convo-sidebar-search-clear"
            onClick={handleClear}
            aria-label="Clear search"
            data-tooltip="Clear"
          >
            {"\u2715"}
          </button>
        )}
      </div>

      <div className="convo-sidebar-filter-tabs" role="tablist">
        {FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            className={`convo-sidebar-filter-tab${activeFilter === option.value ? " active" : ""}`}
            onClick={() => onFilterChange(option.value)}
            aria-selected={activeFilter === option.value}
            aria-label={`${option.label} ${counts[option.value]}`}
            title={option.title}
          >
            <span>{option.label}</span>
            <span className="convo-sidebar-filter-count">
              {counts[option.value]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.4"
      />
    </svg>
  );
}
