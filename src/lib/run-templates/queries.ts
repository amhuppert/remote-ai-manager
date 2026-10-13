import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import type { RunTemplateTier } from "@/lib/runs/schemas";
import { runTemplateDetailResponseSchema } from "./document";
import { runTemplateKeys } from "./query-keys";
import { runTemplateLibrarySchema } from "./schemas";

function libraryUrl(projectName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/run-templates`;
}

/**
 * A project's run templates (its own and the global ones) and one template
 * with the Command Center defaults it falls back to. `run-template-changed`
 * keeps both current, so neither polls.
 */
export const runTemplateQueries = {
  list: (projectName: string) =>
    queryOptions({
      queryKey: runTemplateKeys.list(projectName),
      queryFn: ({ signal }) =>
        apiFetch(libraryUrl(projectName), runTemplateLibrarySchema, {
          signal,
        }),
    }),
  detail: (projectName: string, tier: RunTemplateTier, id: string) =>
    queryOptions({
      queryKey: runTemplateKeys.detail(projectName, tier, id),
      queryFn: ({ signal }) =>
        apiFetch(
          `${libraryUrl(projectName)}/${tier}/${encodeURIComponent(id)}`,
          runTemplateDetailResponseSchema,
          { signal },
        ),
    }),
};

export function useRunTemplateLibraryQuery(projectName: string) {
  return useQuery(runTemplateQueries.list(projectName));
}

export function useRunTemplateQuery(
  projectName: string,
  tier: RunTemplateTier,
  id: string,
) {
  return useQuery(runTemplateQueries.detail(projectName, tier, id));
}
