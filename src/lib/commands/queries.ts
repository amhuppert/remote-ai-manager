import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { commandKeys } from "./query-keys";
import { commandsResponseSchema } from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export function useCommandsQuery(
  projectName: string,
  sessionName: string | undefined,
  backend: AgentBackendId = "claude",
  options?: { enabled?: boolean; conversationId?: string },
) {
  return useQuery({
    queryKey: commandKeys.list(
      projectName,
      sessionName,
      backend,
      options?.conversationId,
    ),
    queryFn: () => {
      if (sessionName === undefined) {
        throw new Error("sessionName is required for session commands");
      }
      return apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands?${commandQueryParams(backend, options?.conversationId)}`,
        commandsResponseSchema,
      );
    },
    enabled: options?.enabled ?? sessionName !== undefined,
  });
}

export function useProjectCommandsQuery(
  projectName: string,
  backend: AgentBackendId = "claude",
  options?: { enabled?: boolean; conversationId?: string },
) {
  return useQuery({
    queryKey: commandKeys.projectList(
      projectName,
      backend,
      options?.conversationId,
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/commands?${commandQueryParams(backend, options?.conversationId)}`,
        commandsResponseSchema,
      ),
    enabled: options?.enabled,
  });
}

function commandQueryParams(
  backend: AgentBackendId,
  conversationId?: string,
): string {
  const params = new URLSearchParams({ backend });
  if (conversationId) params.set("conversationId", conversationId);
  return params.toString();
}
