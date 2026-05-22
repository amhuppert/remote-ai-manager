import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  projectKeys,
  configKeys,
  sessionKeys,
  conversationKeys,
  workflowDefinitionKeys,
  presetKeys,
  notificationKeys,
  mcpConfigKeys,
  mcpToolsKeys,
  collaborationKeys,
  debugLogKeys,
} from "@/lib/query-keys";
import { useAddOrUpdateJob } from "@/stores/notification.store";
import {
  sessionStateSchema,
  conversationStateSchema,
  jobDispatchResponseSchema,
  mcpToolInventoryResultSchema,
  forkResponseSchema,
  type McpConfigViewResponse,
  type McpOverrideOperation,
} from "@/lib/schemas";
import {
  mutationFetch,
  finalizeInitResponseSchema,
  fullConfigResponseSchema,
  installPresetResponseSchema,
  workflowDefinitionMutationResponseSchema,
  workflowGeneratedDraftResponseSchema,
  collaborationStartResponseSchema,
  collaborationResumeResponseSchema,
  collaborationStopResponseSchema,
} from "@/lib/api-client";
import type {
  AgentBackendId,
  GlobalConfig,
  ImagePayload,
  SessionState,
  WorkflowPlanRequest,
  WorkflowDefinitionRecord,
  WorkflowRuntimeEditRequest,
} from "@/types";

// Re-export ApiCallError for consumers
export { ApiCallError } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Config Mutations
// ---------------------------------------------------------------------------

export function useUpdateConfigMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<GlobalConfig>) =>
      mutationFetch(
        "/api/config",
        "update-config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
        fullConfigResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Session Mutations
// ---------------------------------------------------------------------------

export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      params:
        | {
            mode: "fast";
            sessionName: string;
            tddEnabled?: boolean;
            parentSessionName?: string;
          }
        | {
            mode: "focus";
            objective: string;
            tddEnabled?: boolean;
            parentSessionName?: string;
          }
        | {
            mode: "optimistic";
            instructions: string;
            images?: ImagePayload[];
            tddEnabled?: boolean;
            parentSessionName?: string;
          },
    ) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        sessionStateSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useDeleteSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionName: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(sessionName)}`,
        "delete-session",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useArchiveSessionMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (archived: boolean) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
        "archive-session",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useTddToggleMutation(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tddEnabled: boolean) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/tdd`,
        "tdd-toggle",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tddEnabled }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Project Mutations
// ---------------------------------------------------------------------------

export function useArchiveProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      archived,
    }: {
      projectName: string;
      archived: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/archive`,
        "archive-project",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.list(),
      });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
    },
  });
}

export function useDeleteProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      projectPath,
    }: {
      projectName: string;
      projectPath: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}?projectPath=${encodeURIComponent(projectPath)}`,
        "delete-project",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.list(),
      });
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
    },
  });
}

export function usePinProjectMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      pinned,
    }: {
      projectName: string;
      pinned: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/pin`,
        "pin-project",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectKeys.preferences(),
      });
    },
  });
}

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

export function useGenerateWorkflowDraftMutation(projectName: string) {
  return useMutation({
    mutationFn: (request: WorkflowPlanRequest) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workflows/generate`,
        "generate-workflow-draft",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
        workflowGeneratedDraftResponseSchema,
      ),
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

// ---------------------------------------------------------------------------
// Git Mutations
// ---------------------------------------------------------------------------

export function useCommitMutation(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: (message: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commit`,
        "commit-changes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.diff(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.commits(projectName, sessionName),
      });
    },
  });
}

export function useMergeMutation(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`,
        "merge-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoResolve: false }),
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Conversation Mutations
// ---------------------------------------------------------------------------

export function useCreateConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        "create-conversation",
        { method: "POST" },
        conversationStateSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
    },
  });
}

