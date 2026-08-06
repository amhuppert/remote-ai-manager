import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "@/lib/api/fetcher";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  collaborationKeys,
  projectTemplatesKeys,
} from "@/lib/workflows/query-keys";
import {
  workflowDefinitionsResponseSchema,
  workflowDefinitionGetResponseSchema,
} from "@/lib/workflow-definitions/schemas";
import { graphWorkflowExecutionEventsResponseSchema } from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowExecutionFullResponseSchema,
  graphWorkflowExecutionHistoryItemSchema,
} from "@/lib/workflow-graph/schemas";
import {
  parameterDeclarationSchema,
  prerequisiteSchema,
} from "@/lib/workflow-graph/definition-schemas";
import { collaborationListResponseSchema } from "@/lib/collaboration/schemas";
import {
  workflowDefinitionScopeApi,
  type WorkflowDefinitionScope,
} from "@/lib/workflows/definition-scope";
import type { TemplateLibraryItem } from "@/lib/workflow-graph/template-library-service";

// The cross-tier library listing returned by the project-templates endpoint.
// Item validation is derived from the canonical parameter/prerequisite schemas
// so a drift in either surface fails the parse at the boundary rather than
// silently passing a malformed declaration into the launch form.
const templateLibraryItemSchema = z.object({
  tier: z.enum(["project", "global"]),
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
  parameters: z.array(parameterDeclarationSchema),
  prerequisites: z.array(prerequisiteSchema),
});

const projectTemplatesResponseSchema = z.object({
  items: z.array(templateLibraryItemSchema),
});

export function useProjectTemplatesQuery(projectName: string) {
  return useQuery<TemplateLibraryItem[]>({
    queryKey: projectTemplatesKeys.list(projectName),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflow-templates`,
        projectTemplatesResponseSchema,
      ).then((r) => r.items),
  });
}

export function useScopedWorkflowDefinitionsQuery(
  scope: WorkflowDefinitionScope,
) {
  const api = workflowDefinitionScopeApi(scope);
  return useQuery({
    queryKey: api.listKey,
    queryFn: async () => {
      const data = await apiFetch(
        api.collectionUrl,
        workflowDefinitionsResponseSchema,
      );
      return data.items;
    },
  });
}

export function useWorkflowDefinitionsQuery(projectName: string) {
  return useScopedWorkflowDefinitionsQuery({ kind: "project", projectName });
}

export function useScopedWorkflowDefinitionQuery(
  scope: WorkflowDefinitionScope,
  workflowId: string | null,
) {
  const api = workflowDefinitionScopeApi(scope);
  return useQuery({
    queryKey: api.detailKey(workflowId ?? ""),
    queryFn: async () => {
      return await apiFetch(
        api.itemUrl(workflowId!),
        workflowDefinitionGetResponseSchema,
      );
    },
    enabled: workflowId != null,
  });
}

export function useWorkflowDefinitionQuery(
  projectName: string,
  workflowId: string | null,
) {
  return useScopedWorkflowDefinitionQuery(
    { kind: "project", projectName },
    workflowId,
  );
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
  items: z.array(graphWorkflowExecutionHistoryItemSchema),
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
