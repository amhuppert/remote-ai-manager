import { useQuery } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { ApiCallError } from "@/lib/api/errors";
import { apiFetch } from "@/lib/api/fetcher";
import { publicSessionStateSchema } from "@/lib/sessions/schemas";
export { useBranchPrefixQuery, useSessionsQuery } from "./list-queries";

/** A missing session is terminal — retrying a 404 only spams the API. */
export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 404;
}

/**
 * The effective git branch prefix for a project (per-repo override → global →
 * `"csm"`). Long-lived config, so a generous staleTime keeps client branch
 * previews stable without refetch churn.
 */
export function useSessionQuery(
  projectName: string,
  sessionName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    enabled: options?.enabled,
    queryKey: sessionKeys.detail(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}`,
        // The session detail route serializes through `toPublicSessionState`,
        // so the client is typed on what it actually receives — including each
        // conversation's redacted profile identity.
        publicSessionStateSchema,
      ),
    retry: (failureCount, error) => {
      if (isSessionNotFoundError(error)) return false;
      return failureCount < 3;
    },
  });
}
