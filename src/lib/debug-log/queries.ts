import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { debugLogKeys } from "./query-keys";
import { debugLogStatsResponseSchema } from "./schemas";

export function useDebugLogEntryCountQuery(
  projectName: string,
  sessionName: string,
  conversationId: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: debugLogKeys.stats(projectName, sessionName, conversationId),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/debug-mode/logs`,
        debugLogStatsResponseSchema,
      ).then((r) => r.entryCount),
    enabled,
  });
}
