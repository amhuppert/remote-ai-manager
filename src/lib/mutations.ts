import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectKeys, sessionKeys, conversationKeys } from "@/lib/query-keys";
import { tracedFetch } from "@/lib/traced-fetch";
import type { SessionState, ConversationState } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Error thrown when a mutation API call fails. Carries optional structured fields. */
export class ApiCallError extends Error {
  readonly code?: string;
  readonly output?: string;

  constructor(message: string, code?: string, output?: string) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.output = output;
  }
}

async function mutationFetch<T = unknown>(
  url: string,
  traceLabel: string,
  options: RequestInit,
): Promise<T> {
  const res = await tracedFetch(url, traceLabel, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    const apiBody = body as { error?: string; code?: string; output?: string };
    throw new ApiCallError(
      apiBody.error ?? `API error ${res.status}`,
      apiBody.code,
      apiBody.output,
    );
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Session Mutations
// ---------------------------------------------------------------------------

export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionName: string) =>
      mutationFetch<SessionState>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionName }),
        },
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

  return useMutation({
    mutationFn: (message: string) =>
      mutationFetch<{ success: boolean; hash: string }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commit`,
        "commit-changes",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      ),
    onSuccess: () => {
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

  return useMutation({
    mutationFn: (message: string) =>
      mutationFetch<{ success: boolean; mergeHash: string }>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/merge`,
        "merge-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        },
      ),
    onSuccess: () => {
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
      mutationFetch<ConversationState>(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        "create-conversation",
        { method: "POST" },
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
      const previous = queryClient.getQueryData<ConversationState[]>(listKey);
      queryClient.setQueryData<ConversationState[]>(listKey, (old) =>
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
