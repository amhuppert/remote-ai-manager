import { useCallback, useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
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
    onSuccess: () => invalidateProjectLifecycle(queryClient, projectName),
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
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.list(projectName),
      }),
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
 * (and the global SSE→invalidation path once the notifications extension wires
 * `scope:"project"`). Prompt errors (busy / backend-mismatch / validation) are
 * surfaced through the error envelope without redefining the foundation's codes.
 */
export function useSendProjectPrompt(
  projectName: string,
): UseSendProjectPromptResult {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ProjectPromptError | null>(null);
  const inFlight = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const send = useCallback(
    async (input: SendProjectPromptInput): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSending(true);
      setError(null);

      const { conversationId } = input;
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
    [projectName, queryClient],
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
