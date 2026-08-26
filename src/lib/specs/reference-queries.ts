import { queryOptions, useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/fetcher";

import { specKeys } from "./query-keys";
import {
  specElementGetResponseSchema,
  specInventoryViewSchema,
  specPickerDetailViewSchema,
  specSummaryViewSchema,
} from "./reference-view-schemas";

function specBasePath(projectName: string, slug: string): string {
  return `/api/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
}

export const specReferenceQueries = {
  inventory: (projectName: string) =>
    queryOptions({
      queryKey: specKeys.list(projectName),
      queryFn: ({ signal }) =>
        apiFetch(
          `/api/specs/${encodeURIComponent(projectName)}`,
          specInventoryViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  pickerDetail: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.detail(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(specBasePath(projectName, slug), specPickerDetailViewSchema, {
          signal,
        }),
      refetchOnReconnect: false,
    }),
  summary: (projectName: string, slug: string) =>
    queryOptions({
      queryKey: specKeys.summary(projectName, slug),
      queryFn: ({ signal }) =>
        apiFetch(
          `${specBasePath(projectName, slug)}/summary`,
          specSummaryViewSchema,
          { signal },
        ),
      refetchOnReconnect: false,
    }),
  element: (
    projectName: string,
    slug: string,
    handle: string,
    observedRevision?: number,
    targetRevisionId?: string,
  ) =>
    queryOptions({
      queryKey: specKeys.element(
        projectName,
        slug,
        handle,
        observedRevision,
        targetRevisionId,
      ),
      queryFn: ({ signal }) => {
        const params = new URLSearchParams();
        if (observedRevision !== undefined) {
          params.set("observedRevision", String(observedRevision));
        }
        if (targetRevisionId !== undefined) {
          params.set("revisionId", targetRevisionId);
        }
        const query = params.size === 0 ? "" : `?${params.toString()}`;
        return apiFetch(
          `${specBasePath(projectName, slug)}/elements/${encodeURIComponent(handle)}${query}`,
          specElementGetResponseSchema,
          { signal },
        );
      },
      refetchOnReconnect: false,
    }),
} as const;

export function useSpecSummaryQuery(projectName: string, slug: string) {
  return useQuery(specReferenceQueries.summary(projectName, slug));
}

export function useSpecElementQuery(
  projectName: string,
  slug: string,
  handle: string,
  observedRevision?: number,
  targetRevisionId?: string,
) {
  return useQuery(
    specReferenceQueries.element(
      projectName,
      slug,
      handle,
      observedRevision,
      targetRevisionId,
    ),
  );
}
