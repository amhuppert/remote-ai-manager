"use client";

import { useMemo } from "react";
import type {
  SessionListItem,
  DerivedSessionStatus,
} from "@/lib/sessions/schemas";
import { cn } from "@/lib/ui/cn";
import CCCheckbox from "./CCCheckbox";
import SessionRow, { ROW_BASE } from "./SessionRow";

type SortableColumn =
  | "sessionName"
  | "branchName"
  | "targetBranch"
  | "status"
  | "promptCount"
  | "lastActivityAt";

export interface SortState {
  id: SortableColumn;
  desc: boolean;
}

const STATUS_ORDER: DerivedSessionStatus[] = [
  "new",
  "running",
  "awaiting",
  "waiting_for_input",
  "idle",
];

function statusSortKey(s: SessionListItem): number {
  if (s.finished) return STATUS_ORDER.length;
  return STATUS_ORDER.indexOf(s.derivedStatus);
}

function compareSessions(
  a: SessionListItem,
  b: SessionListItem,
  sort: SortState,
): number {
  const dir = sort.desc ? -1 : 1;
  switch (sort.id) {
    case "status":
      return (statusSortKey(a) - statusSortKey(b)) * dir;
    case "promptCount":
      return (a.promptCount - b.promptCount) * dir;
    case "lastActivityAt":
      return (
        (Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt)) * dir
      );
    case "sessionName":
      return a.sessionName.localeCompare(b.sessionName) * dir;
    case "branchName":
      return a.branchName.localeCompare(b.branchName) * dir;
    case "targetBranch":
      return a.targetBranch.localeCompare(b.targetBranch) * dir;
  }
}

function SortIndicator({
  active,
  desc,
}: {
  active: boolean;
  desc: boolean;
}): React.JSX.Element {
  return (
    <svg
      className={cn(
        "inline-block shrink-0 -translate-y-px transition-[color,filter] duration-[120ms] ease-[ease] [&_polygon]:fill-current",
        active
          ? "text-cyan [filter:drop-shadow(0_0_4px_var(--color-cyan-glow-text))]"
          : "text-text-tertiary group-hover:text-text-secondary",
      )}
      viewBox="0 0 10 11"
      width={8}
      height={9}
      aria-hidden="true"
    >
      <polygon
        className={active && desc ? "opacity-30" : undefined}
        points="5,0 0,4 10,4"
      />
      <polygon
        className={active && !desc ? "opacity-30" : undefined}
        points="0,7 10,7 5,11"
      />
    </svg>
  );
}

interface SortableHeaderProps {
  id: SortableColumn;
  label: string;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  align?: "left" | "right";
}

function SortableHeader({
  id,
  label,
  sort,
  onSortChange,
  align = "left",
}: SortableHeaderProps) {
  const active = sort.id === id;
  return (
    <button
      type="button"
      className={cn(
        "group inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-mono text-[0.72rem] leading-none font-semibold tracking-[0.08em] uppercase transition-[color] duration-[120ms] ease-[ease]",
        align === "right" ? "justify-self-end" : "justify-self-start",
        active ? "text-cyan" : "text-text-tertiary hover:text-text-primary",
      )}
      onClick={() => onSortChange({ id, desc: active ? !sort.desc : false })}
    >
      <span>{label}</span>
      <SortIndicator active={active} desc={sort.desc} />
    </button>
  );
}

export interface SessionRowsProps {
  sessions: SessionListItem[];
  projectName: string;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  selection: Set<string>;
  onToggleSelect: (sessionName: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  onBranch?: (sessionName: string) => void;
}

export default function SessionRows({
  sessions,
  projectName,
  sort,
  onSortChange,
  selection,
  onToggleSelect,
  onToggleAll,
  onBranch,
}: SessionRowsProps): React.JSX.Element {
  const sorted = useMemo(() => {
    const arr = [...sessions];
    arr.sort((a, b) => compareSessions(a, b, sort));
    return arr;
  }, [sessions, sort]);

  const visibleNames = useMemo(
    () => sorted.map((s) => s.sessionName),
    [sorted],
  );
  const visibleSelectedCount = visibleNames.filter((n) =>
    selection.has(n),
  ).length;
  const allVisibleSelected =
    visibleNames.length > 0 && visibleSelectedCount === visibleNames.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  return (
    <div className="mx-xl flex flex-col border-x-0 border-t border-b-0 border-solid border-border-subtle max-768:mx-md">
      <div className={cn(ROW_BASE, "bg-bg-base max-768:hidden")} role="row">
        <span className="invisible absolute top-0 bottom-0 left-0 w-[3px]" />
        <span className="ml-[16px]">
          <CCCheckbox
            checked={allVisibleSelected}
            indeterminate={someVisibleSelected}
            onChange={onToggleAll}
            ariaLabel="Select all sessions"
          />
        </span>
        <span />
        <SortableHeader
          id="sessionName"
          label="Session"
          sort={sort}
          onSortChange={onSortChange}
        />
        <SortableHeader
          id="branchName"
          label="Branch"
          sort={sort}
          onSortChange={onSortChange}
        />
        <SortableHeader
          id="targetBranch"
          label="Target"
          sort={sort}
          onSortChange={onSortChange}
        />
        <SortableHeader
          id="status"
          label="Status"
          sort={sort}
          onSortChange={onSortChange}
        />
        <SortableHeader
          id="promptCount"
          label="Prompts"
          sort={sort}
          onSortChange={onSortChange}
          align="right"
        />
        <SortableHeader
          id="lastActivityAt"
          label="Last Activity"
          sort={sort}
          onSortChange={onSortChange}
          align="right"
        />
        <span />
      </div>
      {sorted.map((s) => (
        <SessionRow
          key={s.sessionName}
          session={s}
          projectName={projectName}
          selected={selection.has(s.sessionName)}
          onToggleSelect={onToggleSelect}
          onBranch={onBranch}
        />
      ))}
    </div>
  );
}
