import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { z } from "zod";

import { apiFetch } from "@/lib/api/fetcher";
import { TICKET_PAGE_DEFAULT_LIMIT } from "./disclosure-limits";
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
  ticketRelationshipPageSchema,
  ticketStatusUpdatePageSchema,
  type TicketRelationshipRole,
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

function ticketCollectionPageUrl(
  projectName: string,
  number: number,
  collection: "relationships" | "status-updates",
  options: {
    cursor: string | null;
    role?: TicketRelationshipRole | null;
  },
): string {
  const params = new URLSearchParams({
    limit: String(TICKET_PAGE_DEFAULT_LIMIT),
  });
  if (options.role !== undefined && options.role !== null) {
    params.set("role", options.role);
  }
  if (options.cursor !== null) {
    params.set("cursor", options.cursor);
  }
  return `/api/projects/${encodeURIComponent(projectName)}/tickets/${number}/${collection}?${params.toString()}`;
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
  relationships: (
    projectName: string,
    number: number,
    role: TicketRelationshipRole | null = null,
  ) =>
    infiniteQueryOptions({
      queryKey: ticketKeys.relationships(projectName, number, role),
      initialPageParam: null as string | null,
      queryFn: async ({ pageParam, signal, client }) => {
        await waitForTicketMutations(client, { projectName, number }, signal);
        return apiFetch(
          ticketCollectionPageUrl(projectName, number, "relationships", {
            cursor: pageParam,
            role,
          }),
          ticketRelationshipPageSchema,
          { signal },
        );
      },
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      refetchOnReconnect: false,
    }),
  statusUpdates: (projectName: string, number: number) =>
    infiniteQueryOptions({
      queryKey: ticketKeys.statusUpdates(projectName, number),
      initialPageParam: null as string | null,
      queryFn: async ({ pageParam, signal, client }) => {
        await waitForTicketMutations(client, { projectName, number }, signal);
        return apiFetch(
          ticketCollectionPageUrl(projectName, number, "status-updates", {
            cursor: pageParam,
          }),
          ticketStatusUpdatePageSchema,
          { signal },
        );
      },
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      refetchOnReconnect: false,
    }),
};

export function useTicketListQuery(input: TicketListFilterInput = {}) {
  return useQuery(ticketQueries.list(input));
}

export function useTicketDetailQuery(projectName: string, number: number) {
  return useQuery(ticketQueries.detail(projectName, number));
}

export function useTicketRelationshipsQuery(
  projectName: string,
  number: number,
  role: TicketRelationshipRole | null = null,
) {
  return useInfiniteQuery(
    ticketQueries.relationships(projectName, number, role),
  );
}

export function useTicketStatusUpdatesQuery(
  projectName: string,
  number: number,
) {
  return useInfiniteQuery(ticketQueries.statusUpdates(projectName, number));
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
