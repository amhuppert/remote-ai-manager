/**
 * URL state for the /tickets route: the view toggle, the shared list filters,
 * the list's presentation sort, and the split-pane selection, parsed from and
 * serialized to search params. The URL is the single source of truth for the
 * page; defaults are omitted so `/tickets` stays canonical and shareable links
 * stay minimal.
 *
 * The status filter defaults to the OPEN set (everything but done/closed);
 * `status=all` is the explicit no-filter escape hatch, so absent-param and
 * all-statuses stay distinguishable.
 *
 * Board ordering uses the shared server/cache sort contract in `list-filters.ts`.
 * List column sorting and title search are presentation concerns; title search
 * composes with the server filters without changing the cache/SSE contract.
 */

import {
  DEFAULT_TICKET_STATUSES,
  isDefaultTicketStatusSet,
  normalizeTicketListFilters,
  type TicketListFilters,
} from "@/lib/tickets/list-filters";
import {
  ticketStatusSchema,
  ticketWorkTypeSchema,
  type TicketStatus,
} from "@/lib/tickets/schemas";

export type TicketsView = "list" | "board";

export const TICKET_SORT_COLUMNS = [
  "ticket",
  "title",
  "type",
  "status",
  "ctx",
  "updated",
] as const;
export type TicketSortColumn = (typeof TICKET_SORT_COLUMNS)[number];
export type TicketSortDirection = "asc" | "desc";

export interface TicketListSortState {
  column: TicketSortColumn;
  direction: TicketSortDirection;
}

export const DEFAULT_TICKET_LIST_SORT: TicketListSortState = {
  column: "updated",
  direction: "desc",
};

/** First-click direction per column: text reads A→Z, recency/count big-first. */
export function ticketSortNaturalDirection(
  column: TicketSortColumn,
): TicketSortDirection {
  return column === "updated" || column === "ctx" ? "desc" : "asc";
}

export interface TicketSelection {
  projectName: string;
  number: number;
}

export interface TicketsPageState {
  view: TicketsView;
  search: string;
  filters: TicketListFilters;
  listSort: TicketListSortState;
  selected: TicketSelection | null;
}

function parseEnumParam<T>(
  value: string | null,
  schema: { safeParse(input: unknown): { success: boolean; data?: T } },
): T | undefined {
  if (value === null) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseStatusesParam(
  value: string | null,
): readonly TicketStatus[] | null {
  if (value === null) return DEFAULT_TICKET_STATUSES;
  if (value === "all") return null;
  const statuses = value
    .split(",")
    .map((token) => ticketStatusSchema.safeParse(token))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
  return statuses.length > 0 ? statuses : DEFAULT_TICKET_STATUSES;
}

function parseListSort(
  sort: string | null,
  dir: string | null,
): TicketListSortState {
  const column = TICKET_SORT_COLUMNS.find((candidate) => candidate === sort);
  if (column === undefined) return DEFAULT_TICKET_LIST_SORT;
  const direction =
    dir === "asc" || dir === "desc" ? dir : ticketSortNaturalDirection(column);
  return { column, direction };
}

/** Selection wire format is the ticket identifier, `project#number`. */
function parseSelectionParam(value: string | null): TicketSelection | null {
  if (value === null) return null;
  const separator = value.lastIndexOf("#");
  if (separator <= 0) return null;
  const projectName = value.slice(0, separator);
  const rawNumber = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/.test(rawNumber)) return null;
  return { projectName, number: Number(rawNumber) };
}

export function parseTicketsPageState(
  params: Pick<URLSearchParams, "get">,
): TicketsPageState {
  const project = params.get("project");
  const statuses = parseStatusesParam(params.get("status"));
  return {
    search: params.get("q") ?? "",
    view: params.get("view") === "list" ? "list" : "board",
    filters: normalizeTicketListFilters({
      projectName: project !== null && project !== "" ? project : undefined,
      statuses: statuses ?? undefined,
      sort: params.get("boardSort") === "created" ? "created" : "updated",
      workType: parseEnumParam(params.get("type"), ticketWorkTypeSchema),
    }),
    listSort: parseListSort(params.get("sort"), params.get("dir")),
    selected: parseSelectionParam(params.get("t")),
  };
}

export function ticketsPageHref(state: TicketsPageState): string {
  const params = new URLSearchParams();
  if (state.view !== "board") params.set("view", state.view);
  if (state.search) params.set("q", state.search);
  if (state.filters.sort !== "updated")
    params.set("boardSort", state.filters.sort);
  const { projectName, statuses, workType } = state.filters;
  if (projectName !== null) params.set("project", projectName);
  if (statuses === null) {
    params.set("status", "all");
  } else if (!isDefaultTicketStatusSet(statuses)) {
    params.set("status", statuses.join(","));
  }
  if (workType !== null) params.set("type", workType);
  const { column, direction } = state.listSort;
  if (
    column !== DEFAULT_TICKET_LIST_SORT.column ||
    direction !== DEFAULT_TICKET_LIST_SORT.direction
  ) {
    params.set("sort", column);
    params.set("dir", direction);
  }
  if (state.view === "list" && state.selected !== null) {
    params.set("t", `${state.selected.projectName}#${state.selected.number}`);
  }
  const search = params.toString();
  return search === "" ? "/tickets" : `/tickets?${search}`;
}