export function useArchiveConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const listKey = conversationKeys.list(projectName, sessionName);

  return useMutation({
    mutationFn: ({
      conversationId,
      archived,
    }: {
      conversationId: string;
      archived: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/archive`,
        "archive-conversation",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onMutate: async ({ conversationId, archived }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<import("@/types").ConversationState[]>(
          listKey,
        );
      queryClient.setQueryData<import("@/types").ConversationState[]>(
        listKey,
        (old) =>
          old?.map((c) => (c.id === conversationId ? { ...c, archived } : c)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function useRenameConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const listKey = conversationKeys.list(projectName, sessionName);

  return useMutation({
    mutationFn: ({
      conversationId,
      name,
    }: {
      conversationId: string;
      name: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/rename`,
        "rename-conversation",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      ),
    onMutate: async ({ conversationId, name }) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<import("@/types").ConversationState[]>(
          listKey,
        );
      queryClient.setQueryData<import("@/types").ConversationState[]>(
        listKey,
        (old) =>
          old?.map((c) => (c.id === conversationId ? { ...c, name } : c)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
    },
  });
}

export function useAnswerQuestionMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      questionId,
      answers,
    }: {
      questionId: string;
      answers: Record<string, string>;
    }) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, answers }),
        },
      );

      if (res.ok) {
        return { status: "ok" as const };
      }

      if (res.status === 410) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        return { status: "gone" as const, error: body?.error ?? null };
      }

      throw new Error(`Answer submission failed: ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.messages(
          projectName,
          sessionName,
          conversationId,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

/** Build the pending-prompt persistence URL for a given conversation. */
export function pendingPromptUrl(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return (
    `/api/projects/${encodeURIComponent(projectName)}/sessions/` +
    `${encodeURIComponent(sessionName)}/conversations/` +
    `${encodeURIComponent(conversationId)}/pending-prompt`
  );
}

/**
 * Fire-and-forget pending-prompt save via navigator.sendBeacon, used during
 * page unload when the regular mutation's fetch would be aborted. Returns
 * true when the beacon was queued by the browser, false otherwise (e.g., no
 * navigator, no sendBeacon, or the user agent rejected the payload).
 */
export function sendPendingPromptBeacon(
  projectName: string,
  sessionName: string,
  conversationId: string,
  text: string | null,
): boolean {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return false;
  const url = pendingPromptUrl(projectName, sessionName, conversationId);
  const blob = new Blob([JSON.stringify({ text })], {
    type: "application/json",
  });
  return navigator.sendBeacon(url, blob);
}

/**
 * Persist or clear the in-progress prompt text on a conversation.
 *
 * Used by the prompt input to keep typed text alive across navigations and
 * reloads. Optimistically updates the cached session detail so that a
 * subsequent re-mount can read the latest value before the server roundtrip
 * settles. Errors are intentionally swallowed at the mutation layer — the user
 * is still typing and a transient save failure shouldn't blow away their input;
 * the next keystroke will retry the save.
 */
export function useUpdatePendingPromptTextMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const detailKey = sessionKeys.detail(projectName, sessionName);

  return useMutation({
    mutationFn: ({
      conversationId,
      text,
    }: {
      conversationId: string;
      text: string | null;
    }) =>
      mutationFetch(
        pendingPromptUrl(projectName, sessionName, conversationId),
        "update-pending-prompt-text",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        },
      ),
    onMutate: async ({ conversationId, text }) => {
      await queryClient.cancelQueries({ queryKey: detailKey });
      const previous = queryClient.getQueryData<SessionState>(detailKey);
      if (previous) {
        queryClient.setQueryData<SessionState>(detailKey, {
          ...previous,
          conversations: previous.conversations.map((c) =>
            c.id === conversationId ? { ...c, pendingPromptText: text } : c,
          ),
        });
      }
      return { previous };
    },
  });
}

/**
 * Fork a conversation at a message index.
 *
 * Awaits the session-detail cache invalidation in onSuccess so callers that
 * navigate to the newly created conversation can rely on it being present
 * in the cache by the time the destination page mounts.
 */
export function useForkConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      messageIndex,
    }: {
      conversationId: string;
      messageIndex: number;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/fork`,
        "fork-conversation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageIndex }),
        },
        forkResponseSchema,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sessionKeys.detail(projectName, sessionName),
        }),
        queryClient.invalidateQueries({
          queryKey: conversationKeys.list(projectName, sessionName),
        }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Focus Initialization Mutations
// ---------------------------------------------------------------------------

export function useFinalizeInitializationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/finalize-initialization`,
        "finalize-initialization",
        { method: "POST" },
        finalizeInitResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Generic Conversation Mutations (project/session as variables)
// ---------------------------------------------------------------------------

/**
 * Archive/unarchive a conversation from any project/session.
 * Unlike `useArchiveConversationMutation`, this accepts project/session as
 * part of the mutation variables — useful for the active conversations tab
 * where conversations span multiple projects.
 */
export function useGenericArchiveConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      sessionName,
      conversationId,
      archived,
    }: {
      projectName: string;
      sessionName: string;
      conversationId: string;
      archived: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/archive`,
        "archive-conversation",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onSuccess: (_data, { projectName, sessionName }) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

/**
 * Archive a session from any project. Accepts project/session as mutation
 * variables — used from the active conversations sidebar where rows can
 * belong to sessions other than the one this component is bound to.
 */
export function useGenericArchiveSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      sessionName,
      archived,
    }: {
      projectName: string;
      sessionName: string;
      archived: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
        "archive-session",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onSuccess: (_data, { projectName }) => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

/**
 * Rename a conversation from any project/session.
 * Accepts project/session as part of the mutation variables.
 */
export function useGenericRenameConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      sessionName,
      conversationId,
      name,
    }: {
      projectName: string;
      sessionName: string;
      conversationId: string;
      name: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/rename`,
        "rename-conversation",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      ),
    onSuccess: (_data, { projectName, sessionName }) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Preset Mutations
// ---------------------------------------------------------------------------

// Preset Mutations
// ---------------------------------------------------------------------------

export function useInstallPresetMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { presetId: string; subdir?: string }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/dev-servers/presets/install`,
        "install-preset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        installPresetResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: presetKeys.list(projectName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Notification Mutations
// ---------------------------------------------------------------------------

export function useMarkNotificationAsReadMutation() {
  const queryClient = useQueryClient();
  const listKey = notificationKeys.list();

  return useMutation({
    mutationFn: (notificationId: string) =>
      mutationFetch(
        `/api/notifications/${encodeURIComponent(notificationId)}`,
        "mark-notification-read",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        },
      ),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<import("@/lib/schemas").NotificationsResponse>(
          listKey,
        );
      queryClient.setQueryData<import("@/lib/schemas").NotificationsResponse>(
        listKey,
        (old) => {
          if (!old) return old;
          const target = old.notifications.find((n) => n.id === notificationId);
          const wasUnread = target ? !target.read : false;
          return {
            ...old,
            notifications: old.notifications.map((n) =>
              n.id === notificationId ? { ...n, read: true } : n,
            ),
            unreadCount: wasUnread
              ? Math.max(0, old.unreadCount - 1)
              : old.unreadCount,
          };
        },
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    },
  });
}

export function useMarkAllNotificationsAsReadMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        "/api/notifications/mark-all-read",
        "mark-all-notifications-read",
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    },
  });
}

export function useDismissNotificationMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (notificationId: string) =>
      mutationFetch(
        `/api/notifications/${encodeURIComponent(notificationId)}`,
        "dismiss-notification",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Smart Merge (with autoResolve option)
// ---------------------------------------------------------------------------

export function useSmartMergeMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: (params: { autoResolve: boolean }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`,
        "smart-merge-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoResolve: params.autoResolve }),
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Conflict Resolution
// ---------------------------------------------------------------------------

export function useResolveConflictsMutation(
  projectName: string,
  sessionName: string,
) {
  const addOrUpdateJob = useAddOrUpdateJob();

  return useMutation({
    mutationFn: (
      decisions: Array<{
        file: string;
        decision: string;
        feedback?: string;
      }>,
    ) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/resolve-conflicts`,
        "resolve-conflicts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisions }),
        },
        jobDispatchResponseSchema,
      ),
    onSuccess: (data) => {
      addOrUpdateJob({
        type: "job-status",
        jobType: data.jobType,
        status: "running",
        projectName,
        sessionName,
        jobId: data.jobId,
        branchName: data.branchName,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Debug Mode Mutations
// ---------------------------------------------------------------------------

function debugModeUrl(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/debug-mode`;
}

export function useDebugModeToggleMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (action: "enter" | "exit") =>
      mutationFetch(
        debugModeUrl(projectName, sessionName, conversationId),
        "debug-mode-toggle",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
    },
  });
}

export function useDebugPhaseMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      action:
        | "mark_reproduced"
        | "mark_fix_verified"
        | "mark_fix_failed"
        | "revert_to_awaiting_reproduction"
        | "revert_to_awaiting_verification"
        | "retry_turn",
    ) =>
      mutationFetch(
        debugModeUrl(projectName, sessionName, conversationId),
        "debug-phase-transition",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useDebugRecordingMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  const queryKey = sessionKeys.detail(projectName, sessionName);

  return useMutation({
    mutationFn: (recording: boolean) =>
      mutationFetch(
        `${debugModeUrl(projectName, sessionName, conversationId)}/recording`,
        "debug-recording-toggle",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recording }),
        },
      ),
    onMutate: async (recording) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SessionState>(queryKey);
      if (previous) {
        queryClient.setQueryData<SessionState>(queryKey, {
          ...previous,
          conversations: previous.conversations.map((c) =>
            c.id === conversationId && c.debugMode
              ? { ...c, debugMode: { ...c.debugMode, recording } }
              : c,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _recording, context) => {
      if (context?.previous) {
        queryClient.setQueryData<SessionState>(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useClearDebugLogsMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        `${debugModeUrl(projectName, sessionName, conversationId)}/logs`,
        "clear-debug-logs",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: debugLogKeys.stats(projectName, sessionName, conversationId),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// MCP Config Mutations
// ---------------------------------------------------------------------------

export type McpMutationScope =
  | { level: "global" }
  | { level: "project"; projectName: string }
  | { level: "session"; projectName: string; sessionName: string }
  | {
      level: "conversation";
      projectName: string;
      sessionName: string;
      conversationId: string;
    };

function mcpScopeUrl(scope: McpMutationScope): string {
  switch (scope.level) {
    case "global":
      return "/api/config/mcp";
    case "project":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/mcp-config`;
    case "session":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/mcp-config`;
    case "conversation":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/conversations/${encodeURIComponent(scope.conversationId)}/mcp-config`;
  }
}

function mcpScopeQueryKey(scope: McpMutationScope): QueryKey {
  switch (scope.level) {
    case "global":
      return mcpConfigKeys.global();
    case "project":
      return mcpConfigKeys.project(scope.projectName);
    case "session":
      return mcpConfigKeys.session(scope.projectName, scope.sessionName);
    case "conversation":
      return mcpConfigKeys.conversation(
        scope.projectName,
        scope.sessionName,
        scope.conversationId,
      );
  }
}

function scopedInvalidations(scope: McpMutationScope): readonly QueryKey[] {
  switch (scope.level) {
    case "global":
      return [mcpConfigKeys.all];
    case "project":
      return [mcpConfigKeys.project(scope.projectName)];
    case "session":
      return [mcpConfigKeys.session(scope.projectName, scope.sessionName)];
    case "conversation":
      return [
        mcpConfigKeys.conversation(
          scope.projectName,
          scope.sessionName,
          scope.conversationId,
        ),
      ];
  }
}

/**
 * Optimistically edit every matching cached MCP view at the given scope and
 * return a rollback function.
 */
function applyOptimisticViewUpdate(
  queryClient: ReturnType<typeof useQueryClient>,
  scopeKey: QueryKey,
  edit: (
    server: McpConfigViewResponse["servers"][number],
  ) => McpConfigViewResponse["servers"][number],
  shouldEdit: (server: McpConfigViewResponse["servers"][number]) => boolean,
): () => void {
  const snapshots: Array<readonly [QueryKey, McpConfigViewResponse]> = [];
  const caches = queryClient.getQueryCache().findAll({ queryKey: scopeKey });
  for (const entry of caches) {
    const data = entry.state.data as McpConfigViewResponse | undefined;
    if (!data) continue;
    snapshots.push([entry.queryKey, data]);
    queryClient.setQueryData<McpConfigViewResponse>(entry.queryKey, {
      ...data,
      servers: data.servers.map((s) => (shouldEdit(s) ? edit(s) : s)),
    });
  }
  return () => {
    for (const [key, value] of snapshots) {
      queryClient.setQueryData(key, value);
    }
  };
}

interface PatchContext {
  rollback: () => void;
}

function readEffectiveConfigHash(
  queryClient: ReturnType<typeof useQueryClient>,
  scopeKey: QueryKey,
): string | undefined {
  const cached = queryClient.getQueryData<McpConfigViewResponse>(scopeKey);
  return cached?.effectiveConfigHash;
}

async function patchMcp(
  scope: McpMutationScope,
  operations: readonly McpOverrideOperation[],
  traceLabel: string,
  expectedEffectiveConfigHash?: string,
): Promise<void> {
  await mutationFetch(mcpScopeUrl(scope), traceLabel, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operations,
      ...(expectedEffectiveConfigHash !== undefined
        ? { expectedEffectiveConfigHash }
        : {}),
    }),
  });
}

