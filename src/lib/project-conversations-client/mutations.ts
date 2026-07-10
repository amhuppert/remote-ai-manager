import { useCallback, useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  conversationStateSchema,
  type ConversationState,
  type MessageContentBlock,
} from "@/lib/conversations/schemas";
import {
  useSubmitPrompt,
  useCompletePrompt,
} from "@/stores/session-detail.store";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { projectConversationKeys } from "./query-keys";

function invalidateProjectLifecycle(
  queryClient: ReturnType<typeof useQueryClient>,
  projectName: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: projectConversationKeys.list(projectName),
  });
  void queryClient.invalidateQueries({
    queryKey: projectConversationKeys.openCount(projectName),
  });
}

/**
 * Cancel in-flight list/open-count fetches and snapshot the list cache for
 * rollback. The open-count query shares the list query key (it derives via
 * `select`), so patching the list cache updates the count optimistically too.
 */
async function snapshotProjectList(
  queryClient: QueryClient,
  projectName: string,
): Promise<ConversationState[] | undefined> {
  await queryClient.cancelQueries({
    queryKey: projectConversationKeys.list(projectName),
  });
  await queryClient.cancelQueries({
    queryKey: projectConversationKeys.openCount(projectName),
  });
  return queryClient.getQueryData<ConversationState[]>(
    projectConversationKeys.list(projectName),
  );
}

function patchProjectListConversation(
  queryClient: QueryClient,
  projectName: string,
  conversationId: string,
  patch: (c: ConversationState) => ConversationState,
): void {
  queryClient.setQueryData<ConversationState[]>(
    projectConversationKeys.list(projectName),
    (old) => old?.map((c) => (c.id === conversationId ? patch(c) : c)),
  );
}

function restoreProjectList(
  queryClient: QueryClient,
  projectName: string,
  previous: ConversationState[] | undefined,
): void {
  if (previous !== undefined) {
    queryClient.setQueryData(
      projectConversationKeys.list(projectName),
      previous,
    );
  }
}

function patchActiveConversation(
  queryClient: QueryClient,
  conversationId: string,
  patch: (c: ActiveConversation) => ActiveConversation,
): ActiveConversationsResponse | undefined {
  const activeKey = conversationKeys.active();
  const previous =
    queryClient.getQueryData<ActiveConversationsResponse>(activeKey);
  queryClient.setQueryData<ActiveConversationsResponse>(activeKey, (old) =>
    old === undefined
      ? old
      : {
          ...old,
          conversations: old.conversations.map((c) =>
            c.id === conversationId ? patch(c) : c,
          ),
        },
  );
  return previous;
}

function restoreActiveConversations(
  queryClient: QueryClient,
  previous: ActiveConversationsResponse | undefined,
): void {
  if (previous !== undefined) {
    queryClient.setQueryData(conversationKeys.active(), previous);
  }
}

/** Create a new project conversation (defaults backend via config when omitted). */
export function useCreateProjectConversation(
  projectName: string,
): UseMutationResult<
  ConversationState,
  Error,
  { agentBackend?: AgentBackendId; name?: string } | void
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/conversations`,
        "create-project-conversation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input ?? {}),
        },
        conversationStateSchema,
      ),
    onSuccess: () => invalidateProjectLifecycle(queryClient, projectName),
  });
}

function useProjectOpenMutation(
  projectName: string,
  open: boolean,
  traceLabel: string,
): UseMutationResult<unknown, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/open`,
        traceLabel,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ open }),
        },
      ),
    onMutate: async (conversationId) => {
      const previousList = await snapshotProjectList(queryClient, projectName);
      patchProjectListConversation(
        queryClient,
        projectName,
        conversationId,
        (c) => ({ ...c, open }),
      );
      return { previousList };
    },
    onError: (_err, _conversationId, context) => {
      restoreProjectList(queryClient, projectName, context?.previousList);
    },
    onSettled: () => invalidateProjectLifecycle(queryClient, projectName),
  });
}

/** Close a project conversation (open:false) — drops its cockpit tab. */
export function useCloseProjectConversation(
  projectName: string,
): UseMutationResult<unknown, Error, string> {
  return useProjectOpenMutation(
    projectName,
    false,
    "close-project-conversation",
  );
}

/** Reopen a closed project conversation (open:true) — restores its tab. */
export function useReopenProjectConversation(
  projectName: string,
): UseMutationResult<unknown, Error, string> {
  return useProjectOpenMutation(
    projectName,
    true,
    "reopen-project-conversation",
  );
}

/**
 * Mark a project conversation as read — clears the `unread` flag set when a turn
 * finishes, so it drops out of the Active Conversations "Finished — unread"
 * slot. Mirrors the session `useMarkConversationReadMutation`; invalidates the
 * shared active-conversations query that feeds the rail.
 */
