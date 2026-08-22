import { useCallback } from "react";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "@/lib/api/fetcher";
import {
  graphWorkflowApprovalSnapshotKeys,
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  graphWorkflowResultKeys,
  collaborationKeys,
  projectTemplatesKeys,
} from "@/lib/workflows/query-keys";
import {
  workflowDefinitionsResponseSchema,
  workflowDefinitionGetResponseSchema,
  type WorkflowDefinitionGetResponse,
} from "@/lib/workflow-definitions/schemas";
import {
  graphWorkflowBoundaryKindSchema,
  graphWorkflowExecutionEventPageResponseSchema,
  graphWorkflowExecutionEventsResponseSchema,
  type GraphWorkflowExecutionEventPageResponse,
  type GraphWorkflowExecutionEventPageRow,
} from "@/lib/workflow-graph/event-schemas";
import {
  graphWorkflowApprovalSnapshotResponseSchema,
  graphWorkflowAbandonmentSchema,
  graphWorkflowExecutionFullResponseSchema,
  graphWorkflowExecutionHistoryItemSchema,
  graphWorkflowExecutionOriginSchema,
  graphWorkflowHaltReasonSchema,
} from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowStatusSchema,
  parameterDeclarationSchema,
  prerequisiteSchema,
} from "@/lib/workflow-graph/definition-schemas";
import { graphWorkflowResultOutputProjectionSchema } from "@/lib/workflow-graph/result-output-contract";
import type { GraphWorkflowBoundaryResultProjection } from "@/lib/workflow-graph/execution-result-projection";
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

/**
 * How many execution contexts each listed definition holds.
 *
 * The collection endpoint returns body-less summaries, so the count only exists
 * in the detail record — one request per definition, sharing the detail query's
 * key so the loaded draft is a cache hit rather than a second fetch. A
 * definition whose record has not arrived is simply absent from the result; the
 * sidebar states its revision alone rather than guessing.
 */
export function useScopedWorkflowDefinitionContextCounts(
  scope: WorkflowDefinitionScope,
  workflowIds: readonly string[],
): Record<string, number> {
  const api = workflowDefinitionScopeApi(scope);
  const combine = useCallback(
    (results: Array<{ data: WorkflowDefinitionGetResponse | undefined }>) => {
      const counts: Record<string, number> = {};
      results.forEach((result, index) => {
        const id = workflowIds[index];
        if (id === undefined || result.data === undefined) return;
        counts[id] = result.data.item.definition.executionContexts.length;
      });
      return counts;
    },
    [workflowIds],
  );

  return useQueries({
    queries: workflowIds.map((id) => ({
      queryKey: api.detailKey(id),
      queryFn: () =>
        apiFetch(api.itemUrl(id), workflowDefinitionGetResponseSchema),
    })),
    combine,
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

/** Rows per ledger page — one request covers most executions outright. */
const GRAPH_WORKFLOW_EVENT_PAGE_SIZE = 200;

/**
 * COMPLETE event history for an execution, read newest-first through the shared
 * cursor-paginated reader (D4 decision D9).
 *
 * The tail query above answers "what happened lately" and is structurally
 * incapable of serving history — it returns a bounded window with no cursor. The
 * loop ledger needs every decision a pass was ever given, including the ones an
 * amended control revision superseded, so it walks pages instead. Newest-first
 * because a reader wants the current state of the loop before its origins.
 */
export function useGraphWorkflowEventPagesQuery(
  projectName: string,
  sessionName: string,
  executionId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: graphWorkflowEventsKeys.pages(
      projectName,
      sessionName,
      executionId ?? "",
    ),
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        executionId: executionId ?? "",
        page: "true",
        direction: "desc",
        limit: String(GRAPH_WORKFLOW_EVENT_PAGE_SIZE),
      });
      if (pageParam !== null) params.set("cursor", String(pageParam));
      return apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/events?${params.toString()}`,
        graphWorkflowExecutionEventPageResponseSchema,
      );
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: executionId != null && options.enabled !== false,
  });
}

/**
 * The loaded window in LOG order (oldest first) — the order every derivation
 * over the event stream expects, whichever direction the pages were fetched in.
 */
export function orderGraphWorkflowEventPages(
  pages: readonly GraphWorkflowExecutionEventPageResponse[] | undefined,
): GraphWorkflowExecutionEventPageRow[] {
  return (pages ?? []).flatMap((page) => page.events).reverse();
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

/**
 * One Current-or-History execution addressed by durable execution id.
 *
 * This is deliberately distinct from the Current query: a historical deep
 * link must remain readable after the session lease moves to a newer run.
 */
export function useGraphWorkflowExecutionByIdQuery(
  projectName: string,
  sessionName: string,
  executionId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: graphWorkflowExecutionKeys.byId(
      projectName,
      sessionName,
      executionId ?? "",
    ),
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/executions/${encodeURIComponent(executionId!)}`,
        graphWorkflowExecutionFullResponseSchema,
      ).then((r) => r.execution),
    enabled: executionId !== null && options.enabled !== false,
  });
}

