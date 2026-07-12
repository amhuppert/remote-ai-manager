import {
  ticketListFiltersSchema,
  type TicketListFilters,
} from "./list-filters";

export const ticketKeys = {
  all: ["tickets"] as const,
  lists: () => [...ticketKeys.all, "list"] as const,
  list: (filters: TicketListFilters) =>
    [...ticketKeys.lists(), filters] as const,
  details: () => [...ticketKeys.all, "detail"] as const,
  detail: (projectName: string, number: number) =>
    [...ticketKeys.details(), projectName, number] as const,
  // Nested under the detail key so attachment-change invalidation of the
  // detail prefix also refreshes any open resolved previews.
  attachmentResolve: (
    projectName: string,
    number: number,
    attachmentId: string,
  ) =>
    [
      ...ticketKeys.detail(projectName, number),
      "attachment",
      attachmentId,
    ] as const,
  sessionLinksAll: () => [...ticketKeys.all, "session-links"] as const,
  sessionLinks: (projectName: string) =>
    [...ticketKeys.sessionLinksAll(), projectName] as const,
} as const;

/**
 * Recover the typed filters from a cached list key — the read side of
 * `ticketKeys.list`. Optimistic cache walkers and the SSE reducer use this to
 * decide, per cached list, whether a changed ticket belongs and where.
 */
export function ticketListFiltersFromQueryKey(
  queryKey: readonly unknown[],
): TicketListFilters | null {
  if (queryKey.length !== 3) return null;
  if (queryKey[0] !== "tickets" || queryKey[1] !== "list") return null;
  const parsed = ticketListFiltersSchema.safeParse(queryKey[2]);
  return parsed.success ? parsed.data : null;
}
