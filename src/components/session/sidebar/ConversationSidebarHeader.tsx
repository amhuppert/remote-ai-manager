"use client";

import { useCallback, type RefObject } from "react";
import { RadioGroup } from "radix-ui";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { IconButton } from "@/components/ui/IconButton";
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
  { value: "all", label: "All", title: "All conversations" },
  {
    value: "needs",
    label: "Needs Input",
    title: "Questions and approvals requiring your input",
  },
  {
    value: "running",
    label: "Running",
    title: "Conversations with running work",
  },
  {
    value: "unread",
    label: "Unread",
    title: "Conversations with unread results",
  },
  {
    value: "project",
    label: "Project",
    title: "Conversations in the current project",
  },
  { value: "session", label: "Session", title: "Only the current session" },
];

export default function ConversationSidebarHeader({
  counts,
  activeFilter,
  onFilterChange,
  searchInputRef,
}: Props): React.JSX.Element {
  const filter = useSidebarFilter();
  const setFilter = useSetSidebarFilter();
  const handleClear = useCallback(() => {
    setFilter("");
    searchInputRef?.current?.focus();
  }, [setFilter, searchInputRef]);
  return (
    <div className="@container flex flex-col gap-sm">
      <div className="flex min-h-[36px] items-center gap-sm rounded-md border border-solid border-border-default bg-bg-base px-sm text-text-secondary focus-within:border-cyan focus-within:shadow-[0_0_0_3px_var(--color-cyan-glow)] max-768:min-h-[44px]">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
        </svg>
        <input
          ref={searchInputRef}
          id="conversation-sidebar-search"
          name="conversation-search"
          type="text"
          placeholder="Find a conversation…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Search conversations"
          className="min-w-0 flex-1 border-0 bg-transparent py-sm font-mono text-[0.78rem] text-text-primary outline-0 placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
        />
        {filter.length > 0 ? (
          <WithTooltip label="Clear search">
            <IconButton aria-label="Clear search" onClick={handleClear}>
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="m4 4 8 8m0-8-8 8" />
              </svg>
            </IconButton>
          </WithTooltip>
        ) : (
          <span
            aria-hidden="true"
            className="font-mono text-[0.7rem] text-text-tertiary"
          >
            /
          </span>
        )}
      </div>
      <RadioGroup.Root
        value={activeFilter}
        onValueChange={(value) => {
          const option = FILTER_OPTIONS.find(
            (option) => option.value === value,
          );
          if (option) onFilterChange(option.value);
        }}
        orientation="horizontal"
        aria-label="Conversation status"
        className="grid grid-cols-3 @[480px]:grid-cols-[0.7fr_1.5fr_1fr_1fr_1fr_1fr] min-w-0 gap-2xs rounded-md border border-solid border-border-subtle bg-bg-base p-2xs"
      >
        {FILTER_OPTIONS.map((option) => (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            aria-label={`${option.label} ${counts[option.value]}`}
            title={option.title}
            className="group inline-flex min-h-[30px] min-w-0 whitespace-nowrap cursor-pointer items-center justify-center gap-xs rounded-sm border-0 bg-transparent px-xs font-mono text-[0.7rem] font-medium text-text-secondary transition-colors data-[state=checked]:bg-bg-raised data-[state=checked]:text-text-primary data-[state=unchecked]:hover:bg-bg-surface data-[state=unchecked]:hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
          >
            {option.label}
            <span className="tabular-nums group-data-[state=checked]:text-cyan">
              {counts[option.value]}
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
