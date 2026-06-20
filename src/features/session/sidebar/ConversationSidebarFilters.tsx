"use client";

import { cn } from "@/lib/ui/cn";
import {
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import type { SidebarGroupBy } from "@/features/session/sidebar/ConversationSidebar.helpers";
import { useSidebarGroupByPersistent } from "@/features/session/hooks/use-sidebar-persistent-filters";

interface Props {
  /** Optional override label rendered before the segmented control. */
  label?: string;
}

const GROUP_BY_OPTIONS: { value: SidebarGroupBy; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "session", label: "Session" },
];

export default function ConversationSidebarFilters({
  label = "Group by",
}: Props): React.JSX.Element {
  const [groupBy, setGroupBy] = useSidebarGroupByPersistent();
  const sessionFilter = useSidebarSessionFilter();
  const setSessionFilter = useSetSidebarSessionFilter();

  return (
    <div className="flex flex-col gap-xs">
      <div className="flex min-w-0 items-center gap-sm">
        <span className="shrink-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          {label}
        </span>
        <div
          className="flex min-w-0 flex-1 items-center gap-[2px] rounded-sm border border-solid border-border-default bg-bg-surface p-[2px]"
          role="radiogroup"
          aria-label={label}
        >
          {GROUP_BY_OPTIONS.map((opt) => {
            const active = groupBy === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                className={cn(
                  "inline-flex h-[22px] min-w-0 flex-1 cursor-pointer items-center justify-center gap-[5px] rounded-[3px] border-0 px-[6px] font-mono text-[0.7rem] font-semibold tracking-[0.06em] uppercase max-768:min-h-[var(--touch-target-min)]",
                  active
                    ? "bg-bg-elevated text-text-primary [&_svg]:text-cyan"
                    : "bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                )}
                onClick={() => setGroupBy(opt.value)}
                aria-checked={active}
              >
                {opt.value === "project" ? <FolderIcon /> : <SessionIcon />}
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      {sessionFilter !== null && (
        <button
          type="button"
          className="inline-flex max-w-full cursor-pointer items-center gap-xs self-start rounded-full border border-solid border-border-subtle bg-bg-elevated px-sm py-[2px] font-mono text-[11px] text-text-secondary hover:border-cyan-dim hover:text-text-primary focus-visible:border-cyan-dim focus-visible:text-text-primary focus-visible:outline-none"
          onClick={() => setSessionFilter(null)}
          aria-label={`Clear session filter (${sessionFilter.sessionName})`}
        >
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            Session: {sessionFilter.sessionName}
          </span>
          <span className="text-[10px] opacity-[0.7]" aria-hidden="true">
            &#10005;
          </span>
        </button>
      )}
    </div>
  );
}

function FolderIcon(): React.JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 4.5a1 1 0 0 1 1-1h3L7.5 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.3"
      />
    </svg>
  );
}

function SessionIcon(): React.JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.3"
      >
        <circle cx="4" cy="3" r="1.4" />
        <circle cx="4" cy="13" r="1.4" />
        <circle cx="12" cy="6" r="1.4" />
        <path d="M4 4.4v7.2M4 8h5a3 3 0 0 0 3-3v2.4" />
      </g>
    </svg>
  );
}
