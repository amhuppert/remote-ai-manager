import { useQuery } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { ApiCallError } from "@/lib/api/errors";
import { apiFetch } from "@/lib/api/fetcher";
import {
  sessionsResponseSchema,
  sessionStateSchema,
} from "@/lib/sessions/schemas";

/** A missing session is terminal — retrying a 404 only spams the API. */
export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof ApiCallError && error.status === 404;
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

export function useSessionQuery(projectName: string, sessionName: string) {
  return useQuery({
    queryKey: sessionKeys.detail(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}`,
        sessionStateSchema,
      ),
    retry: (failureCount, error) => {
      if (isSessionNotFoundError(error)) return false;
      return failureCount < 3;
    },
  });
}
