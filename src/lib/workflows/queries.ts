import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "@/lib/api/fetcher";
import {
  workflowDefinitionKeys,
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  collaborationKeys,
} from "@/lib/workflows/query-keys";
import {
  workflowDefinitionsResponseSchema,
  workflowDefinitionGetResponseSchema,
} from "@/lib/workflow-definitions/schemas";
import {
  graphWorkflowExecutionEventsResponseSchema,
  graphWorkflowExecutionFullResponseSchema,
} from "@/lib/workflows/schemas";
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

/**
 * Tail of the persisted append-only graph-workflow event log for the active
 * execution. Replaces reading `execution.history` in the UI; the server reads
 * a bounded tail from `graph_workflow_events` rather than loading the full log.
 */
export function useGraphWorkflowEventsQuery(
  projectName: string,
  sessionName: string,
  executionId: string | null,
) {
  return useQuery({
    queryKey: graphWorkflowEventsKeys.list(
      projectName,
      sessionName,
      executionId ?? "",
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/events?executionId=${encodeURIComponent(executionId!)}`,
        graphWorkflowExecutionEventsResponseSchema,
      ).then((r) => r.events),
    enabled: executionId != null,
  });
}

/**
 * The active graph-workflow execution for a session, sourced from the
 * dedicated `graph_workflow_executions` table rather than the session payload.
 * Invalidation-driven (no `refetchInterval`): SSE handlers invalidate
 * `graphWorkflowExecutionKeys.detail` when the execution changes.
 */
export function useGraphWorkflowExecutionQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: graphWorkflowExecutionKeys.detail(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/execution`,
        graphWorkflowExecutionFullResponseSchema,
      ).then((r) => r.execution),
  });
}

const graphWorkflowHistoryResponseSchema = z.object({
  items: z.array(z.object({ executionId: z.string() }).loose()),
});

/**
 * Summaries of the session's archived (and terminal active) graph-workflow
 * executions. The session blob no longer carries the execution-history array;
 * archived runs live in `graph_workflow_archived_executions` and are surfaced
 * through the HISTORY endpoint.
 */
export function useGraphWorkflowHistoryQuery(
  projectName: string,
  sessionName: string,
) {
  return useQuery({
    queryKey: graphWorkflowHistoryKeys.list(projectName, sessionName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/history`,
        graphWorkflowHistoryResponseSchema,
      ).then((r) => r.items),
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
