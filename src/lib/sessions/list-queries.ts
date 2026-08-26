import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/fetcher";

import {
  branchPrefixResponseSchema,
  sessionsResponseSchema,
} from "./list-schemas";
import { sessionKeys } from "./query-keys";

export function useBranchPrefixQuery(projectName: string) {
  return useQuery({
    queryKey: sessionKeys.branchPrefix(projectName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/branch-prefix`,
        branchPrefixResponseSchema,
      );
      return data.branchPrefix;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useSessionsQuery(projectName: string) {
  return useQuery({
    queryKey: sessionKeys.list(projectName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        sessionsResponseSchema,
      );
      return data.sessions;
    },
  });
}
