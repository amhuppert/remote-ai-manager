"use client";

import { useCallback, type RefObject } from "react";
import { cn } from "@/lib/ui/cn";
import {
  useSidebarFilter,
  useSetSidebarFilter,
} from "@/stores/session-detail.store";
import type { SidebarListFilter } from "@/features/session/sidebar/ConversationSidebar.helpers";

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
    <div className="flex flex-col gap-sm">
      <div className="flex h-[30px] items-center gap-sm rounded-sm border border-solid border-border-default bg-bg-surface px-[8px] text-text-tertiary focus-within:border-cyan-dim focus-within:shadow-[0_0_0_1px_var(--color-cyan-glow)]">
        <SearchIcon />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Filter conversations..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Search conversations"
          className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[0.78rem] text-text-primary outline-0 placeholder:text-text-tertiary"
        />
        {filter.length > 0 && (
          <button
            type="button"
            className="size-[18px] shrink-0 cursor-pointer rounded-sm border-0 bg-transparent font-mono text-[0.7rem] text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            onClick={handleClear}
            aria-label="Clear search"
            data-tooltip="Clear"
          >
            {"✕"}
          </button>
        )}
      </div>

      <div
        className="flex gap-[2px] rounded-sm border border-solid border-border-default bg-bg-surface p-[3px]"
        role="tablist"
      >
        {FILTER_OPTIONS.map((option) => {
          const active = activeFilter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              className={cn(
                "inline-flex h-[24px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-[4px] rounded-[3px] border-0 px-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.08em] uppercase max-768:min-h-[var(--touch-target-min)]",
                active
                  ? "bg-bg-elevated text-text-primary"
                  : "bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary",
              )}
              onClick={() => onFilterChange(option.value)}
              aria-selected={active}
              aria-label={`${option.label} ${counts[option.value]}`}
              title={option.title}
            >
              <span>{option.label}</span>
              <span
                className={cn(
                  "text-[0.7rem] font-semibold",
                  active ? "text-cyan" : "text-text-tertiary",
                )}
              >
                {counts[option.value]}
              </span>
            </button>
          );
        })}
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
