import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "@/lib/api/fetcher";
import { runKeys } from "./query-keys";
import { runPageSchema, runSummarySchema } from "./schemas";

const runListSchema = z.array(runSummarySchema);

function sessionRunsUrl(projectName: string, sessionName: string): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/runs`;
}

/** A session's runs and each run's page; run-changed events keep them current, so neither polls. */
export const runQueries = {
  list: (projectName: string, sessionName: string) =>
    queryOptions({
      queryKey: runKeys.list(projectName, sessionName),
      queryFn: ({ signal }) =>
        apiFetch(sessionRunsUrl(projectName, sessionName), runListSchema, {
          signal,
        }),
    }),
  page: (projectName: string, sessionName: string, runId: string) =>
    queryOptions({
      queryKey: runKeys.page(projectName, sessionName, runId),
      queryFn: ({ signal }) =>
        apiFetch(
          `${sessionRunsUrl(projectName, sessionName)}/${encodeURIComponent(runId)}/page`,
          runPageSchema,
          { signal },
        ),
    }),
};

export function useSessionRunsQuery(projectName: string, sessionName: string) {
  return useQuery(runQueries.list(projectName, sessionName));
}

/** A run's page; nothing is read while no run is selected. */
export function useRunPageQuery(
  projectName: string,
  sessionName: string,
  runId: string | null,
) {
  return useQuery({
    ...runQueries.page(projectName, sessionName, runId ?? ""),
    enabled: runId !== null,
  });
}