export function useToggleMcpServerMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<
    void,
    Error,
    { serverKey: string; enabled: boolean },
    PatchContext
  >({
    mutationFn: ({ serverKey, enabled }) =>
      patchMcp(
        scope,
        [{ type: "set-server-enabled", serverKey, enabled }],
        "mcp-toggle-server",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, enabled }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (s) => ({ ...s, enabled, pending: true }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useResetMcpServerMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<void, Error, { serverKey: string }, PatchContext>({
    mutationFn: ({ serverKey }) =>
      patchMcp(
        scope,
        [{ type: "reset-server", serverKey }],
        "mcp-reset-server",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (s) => ({ ...s, pending: true }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useToggleMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<
    void,
    Error,
    { serverKey: string; toolName: string; enabled: boolean },
    PatchContext
  >({
    mutationFn: ({ serverKey, toolName, enabled }) =>
      patchMcp(
        scope,
        [{ type: "set-tool-enabled", serverKey, toolName, enabled }],
        "mcp-toggle-tool",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, toolName, enabled }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (server) => ({
          ...server,
          pending: true,
          tools: {
            ...server.tools,
            tools: server.tools.tools.map((t) =>
              t.name === toolName ? { ...t, enabled, pending: true } : t,
            ),
          },
        }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useResetMcpToolMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();
  const scopeKey = mcpScopeQueryKey(scope);

  return useMutation<
    void,
    Error,
    { serverKey: string; toolName: string },
    PatchContext
  >({
    mutationFn: ({ serverKey, toolName }) =>
      patchMcp(
        scope,
        [{ type: "reset-tool", serverKey, toolName }],
        "mcp-reset-tool",
        readEffectiveConfigHash(queryClient, scopeKey),
      ),
    onMutate: async ({ serverKey, toolName }) => {
      await queryClient.cancelQueries({ queryKey: scopeKey });
      const rollback = applyOptimisticViewUpdate(
        queryClient,
        scopeKey,
        (server) => ({
          ...server,
          pending: true,
          tools: {
            ...server.tools,
            tools: server.tools.tools.map((t) =>
              t.name === toolName ? { ...t, pending: true } : t,
            ),
          },
        }),
        (s) => s.serverKey === serverKey,
      );
      return { rollback };
    },
    onError: (_err, _vars, context) => {
      context?.rollback();
    },
    onSettled: () => {
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

function mcpScopeToolsUrl(scope: McpMutationScope, serverKey: string): string {
  const encodedServer = encodeURIComponent(serverKey);
  switch (scope.level) {
    case "global":
      return `/api/config/mcp/tools/${encodedServer}`;
    case "project":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/mcp-config/tools/${encodedServer}`;
    case "session":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/mcp-config/tools/${encodedServer}`;
    case "conversation":
      return `/api/projects/${encodeURIComponent(scope.projectName)}/sessions/${encodeURIComponent(scope.sessionName)}/conversations/${encodeURIComponent(scope.conversationId)}/mcp-config/tools/${encodedServer}`;
  }
}

export function useRefreshMcpToolsMutation(scope: McpMutationScope) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (serverKey: string) =>
      mutationFetch(
        mcpScopeToolsUrl(scope, serverKey),
        "mcp-refresh-tools",
        { method: "POST" },
        mcpToolInventoryResultSchema,
      ),
    onSuccess: (_data, serverKey) => {
      if (scope.level === "conversation") {
        void queryClient.invalidateQueries({
          queryKey: mcpToolsKeys.inventory(
            scope.projectName,
            scope.sessionName,
            scope.conversationId,
            serverKey,
          ),
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: mcpToolsKeys.all });
      }
      for (const key of scopedInvalidations(scope)) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Collaboration Mutations
// ---------------------------------------------------------------------------

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
