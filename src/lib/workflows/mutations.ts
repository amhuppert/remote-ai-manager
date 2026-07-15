import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import {
  collaborationKeys,
  graphWorkflowExecutionKeys,
} from "@/lib/workflows/query-keys";
import {
  workflowDefinitionScopeApi,
  type WorkflowDefinitionScope,
} from "@/lib/workflows/definition-scope";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { workflowDefinitionMutationResponseSchema } from "@/lib/workflow-definitions/schemas";
import {
  collaborationStartResponseSchema,
  collaborationResumeResponseSchema,
  collaborationStopResponseSchema,
} from "@/lib/collaboration/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import type { WorkflowDefinitionRecord } from "@/lib/workflow-graph/definition-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type {
  WorkflowLiveEditOperation,
  WorkflowLiveEditRequest,
} from "@/lib/workflows/edit-schemas";
interface WorkflowDefinitionDraftInput {
  name: string;
  description?: string | null;
  definition: WorkflowDefinitionRecord["definition"];
  layout: WorkflowDefinitionRecord["layout"];
}

export function useScopedCreateWorkflowDefinitionMutation(
  scope: WorkflowDefinitionScope,
) {
  const queryClient = useQueryClient();
  const api = workflowDefinitionScopeApi(scope);

  return useMutation({
    mutationFn: (draft: WorkflowDefinitionDraftInput) =>
      mutationFetch(
        api.collectionUrl,
        "create-workflow-definition",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
        workflowDefinitionMutationResponseSchema,
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: api.listKey });
      void queryClient.invalidateQueries({
        queryKey: api.detailKey(data.item.id),
      });
    },
  });
}

export function useCreateWorkflowDefinitionMutation(projectName: string) {
  return useScopedCreateWorkflowDefinitionMutation({
    kind: "project",
    projectName,
  });
}

export function useScopedUpdateWorkflowDefinitionMutation(
  scope: WorkflowDefinitionScope,
  workflowId: string,
) {
  const queryClient = useQueryClient();
  const api = workflowDefinitionScopeApi(scope);

  return useMutation({
    mutationFn: (draft: WorkflowDefinitionDraftInput) =>
      mutationFetch(
        api.itemUrl(workflowId),
        "update-workflow-definition",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
        workflowDefinitionMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: api.listKey });
      void queryClient.invalidateQueries({
        queryKey: api.detailKey(workflowId),
      });
    },
  });
}

export function useUpdateWorkflowDefinitionMutation(
  projectName: string,
  workflowId: string,
) {
  return useScopedUpdateWorkflowDefinitionMutation(
    { kind: "project", projectName },
    workflowId,
  );
}

export function useScopedDeleteWorkflowDefinitionMutation(
  scope: WorkflowDefinitionScope,
) {
  const queryClient = useQueryClient();
  const api = workflowDefinitionScopeApi(scope);

  return useMutation({
    mutationFn: (workflowId: string) =>
      mutationFetch(api.itemUrl(workflowId), "delete-workflow-definition", {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: api.listKey });
    },
  });
}

export function useDeleteWorkflowDefinitionMutation(projectName: string) {
  return useScopedDeleteWorkflowDefinitionMutation({
    kind: "project",
    projectName,
  });
}

export interface StartGraphWorkflowVariables {
  definitionId: string;
  /**
   * Run-specific values for the definition's declared launch parameters. Omitted
   * for a zero-input launch so the request body is identical to a parameterless
   * start (the start route treats `parameters` as optional).
   */
  parameters?: Record<string, string>;
  /**
   * Which storage tier to resolve `definitionId` from. Omitted for a per-project
   * launch so the request body is identical to today's project-only start (the
   * start route defaults an absent tier to `project`).
   */
  tier?: "project" | "global";
}

export function useStartGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      definitionId,
      parameters,
      tier,
    }: StartGraphWorkflowVariables) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow`,
        "start-graph-workflow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            definitionId,
            ...(parameters !== undefined ? { parameters } : {}),
            ...(tier !== undefined ? { tier } : {}),
          }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function usePauseGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/pause`,
        "pause-graph-workflow",
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export interface ResumeGraphWorkflowVariables {
  /** Per-file operator guidance for the next conflict-resolution attempt of a
   *  failed join being retried by this resume. */
  conflictGuidance?: ConflictDecisionInput[];
}

