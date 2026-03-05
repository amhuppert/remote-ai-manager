import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  projectKeys,
  sessionKeys,
  conversationKeys,
  workflowKeys,
  presetKeys,
  roadmapItemKeys,
  notificationKeys,
} from "@/lib/query-keys";
import { useAddOrUpdateJob } from "@/stores/notification.store";
import {
  sessionStateSchema,
  conversationStateSchema,
  jobDispatchResponseSchema,
} from "@/lib/schemas";
import {
  mutationFetch,
  workflowMutationResponseSchema,
  statusResponseSchema,
  fixPlanMutationResponseSchema,
  workflowConfigMutationResponseSchema,
  finalizeInitResponseSchema,
  installPresetResponseSchema,
  roadmapItemMutationResponseSchema,
} from "@/lib/api-client";
import type {
  ImagePayload,
  FixPlanTask,
  RalphLoopConfig,
  RoadmapItemType,
  RoadmapItemStatus,
} from "@/types";

// Re-export ApiCallError for consumers
export { ApiCallError } from "@/lib/api-client";

// ---------------------------------------------------------------------------
// Session Mutations
// ---------------------------------------------------------------------------

export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (
      params:
        | { mode: "fast"; sessionName: string }
        | { mode: "focus"; objective: string }
        | {
            mode: "optimistic";
            instructions: string;
            images?: ImagePayload[];
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
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
      if (context?.previous) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
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
        queryKey: conversationKeys.active,
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
        queryKey: conversationKeys.active,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Workflow Mutations
// ---------------------------------------------------------------------------

function workflowUrl(projectName: string, sessionName: string, path = "") {
  return `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/workflow${path}`;
}

export function useStartWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (objective?: string) =>
      mutationFetch(
        workflowUrl(projectName, sessionName),
        "start-workflow",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective }),
        },
        workflowMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useUpdateWorkflowObjectiveMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (objective: string) =>
      mutationFetch(
        workflowUrl(projectName, sessionName),
        "update-workflow-objective",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective }),
        },
        workflowMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
    },
  });
}

export function useConfirmWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/confirm"),
        "confirm-workflow",
        { method: "POST" },
        workflowMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function usePauseWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/pause"),
        "pause-workflow",
        { method: "POST" },
        statusResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
    },
  });
}

export function useResumeWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/resume"),
        "resume-workflow",
        { method: "POST" },
        workflowMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useAbortWorkflowMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/abort"),
        "abort-workflow",
        { method: "POST" },
        statusResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.detail(projectName, sessionName),
      });
    },
  });
}

export function useUpdateFixPlanMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (fixPlan: FixPlanTask[]) =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/fix-plan"),
        "update-fix-plan",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fixPlan }),
        },
        fixPlanMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
    },
  });
}

export function useUpdateWorkflowConfigMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (config: RalphLoopConfig) =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/config"),
        "update-workflow-config",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        },
        workflowConfigMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
    },
  });
}

export function useGeneratePlanMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        workflowUrl(projectName, sessionName, "/generate-plan"),
        "generate-plan",
        { method: "POST" },
        statusResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.status(projectName, sessionName),
      });
    },
  });
}

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
// Roadmap Item Mutations
// ---------------------------------------------------------------------------

function roadmapUrl(projectName: string, path = "") {
  return `/api/projects/${encodeURIComponent(projectName)}/roadmap-items${path}`;
}

export function useCreateRoadmapItemMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: {
      title: string;
      description?: string | null;
      type: RoadmapItemType;
    }) =>
      mutationFetch(
        roadmapUrl(projectName),
        "create-roadmap-item",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        roadmapItemMutationResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapItemKeys.list(projectName),
      });
    },
  });
}

export function useUpdateRoadmapItemMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      itemId,
      ...data
    }: {
      itemId: string;
      title?: string;
      description?: string | null;
      status?: RoadmapItemStatus;
      archived?: boolean;
    }) =>
      mutationFetch(
        roadmapUrl(projectName, `/${encodeURIComponent(itemId)}`),
        "update-roadmap-item",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapItemKeys.list(projectName),
      });
    },
  });
}

export function useDeleteRoadmapItemMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) =>
      mutationFetch(
        roadmapUrl(projectName, `/${encodeURIComponent(itemId)}`),
        "delete-roadmap-item",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapItemKeys.list(projectName),
      });
    },
  });
}

export function useStartRoadmapFocusMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (itemId: string) =>
      mutationFetch(
        roadmapUrl(projectName, `/${encodeURIComponent(itemId)}/focus`),
        "start-roadmap-focus",
        { method: "POST" },
        z.object({ session: sessionStateSchema }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: roadmapItemKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Notification Mutations
// ---------------------------------------------------------------------------

export function useMarkNotificationAsReadMutation() {
  const queryClient = useQueryClient();

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
    onSuccess: () => {
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
