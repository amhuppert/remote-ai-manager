"use client";

import { ChevronDownIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import {
  DEFAULT_TICKET_STATUSES,
  isDefaultTicketStatusSet,
  normalizeTicketStatusSet,
  type TicketListFilters,
} from "@/lib/tickets/list-filters";
import type { TicketStatus } from "@/lib/tickets/schemas";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "@/lib/tickets/ticket-visuals";
import { cn } from "@/lib/ui/cn";

// Radix Select item values must be non-empty, so the "no filter" choice is a
// sentinel that maps to null in the shared filter shape.
const ALL = "all";
const PROJECT_VALUE_PREFIX = "project:";

function projectOptionValue(projectName: string): string {
  return `${PROJECT_VALUE_PREFIX}${projectName}`;
}

const FILTER_CAPTION_CLASS =
  "font-mono text-[0.68rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

// Mirrors the canonical Select trigger recipe (ui/Select.tsx) — the status
// filter is a menu-button (multi-select), so the Select primitive cannot host
// it, but it must read as the third select in the row.
const STATUS_TRIGGER_CLASS = cn(
  "group inline-flex h-9 w-[170px] cursor-pointer items-center gap-[6px] rounded-md border border-solid px-3 font-mono text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 ease-[ease] outline-none max-768:h-[44px]",
  "border-border-default bg-bg-surface text-text-secondary",
  "data-[state=closed]:hover:border-border-strong data-[state=closed]:hover:bg-bg-hover data-[state=closed]:hover:text-text-primary",
  "data-[state=open]:border-cyan-dim data-[state=open]:text-text-primary data-[state=open]:shadow-[0_0_0_3px_var(--cyan-glow)]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]",
);

export interface TicketFiltersProps {
  filters: TicketListFilters;
  /** Every project that can be filtered to (derived from the full list). */
  projectOptions: readonly string[];
  shownCount: number;
  totalCount: number;
  /** Counts render only once both the filtered and full lists have loaded. */
  countsReady: boolean;
  onFiltersChange: (next: TicketListFilters) => void;
}

/** Whether any filter differs from the page defaults (open statuses). */
export function ticketFiltersActive(filters: TicketListFilters): boolean {
  return (
    filters.projectName !== null ||
    filters.workType !== null ||
    !isDefaultTicketStatusSet(filters.statuses)
  );
}

export function defaultTicketFilters(
  filters: TicketListFilters,
): TicketListFilters {
  return {
    ...filters,
    projectName: null,
    statuses: normalizeTicketStatusSet(DEFAULT_TICKET_STATUSES),
    workType: null,
  };
}

function statusFilterSummary(statuses: TicketListFilters["statuses"]): string {
  if (statuses === null) return "All statuses";
  if (isDefaultTicketStatusSet(statuses)) return "Open statuses";
  if (statuses.length === 1) return TICKET_STATUS_VISUALS[statuses[0]!].label;
  return `${statuses.length} statuses`;
}

function StatusFilterMenu({
  statuses,
  onChange,
}: {
  statuses: TicketListFilters["statuses"];
  onChange: (next: readonly TicketStatus[] | null) => void;
}): React.JSX.Element {
  const checked = statuses ?? TICKET_STATUS_ORDER;

  const toggle = (status: TicketStatus, nextChecked: boolean) => {
    const set = new Set(checked);
    if (nextChecked) {
      set.add(status);
    } else {
      // An empty set would show nothing; the last status stays checked.
      if (set.size === 1) return;
      set.delete(status);
    }
    onChange(set.size === TICKET_STATUS_ORDER.length ? null : [...set]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={STATUS_TRIGGER_CLASS}
        aria-label="Status filter"
      >
        <span className="min-w-0 overflow-hidden text-ellipsis">
          {statusFilterSummary(statuses)}
        </span>
        <span className="ml-auto inline-flex text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[state=open]:rotate-180 group-data-[state=open]:text-text-secondary">
          <ChevronDownIcon size={14} />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TICKET_STATUS_ORDER.map((status) => {
          const visual = TICKET_STATUS_VISUALS[status];
          const isChecked = checked.includes(status);
          return (
            <DropdownMenuCheckboxItem
              key={status}
              checked={isChecked}
              disabled={isChecked && checked.length === 1}
              onCheckedChange={(next) => toggle(status, next)}
              // Keep the menu open: composing a status set is a multi-click
              // interaction; Escape/outside-click dismisses.
              onSelect={(event) => event.preventDefault()}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-[6px] w-[6px] shrink-0 rounded-full",
                  visual.dot,
                )}
              />
              {visual.label}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onChange(DEFAULT_TICKET_STATUSES);
          }}
        >
          Open statuses
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onChange(null);
          }}
        >
          All statuses
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function TicketFilters({
  filters,
  projectOptions,
  shownCount,
  totalCount,
  countsReady,
  onFiltersChange,
}: TicketFiltersProps): React.JSX.Element {
  const filtersActive = ticketFiltersActive(filters);

  return (
    <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-xl py-sm max-768:flex-wrap max-768:px-md">
      <span className={FILTER_CAPTION_CLASS}>Filter</span>
      <Select
        value={
          filters.projectName === null
            ? ALL
            : projectOptionValue(filters.projectName)
        }
        onValueChange={(value) =>
          onFiltersChange({
            ...filters,
            projectName:
              value === ALL ? null : value.slice(PROJECT_VALUE_PREFIX.length),
          })
        }
      >
        <SelectTrigger aria-label="Project" layoutClassName="w-[170px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All projects</SelectItem>
          {projectOptions.map((project) => (
            <SelectItem key={project} value={projectOptionValue(project)}>
              {project}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.workType ?? ALL}
        onValueChange={(value) =>
          onFiltersChange({
            ...filters,
            workType:
              value === ALL ? null : (value as TicketListFilters["workType"]),
          })
        }
      >
        <SelectTrigger aria-label="Work type" layoutClassName="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {TICKET_WORK_TYPE_ORDER.map((workType) => (
            <SelectItem key={workType} value={workType}>
              {capitalize(TICKET_WORK_TYPE_LABELS[workType])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <StatusFilterMenu
        statuses={filters.statuses}
        onChange={(next) =>
          onFiltersChange({
            ...filters,
            statuses: normalizeTicketStatusSet(next),
          })
        }
      />
      <span className="ml-auto font-mono text-[0.72rem] text-text-tertiary">
        {countsReady ? `${shownCount} of ${totalCount} shown` : ""}
      </span>
      {filtersActive && (
        <button
          type="button"
          className="inline-flex h-[26px] cursor-pointer items-center rounded-sm border border-solid border-border-subtle bg-transparent px-[8px] font-mono text-[0.68rem] font-medium text-text-secondary transition-colors duration-150 ease-[ease] hover:border-border-strong hover:text-text-primary"
          onClick={() => onFiltersChange(defaultTicketFilters(filters))}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