export function useResumeGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables?: ResumeGraphWorkflowVariables) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/resume`,
        "resume-graph-workflow",
        variables?.conflictGuidance && variables.conflictGuidance.length > 0
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                conflictGuidance: variables.conflictGuidance,
              }),
            }
          : { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useAbortGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/abort`,
        "abort-graph-workflow",
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useClearGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/clear`,
        "clear-graph-workflow",
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useResetExecutionContextMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: { executionId: string; contextId: string }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/reset-context`,
        "reset-execution-context",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(variables),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export type ResolveApprovalVariables =
  | { contextId: string; decision: "approve" }
  | { contextId: string; decision: "reject"; message: string };

export type ResolveApprovalResult =
  | { status: "ok" }
  | { status: "conflict"; error: string | null };

export function useResolveApprovalMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      variables: ResolveApprovalVariables,
    ): Promise<ResolveApprovalResult> => {
      const res = await tracedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/resolve-approval`,
        "resolve-approval",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(variables),
        },
      );

      if (res.ok) {
        return { status: "ok" };
      }

      const body = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;

      // 409 (stale/duplicate/ineligible decision) is an expected outcome:
      // resolve it so onSuccess refreshes the panels that showed stale state.
      if (res.status === 409) {
        return { status: "conflict", error: body?.error ?? null };
      }

      throw new ApiCallError(
        body?.error ?? `API error ${res.status}`,
        body?.code,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

/**
 * Live edits to the active graph-workflow execution (docs/design/cc-cli/06). The
 * caller supplies the ops plus the concurrency guard (`executionId` +
 * `baseLiveRevision`) read from the already-fetched execution; the mutation always
 * self-identifies as `source: "ui"` (D15). On a `revision_conflict` the execution
 * changed under the operator — refetch it so the retry carries the fresh revision.
 */
export interface RuntimeEditGraphWorkflowInput {
  executionId: string;
  baseLiveRevision: number;
  operations: WorkflowLiveEditOperation[];
}

export function useRuntimeEditGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RuntimeEditGraphWorkflowInput) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/runtime-edits`,
        "runtime-edit-graph-workflow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            executionId: input.executionId,
            baseLiveRevision: input.baseLiveRevision,
            source: "ui",
            operations: input.operations,
          } satisfies WorkflowLiveEditRequest),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: graphWorkflowExecutionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
    onError: (error) => {
      if (error instanceof ApiCallError && error.code === "revision_conflict") {
        void queryClient.invalidateQueries({
          queryKey: graphWorkflowExecutionKeys.detail(projectName, sessionName),
        });
      }
    },
  });
}

export function useCollaborationStartMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      brief: string;
      submittedPendingPromptText: string;
      negotiationRounds: number;
      autonomousResolutionThreshold: "none" | "minor" | "major" | "blocking";
      conversationId: string;
      backend?: AgentBackendId;
      modelId?: string;
      effort?: string;
      images?: ImagePayload[];
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/collaboration`,
        "collaboration-start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        collaborationStartResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.all,
      });
    },
  });
}

export function useCollaborationStopMutation(
  projectName: string,
  sessionName: string,
  workflowId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { conversationId: string }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/collaboration/${encodeURIComponent(workflowId)}/stop`,
        "collaboration-stop",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: params.conversationId }),
        },
        collaborationStopResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.detail(
          projectName,
          sessionName,
          workflowId,
        ),
      });
    },
  });
}

export function useCollaborationResumeMutation(
  projectName: string,
  sessionName: string,
  workflowId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      resumeToken: string;
      conversationId: string;
      userAnswers?: Record<string, string>;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/collaboration/${encodeURIComponent(workflowId)}/resume`,
        "collaboration-resume",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resumeToken: params.resumeToken,
            conversationId: params.conversationId,
            userAnswers: params.userAnswers ?? {},
          }),
        },
        collaborationResumeResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: collaborationKeys.detail(
          projectName,
          sessionName,
          workflowId,
        ),
      });
    },
  });
}
