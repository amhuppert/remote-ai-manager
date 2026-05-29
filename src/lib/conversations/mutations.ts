import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { conversationKeys } from "./query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import {
  conversationStateSchema,
  forkResponseSchema,
  type ConversationState,
} from "./schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { mutationFetch } from "@/lib/api/fetcher";

function renameInActiveCache(
  client: QueryClient,
  conversationId: string,
  name: string,
): ActiveConversationsResponse | undefined {
  const activeKey = conversationKeys.active();
  const previous = client.getQueryData<ActiveConversationsResponse>(activeKey);
  client.setQueryData<ActiveConversationsResponse>(activeKey, (old) =>
    old === undefined
      ? old
      : {
          ...old,
          conversations: old.conversations.map((c) =>
            c.id === conversationId ? { ...c, name } : c,
          ),
        },
  );
  return previous;
}

function removeFromActiveCacheIfArchived(
  client: QueryClient,
  conversationId: string,
  archived: boolean,
): ActiveConversationsResponse | undefined {
  const activeKey = conversationKeys.active();
  const previous = client.getQueryData<ActiveConversationsResponse>(activeKey);
  if (!archived) return previous;
  client.setQueryData<ActiveConversationsResponse>(activeKey, (old) =>
    old === undefined
      ? old
      : {
          ...old,
          conversations: old.conversations.filter(
            (c) => c.id !== conversationId,
          ),
        },
  );
  return previous;
}

function restoreActiveCache(
  client: QueryClient,
  previous: ActiveConversationsResponse | undefined,
): void {
  if (previous !== undefined) {
    client.setQueryData(conversationKeys.active(), previous);
  }
}

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
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previous = queryClient.getQueryData<ConversationState[]>(listKey);
      queryClient.setQueryData<ConversationState[]>(listKey, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, archived } : c)),
      );
      const previousActive = removeFromActiveCacheIfArchived(
        queryClient,
        conversationId,
        archived,
      );
      return { previous, previousActive };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
      restoreActiveCache(queryClient, context?.previousActive);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
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
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previous = queryClient.getQueryData<ConversationState[]>(listKey);
      queryClient.setQueryData<ConversationState[]>(listKey, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, name } : c)),
      );
      const previousActive = renameInActiveCache(
        queryClient,
        conversationId,
        name,
      );
      return { previous, previousActive };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
      restoreActiveCache(queryClient, context?.previousActive);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: listKey });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
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
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
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
    onMutate: async ({
      projectName,
      sessionName,
      conversationId,
      archived,
    }) => {
      const listKey = conversationKeys.list(projectName, sessionName);
      await queryClient.cancelQueries({ queryKey: listKey });
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previousList =
        queryClient.getQueryData<ConversationState[]>(listKey);
      queryClient.setQueryData<ConversationState[]>(listKey, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, archived } : c)),
      );
      const previousActive = removeFromActiveCacheIfArchived(
        queryClient,
        conversationId,
        archived,
      );
      return { previousList, previousActive, listKey };
    },
    onError: (_err, _vars, context) => {
      if (
        context?.previousList !== undefined &&
        context.listKey !== undefined
      ) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
      restoreActiveCache(queryClient, context?.previousActive);
    },
    onSettled: (_data, _err, { projectName, sessionName }) => {
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
    onMutate: async ({ projectName, sessionName, conversationId, name }) => {
      const listKey = conversationKeys.list(projectName, sessionName);
      await queryClient.cancelQueries({ queryKey: listKey });
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previousList =
        queryClient.getQueryData<ConversationState[]>(listKey);
      queryClient.setQueryData<ConversationState[]>(listKey, (old) =>
        old?.map((c) => (c.id === conversationId ? { ...c, name } : c)),
      );
      const previousActive = renameInActiveCache(
        queryClient,
        conversationId,
        name,
      );
      return { previousList, previousActive, listKey };
    },
    onError: (_err, _vars, context) => {
      if (
        context?.previousList !== undefined &&
        context.listKey !== undefined
      ) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
      restoreActiveCache(queryClient, context?.previousActive);
    },
    onSettled: (_data, _err, { projectName, sessionName }) => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}