export function useMarkProjectConversationReadMutation(): UseMutationResult<
  unknown,
  Error,
  { projectName: string; conversationId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectName,
      conversationId,
    }: {
      projectName: string;
      conversationId: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/mark-read`,
        "mark-project-conversation-read",
        { method: "POST" },
      ),
    onMutate: async ({ conversationId }) => {
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previousActive = patchActiveConversation(
        queryClient,
        conversationId,
        (c) => ({ ...c, unread: false }),
      );
      return { previousActive };
    },
    onError: (_err, _vars, context) => {
      restoreActiveConversations(queryClient, context?.previousActive);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

/** Rename a project conversation. */
export function useRenameProjectConversation(
  projectName: string,
): UseMutationResult<unknown, Error, { conversationId: string; name: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      name,
    }: {
      conversationId: string;
      name: string;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/rename`,
        "rename-project-conversation",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      ),
    onMutate: async ({ conversationId, name }) => {
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      const previousList = await snapshotProjectList(queryClient, projectName);
      patchProjectListConversation(
        queryClient,
        projectName,
        conversationId,
        (c) => ({ ...c, name }),
      );
      const previousActive = patchActiveConversation(
        queryClient,
        conversationId,
        (c) => ({ ...c, name }),
      );
      return { previousList, previousActive };
    },
    onError: (_err, _vars, context) => {
      restoreProjectList(queryClient, projectName, context?.previousList);
      restoreActiveConversations(queryClient, context?.previousActive);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

export interface SendProjectPromptInput {
  /** `null` ⇒ create-and-send the first project conversation (PLC-5). */
  conversationId: string | null;
  text: string;
  images?: ImagePayload[];
  backend?: AgentBackendId;
  modelId?: string;
  effort?: string;
}

export interface ProjectPromptError {
  message: string;
  /** Foundation error code (e.g. BACKEND_MISMATCH, VALIDATION_ERROR). */
  code?: string;
}

export interface UseSendProjectPromptResult {
  send(input: SendProjectPromptInput): Promise<void>;
  sending: boolean;
  error: ProjectPromptError | null;
  clearError(): void;
}

/**
 * Send a turn to the foundation's project prompt route. With `conversationId:
 * null` it posts to the create-and-send entry (`POST /api/projects/[name]/prompt`)
 * so the foundation creates the first conversation; otherwise it posts to the
 * per-conversation prompt route. The SSE stream is read to completion so we know
 * when to invalidate; transcript/list updates ride React Query invalidation
 * and the global SSE→invalidation path (NotificationListener handles
 * `scope:"project"` events). Prompt errors (busy / backend-mismatch / validation) are
 * surfaced through the error envelope without redefining the foundation's codes.
 */
export function useSendProjectPrompt(
  projectName: string,
): UseSendProjectPromptResult {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ProjectPromptError | null>(null);
  const inFlight = useRef(false);
  const submitPrompt = useSubmitPrompt();
  const completePrompt = useCompletePrompt();

  const clearError = useCallback(() => setError(null), []);

  const send = useCallback(
    async (input: SendProjectPromptInput): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setError(null);

      const { conversationId } = input;
      // Mark the target conversation's keyed in-flight state so its transcript
      // surfaces (typing indicator) react to this send. The create-and-send
      // path has no conversation id yet — the first-run view has no transcript
      // to indicate on, so it rides the local `sending` flag alone.
      if (conversationId !== null) {
        const cached = queryClient.getQueryData(
          projectConversationKeys.messages(projectName, conversationId),
        );
        const userContent: MessageContentBlock[] = [
          ...(input.text.trim()
            ? [{ type: "text" as const, text: input.text.trim() }]
            : []),
          ...(input.images ?? []).map((img) => ({
            type: "image" as const,
            mediaType: img.mediaType,
            base64Data: img.base64Data,
          })),
        ];
        submitPrompt(
          conversationId,
          userContent,
          Array.isArray(cached) ? cached.length : 0,
        );
      }
      const url =
        conversationId === null
          ? `/api/projects/${encodeURIComponent(projectName)}/prompt`
          : `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/prompt`;

      const body: Record<string, unknown> = { prompt: input.text };
      if (input.modelId !== undefined) body.modelId = input.modelId;
      if (input.effort !== undefined) body.effort = input.effort;
      if (input.images !== undefined && input.images.length > 0)
        body.images = input.images;
      if (input.backend !== undefined) body.backend = input.backend;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          setError({
            message: errBody?.error ?? `Prompt failed (${res.status})`,
            ...(errBody?.code !== undefined ? { code: errBody.code } : {}),
          });
          return;
        }

        await consumePromptStream(res, (frame) => {
          if (frame.event === "error") {
            setError({
              message: frame.data.message ?? "Prompt failed",
              ...(frame.data.code !== undefined
                ? { code: frame.data.code }
                : {}),
            });
          }
        });
      } catch {
        setError({ message: "Failed to send prompt" });
      } finally {
        inFlight.current = false;
        setSending(false);
        if (conversationId !== null) completePrompt(conversationId);
        invalidateProjectLifecycle(queryClient, projectName);
        if (conversationId !== null) {
          void queryClient.invalidateQueries({
            queryKey: projectConversationKeys.messages(
              projectName,
              conversationId,
            ),
          });
        }
      }
    },
    [projectName, queryClient, submitPrompt, completePrompt],
  );

  return { send, sending, error, clearError };
}

interface PromptStreamFrame {
  event: string;
  data: { message?: string; code?: string };
}

/** Read a `text/event-stream` body to completion, surfacing parsed frames. */
async function consumePromptStream(
  res: Response,
  onFrame: (frame: PromptStreamFrame) => void,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = "";
      let dataRaw = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) dataRaw = line.slice(6);
      }
      if (!event) continue;
      let data: { message?: string; code?: string } = {};
      if (dataRaw) {
        try {
          data = JSON.parse(dataRaw) as { message?: string; code?: string };
        } catch {
          data = {};
        }
      }
      onFrame({ event, data });
      if (event === "done") return;
    }
  }
}
