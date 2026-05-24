import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import {
  workflowDefinitionKeys,
  collaborationKeys,
} from "@/lib/workflows/query-keys";
import {
  workflowDefinitionsResponseSchema,
  workflowDefinitionGetResponseSchema,
} from "@/lib/workflow-definitions/schemas";
import { collaborationListResponseSchema } from "@/lib/collaboration/schemas";

export function useWorkflowDefinitionsQuery(projectName: string) {
  return useQuery({
    queryKey: workflowDefinitionKeys.list(projectName),
    queryFn: async () => {
      const data = await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows`,
        workflowDefinitionsResponseSchema,
      );
      return data.items;
    },
  });
}

export function useWorkflowDefinitionQuery(
  projectName: string,
  workflowId: string | null,
) {
  return useQuery({
    queryKey: workflowDefinitionKeys.detail(projectName, workflowId ?? ""),
    queryFn: async () => {
      return await apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows/${encodeURIComponent(workflowId!)}`,
        workflowDefinitionGetResponseSchema,
      );
    },
    enabled: workflowId != null,
  });
}

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
