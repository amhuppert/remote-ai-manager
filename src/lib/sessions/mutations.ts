import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  sessionStateSchema,
  bulkSessionsResponseSchema,
  finalizeInitResponseSchema,
  type BulkSessionsRequest,
  type BulkSessionsResponse,
} from "@/lib/sessions/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
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

export function useBulkSessionsMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: BulkSessionsRequest): Promise<BulkSessionsResponse> =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/bulk`,
        "bulk-sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        },
        bulkSessionsResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

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
