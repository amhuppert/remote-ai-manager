import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { projectKeys } from "@/lib/projects/query-keys";
import {
  discoveredProjectSchema,
  projectPreferencesResponseSchema,
} from "@/lib/projects/schemas";

export function useProjectsQuery() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => apiFetch("/api/projects", z.array(discoveredProjectSchema)),
  });
}

export function useProjectPreferencesQuery() {
  return useQuery({
    queryKey: projectKeys.preferences(),
    queryFn: () =>
      apiFetch("/api/projects/preferences", projectPreferencesResponseSchema),
  });
}
