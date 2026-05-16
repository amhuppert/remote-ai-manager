"use client";

import {
  useSidebarGroupBy,
  useSetSidebarGroupBy,
  useSidebarSessionFilter,
  useSetSidebarSessionFilter,
} from "@/stores/session-detail.store";
import type { SidebarGroupBy } from "@/stores/session-detail.store";

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
  const groupBy = useSidebarGroupBy();
  const setGroupBy = useSetSidebarGroupBy();
  const sessionFilter = useSidebarSessionFilter();
  const setSessionFilter = useSetSidebarSessionFilter();

  return (
    <div className="convo-sidebar-group-controls">
      <div className="convo-sidebar-group-row">
        <span className="convo-sidebar-group-label">{label}</span>
        <div
          className="convo-sidebar-group-switch"
          role="radiogroup"
          aria-label={label}
        >
          {GROUP_BY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              className={`convo-sidebar-group-option${groupBy === opt.value ? " active" : ""}`}
              onClick={() => setGroupBy(opt.value)}
              aria-checked={groupBy === opt.value}
            >
              {opt.value === "project" ? <FolderIcon /> : <SessionIcon />}
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      {sessionFilter !== null && (
        <button
          type="button"
          className="convo-sidebar-session-filter-chip"
          onClick={() => setSessionFilter(null)}
          aria-label={`Clear session filter (${sessionFilter.sessionName})`}
        >
          <span className="convo-sidebar-session-filter-chip__label">
            Session: {sessionFilter.sessionName}
          </span>
          <span
            className="convo-sidebar-session-filter-chip__close"
            aria-hidden="true"
          >
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
