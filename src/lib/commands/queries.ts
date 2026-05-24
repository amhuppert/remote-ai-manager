import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { commandKeys } from "./query-keys";
import { commandsResponseSchema } from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export function useCommandsQuery(
  projectName: string,
  sessionName: string,
  backend: AgentBackendId = "claude",
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: commandKeys.list(projectName, sessionName, backend),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands?backend=${encodeURIComponent(backend)}`,
        commandsResponseSchema,
      ),
    enabled: options?.enabled,
  });
}

export function useProjectCommandsQuery(
  projectName: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: commandKeys.projectList(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/commands`,
        commandsResponseSchema,
      ),
    enabled: options?.enabled,
  });
}
