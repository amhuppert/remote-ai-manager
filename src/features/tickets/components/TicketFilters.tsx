"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import type { TicketListFilters } from "@/lib/tickets/list-filters";
import type { TicketListSort } from "@/lib/tickets/schemas";
import {
  TICKET_STATUS_ORDER,
  TICKET_STATUS_VISUALS,
  TICKET_WORK_TYPE_LABELS,
  TICKET_WORK_TYPE_ORDER,
} from "../ticket-visuals";

// Radix Select item values must be non-empty, so the "no filter" choice is a
// sentinel that maps to null in the shared filter shape.
const ALL = "all";
const PROJECT_VALUE_PREFIX = "project:";

function projectOptionValue(projectName: string): string {
  return `${PROJECT_VALUE_PREFIX}${projectName}`;
}

const FILTER_CAPTION_CLASS =
  "font-mono text-[0.68rem] font-medium uppercase tracking-[0.08em] text-text-tertiary";

const SORT_LABELS: Record<TicketListSort, string> = {
  updated: "Last updated",
  created: "Created",
};

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

export function ticketFiltersActive(filters: TicketListFilters): boolean {
  return (
    filters.projectName !== null ||
    filters.status !== null ||
    filters.workType !== null
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
      <Select
        value={filters.status ?? ALL}
        onValueChange={(value) =>
          onFiltersChange({
            ...filters,
            status:
              value === ALL ? null : (value as TicketListFilters["status"]),
          })
        }
      >
        <SelectTrigger aria-label="Status" layoutClassName="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {TICKET_STATUS_ORDER.map((status) => (
            <SelectItem key={status} value={status}>
              {TICKET_STATUS_VISUALS[status].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="h-[16px] w-px bg-border-default" />
      <span className={FILTER_CAPTION_CLASS}>Sort</span>
      <Select
        value={filters.sort}
        onValueChange={(value) =>
          onFiltersChange({ ...filters, sort: value as TicketListSort })
        }
      >
        <SelectTrigger aria-label="Sort" layoutClassName="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SORT_LABELS) as TicketListSort[]).map((sort) => (
            <SelectItem key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="ml-auto font-mono text-[0.72rem] text-text-tertiary">
        {countsReady ? `${shownCount} of ${totalCount} shown` : ""}
      </span>
      {filtersActive && (
        <button
          type="button"
          className="inline-flex h-[26px] cursor-pointer items-center rounded-sm border border-solid border-border-subtle bg-transparent px-[8px] font-mono text-[0.68rem] font-medium text-text-secondary transition-colors duration-150 ease-[ease] hover:border-border-strong hover:text-text-primary"
          onClick={() =>
            onFiltersChange({
              ...filters,
              projectName: null,
              status: null,
              workType: null,
            })
          }
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
