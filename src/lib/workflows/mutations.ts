import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  workflowDefinitionKeys,
  collaborationKeys,
} from "@/lib/workflows/query-keys";
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

export function useStartGraphWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (definitionId: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/graph-workflow`,
        "start-graph-workflow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ definitionId }),
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
