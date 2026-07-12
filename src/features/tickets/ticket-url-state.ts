/**
 * URL state for the /tickets route: the view toggle plus the shared list
 * filters, parsed from and serialized to search params. The URL is the single
 * source of truth for the page; defaults are omitted so `/tickets` stays
 * canonical and shareable links stay minimal.
 */

import {
  normalizeTicketListFilters,
  type TicketListFilters,
} from "@/lib/tickets/list-filters";
import {
  ticketListSortSchema,
  ticketStatusSchema,
  ticketWorkTypeSchema,
} from "@/lib/tickets/schemas";

export type TicketsView = "list" | "board";

export interface TicketsPageState {
  view: TicketsView;
  filters: TicketListFilters;
}

function parseEnumParam<T>(
  value: string | null,
  schema: { safeParse(input: unknown): { success: boolean; data?: T } },
): T | undefined {
  if (value === null) return undefined;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parseTicketsPageState(
  params: URLSearchParams,
): TicketsPageState {
  const project = params.get("project");
  return {
    view: params.get("view") === "board" ? "board" : "list",
    filters: normalizeTicketListFilters({
      projectName: project !== null && project !== "" ? project : undefined,
      status: parseEnumParam(params.get("status"), ticketStatusSchema),
      workType: parseEnumParam(params.get("type"), ticketWorkTypeSchema),
      sort: parseEnumParam(params.get("sort"), ticketListSortSchema),
    }),
  };
}

export function ticketsPageHref(state: TicketsPageState): string {
  const params = new URLSearchParams();
  if (state.view !== "list") params.set("view", state.view);
  const { projectName, status, workType, sort } = state.filters;
  if (projectName !== null) params.set("project", projectName);
  if (status !== null) params.set("status", status);
  if (workType !== null) params.set("type", workType);
  if (sort !== "updated") params.set("sort", sort);
  const search = params.toString();
  return search === "" ? "/tickets" : `/tickets?${search}`;
}