const graphWorkflowBoundaryResultSchema = z.object({
  cursor: z.number().int().min(1),
  occurredAt: z.string(),
  executionId: z.string().trim().min(1),
  boundaryKind: graphWorkflowBoundaryKindSchema,
  status: graphWorkflowStatusSchema,
  contextId: z.string().nullable(),
  pendingActions: z.array(z.record(z.string(), z.unknown())),
  outputs: graphWorkflowResultOutputProjectionSchema,
  name: z.string().trim().min(1),
  origin: graphWorkflowExecutionOriginSchema,
  originConversationId: z.string().trim().min(1).nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  haltReason: graphWorkflowHaltReasonSchema.nullable(),
  abandonment: graphWorkflowAbandonmentSchema.nullable(),
  documents: z.array(graphWorkflowSharedDocumentEntrySchema),
  deepLink: z.string().trim().min(1),
});

const graphWorkflowBoundaryResultResponseSchema = z.object({
  result: graphWorkflowBoundaryResultSchema.nullable(),
});

function fetchGraphWorkflowExecutionResultAfter(
  projectName: string,
  sessionName: string,
  executionId: string,
  cursor: number | null,
): Promise<GraphWorkflowBoundaryResultProjection | null> {
  const suffix = cursor === null ? "" : `?cursor=${cursor}`;
  return apiFetch(
    `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/executions/${encodeURIComponent(executionId)}/result${suffix}`,
    graphWorkflowBoundaryResultResponseSchema,
  ).then((response) => response.result);
}

/** Read the first durable boundary result after an optional event cursor. */
export function useGraphWorkflowExecutionResultQuery(
  projectName: string,
  sessionName: string,
  executionId: string | null,
  cursor: number | null = null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: graphWorkflowResultKeys.detail(
      projectName,
      sessionName,
      executionId ?? "",
      cursor,
    ),
    queryFn: () => {
      if (executionId === null) {
        throw new Error("Execution result query requires an execution id");
      }
      return fetchGraphWorkflowExecutionResultAfter(
        projectName,
        sessionName,
        executionId,
        cursor,
      );
    },
    enabled: executionId !== null && options.enabled !== false,
  });
}

/**
 * Read the latest durable boundary projection by walking the opaque result
 * cursor until the server reports that no later boundary exists.
 *
 * The result endpoint deliberately returns the FIRST boundary after a cursor;
 * treating its cursorless response as "latest" pins a long-lived execution to
 * its first pause or halt. This one query owns that traversal for browser
 * consumers, and result-recorded SSE invalidates its execution-scoped prefix.
 */
export function useGraphWorkflowLatestExecutionResultQuery(
  projectName: string,
  sessionName: string,
  executionId: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: graphWorkflowResultKeys.latest(
      projectName,
      sessionName,
      executionId ?? "",
    ),
    queryFn: async () => {
      if (executionId === null) {
        throw new Error(
          "Latest execution result query requires an execution id",
        );
      }
      let cursor: number | null = null;
      let latest: GraphWorkflowBoundaryResultProjection | null = null;
      for (;;) {
        const next = await fetchGraphWorkflowExecutionResultAfter(
          projectName,
          sessionName,
          executionId,
          cursor,
        );
        if (next === null) return latest;
        if (cursor !== null && next.cursor <= cursor) {
          throw new Error("Execution result cursor did not advance");
        }
        latest = next;
        cursor = next.cursor;
      }
    },
    enabled: executionId !== null && options.enabled !== false,
  });
}

/**
 * The frozen, ownership-scoped change set the approval panel renders for an
 * enveloped context (R15.2).
 *
 * Deliberately NOT the session diff query: in a shared lane worktree the
 * whole-worktree delta is partly a concurrent sibling's in-progress work, and it
 * moves under the reviewer while they read it. This endpoint answers with the
 * candidate the gate froze, or says it cannot.
 */
export function useGraphWorkflowApprovalSnapshotQuery(
  projectName: string,
  sessionName: string,
  contextId: string | null,
  requestedAt: string | null,
) {
  const enabled = contextId !== null && requestedAt !== null;
  return useQuery({
    queryKey: graphWorkflowApprovalSnapshotKeys.detail(
      projectName,
      sessionName,
      contextId ?? "",
      requestedAt ?? "",
    ),
    enabled,
    // `requestedAt` also travels in the request: it names the gate being
    // rendered, so a client on stale execution state is refused rather than
    // handed a later gate's bytes under the earlier gate's identity.
    queryFn: () =>
      apiFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/approval-snapshot?contextId=${encodeURIComponent(contextId ?? "")}&requestedAt=${encodeURIComponent(requestedAt ?? "")}`,
        graphWorkflowApprovalSnapshotResponseSchema,
      ),
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
