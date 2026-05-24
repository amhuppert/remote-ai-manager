import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { fileKeys } from "./query-keys";
import { projectFilesResponseSchema } from "./schemas";

export function useProjectFilesQuery(
  args: { projectName: string; sessionName?: string },
  options?: { enabled?: boolean },
) {
  const { projectName, sessionName } = args;
  const queryKey = sessionName
    ? fileKeys.sessionList(projectName, sessionName)
    : fileKeys.list(projectName);
  const url = sessionName
    ? `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/files`
    : `/api/projects/${encodeURIComponent(projectName)}/files`;

  return useQuery({
    queryKey,
    queryFn: () => apiFetch(url, projectFilesResponseSchema),
    enabled: options?.enabled,
  });
}
