import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { ApiCallError } from "@/lib/api/errors";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import {
  workflowDefinitionKeys,
  collaborationKeys,
} from "@/lib/workflows/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { workflowDefinitionMutationResponseSchema } from "@/lib/workflow-definitions/schemas";
import {
  collaborationStartResponseSchema,
  collaborationResumeResponseSchema,
  collaborationStopResponseSchema,
} from "@/lib/collaboration/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  WorkflowDefinitionRecord,
  WorkflowRuntimeEditRequest,
} from "@/lib/workflows/schemas";
export function useCreateWorkflowDefinitionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: {
      name: string;
      description?: string | null;
      definition: WorkflowDefinitionRecord["definition"];
      layout: WorkflowDefinitionRecord["layout"];
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows`,
        "create-workflow-definition",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
        workflowDefinitionMutationResponseSchema,
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: workflowDefinitionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowDefinitionKeys.detail(projectName, data.item.id),
      });
    },
  });
}

export function useUpdateWorkflowDefinitionMutation(
  projectName: string,
  workflowId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: {
      name: string;
      description?: string | null;
      definition: WorkflowDefinitionRecord["definition"];
      layout: WorkflowDefinitionRecord["layout"];
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows/${encodeURIComponent(workflowId)}`,
        "update-workflow-definition",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        },
        workflowDefinitionMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowDefinitionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: workflowDefinitionKeys.detail(projectName, workflowId),
      });
    },
  });
}

export function useDeleteWorkflowDefinitionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (workflowId: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows/${encodeURIComponent(workflowId)}`,
        "delete-workflow-definition",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowDefinitionKeys.list(projectName),
      });
    },
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

export function useResumeGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/resume`,
        "resume-graph-workflow",
        { method: "POST" },
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

export function useRuntimeEditGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: WorkflowRuntimeEditRequest) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow/runtime-edits`,
        "runtime-edit-graph-workflow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
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
      negotiationRounds: number;
      autonomousResolutionThreshold: "none" | "minor" | "major" | "blocking";
      conversationId: string;
      backend?: AgentBackendId;
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
