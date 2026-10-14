"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { collaborationKeys } from "./query-keys";
import {
  collaborationStartResponseSchema,
  collaborationResumeResponseSchema,
  collaborationStopResponseSchema,
} from "./schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
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
      modelSelection?: BackendModelSelection;
      agentTwo?: import("@/lib/workflows/collaboration/types").CollaborationAgentTwoRequest;
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
      /** Omitted when resuming a FAILED run: there are no answers to bind. */
      resumeToken?: string;
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
            ...(params.resumeToken !== undefined
              ? { resumeToken: params.resumeToken }
              : {}),
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
