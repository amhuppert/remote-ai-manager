import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";
import {
  normalizeTicketListFilters,
  ticketListSearchParams,
  type TicketListFilterInput,
  type TicketListFilters,
} from "./list-filters";
import { ticketKeys } from "./query-keys";
import { waitForTicketMutations } from "./mutation-coordinator";
import {
  resolvedAttachmentSchema,
  ticketDetailSchema,
  ticketLinkSummarySchema,
  ticketListItemSchema,
} from "./schemas";

const ticketListResponseSchema = z.array(ticketListItemSchema);
const sessionLinksResponseSchema = z.record(
  z.string(),
  ticketLinkSummarySchema,
);

export function ticketListUrl(filters: TicketListFilters): string {
  const params = ticketListSearchParams(filters);
  if (filters.projectName !== null) {
    // The project-scoped endpoint carries the project in the path.
    params.delete("project");
    return `/api/projects/${encodeURIComponent(filters.projectName)}/tickets?${params.toString()}`;
  }
  return `/api/tickets?${params.toString()}`;
}

export const ticketQueries = {
  list: (input: TicketListFilterInput = {}) => {
    const filters = normalizeTicketListFilters(input);
    return queryOptions({
      queryKey: ticketKeys.list(filters),
      queryFn: async ({ signal, client }) => {
        await waitForTicketMutations(
          client,
          filters.projectName === null
            ? undefined
            : { projectName: filters.projectName },
          signal,
        );
        return apiFetch(ticketListUrl(filters), ticketListResponseSchema, {
          signal,
        });
      },
      refetchOnReconnect: false,
    });
  },
  detail: (projectName: string, number: number) =>
    queryOptions({
      queryKey: ticketKeys.detail(projectName, number),
      queryFn: async ({ signal, client }) => {
        await waitForTicketMutations(client, { projectName, number }, signal);
        return apiFetch(
          `/api/projects/${encodeURIComponent(projectName)}/tickets/${number}`,
          ticketDetailSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
  sessionLinks: (projectName: string) =>
    queryOptions({
      queryKey: ticketKeys.sessionLinks(projectName),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/projects/${encodeURIComponent(projectName)}/tickets/session-links`,
          sessionLinksResponseSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  attachmentResolve: (
    projectName: string,
    number: number,
    attachmentId: string,
  ) =>
    queryOptions({
      queryKey: ticketKeys.attachmentResolve(projectName, number, attachmentId),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/projects/${encodeURIComponent(projectName)}/tickets/${number}/attachments/${encodeURIComponent(attachmentId)}`,
          resolvedAttachmentSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
};

export function useTicketListQuery(input: TicketListFilterInput = {}) {
  return useQuery(ticketQueries.list(input));
}

export function useTicketDetailQuery(projectName: string, number: number) {
  return useQuery(ticketQueries.detail(projectName, number));
}

export function useTicketSessionLinksQuery(projectName: string) {
  return useQuery(ticketQueries.sessionLinks(projectName));
}

export function useResolveTicketAttachmentQuery(
  projectName: string,
  number: number,
  attachmentId: string,
) {
  return useQuery(
    ticketQueries.attachmentResolve(projectName, number, attachmentId),
  );
}
