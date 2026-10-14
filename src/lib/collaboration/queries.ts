"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { collaborationKeys } from "./query-keys";
import { collaborationListResponseSchema } from "./schemas";
export function useCollaborationListQuery(
  projectName: string,
  sessionName: string,
  options?: {
    enabled?: boolean;
    includeAll?: boolean;
  },
) {
  const includeAll = options?.includeAll ?? false;
  return useQuery({
    queryKey: includeAll
      ? collaborationKeys.listAll(projectName, sessionName)
      : collaborationKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/collaboration${includeAll ? "?all=true" : ""}`,
        collaborationListResponseSchema,
      ).then((r) => r.envelopes),
    enabled: options?.enabled ?? true,
  });
}
