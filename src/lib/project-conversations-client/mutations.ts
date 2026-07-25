import { useCallback, useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { consumePromptStream } from "@/lib/prompt/stream-transport";
import {
  conversationStateSchema,
  type ConversationState,
  type MessageContentBlock,
} from "@/lib/conversations/schemas";
import {
  useSubmitPrompt,
  useReceiveStreamContent,
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
}

function patchedActiveConversation(
  active: ActiveConversationsResponse | undefined,
  conversationId: string,
  patch: (c: ActiveConversation) => ActiveConversation,
): ActiveConversationsResponse | undefined {
  if (active === undefined) return undefined;
  return {
    ...active,
    conversations: active.conversations.map((c) =>
      c.id === conversationId ? patch(c) : c,
    ),
  };
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
  return useMutation(
    createOptimisticMutation(queryClient, {
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
      // The open-conversation count derives from the list cache, so patching
      // the list updates the count optimistically too.
      updates: [
        cacheUpdate<string, ConversationState[]>({
          key: () => projectConversationKeys.list(projectName),
          update: (old, conversationId) =>
            old?.map((c) => (c.id === conversationId ? { ...c, open } : c)),
        }),
      ],
    }),
  );
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
  return useMutation(
    createOptimisticMutation(queryClient, {
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
      updates: [
        cacheUpdate<
          { projectName: string; conversationId: string },
          ActiveConversationsResponse
        >({
          key: () => conversationKeys.active(),
          update: (old, vars) =>
            patchedActiveConversation(old, vars.conversationId, (c) => ({
              ...c,
              unread: false,
            })),
        }),
      ],
    }),
  );
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
  /**
   * Turn state is read per conversation, so a turn in one project conversation
   * never renders on another's tab. `null` reads the create-and-send turn,
   * which has no conversation id to key on until the foundation creates one.
   */
  isSending(conversationId: string | null): boolean;
  errorFor(conversationId: string | null): ProjectPromptError | null;
  clearError(conversationId: string | null): void;
}

/** Busy flag and error envelope for one target's turn. */
interface ProjectTurnState {
  sending: boolean;
  error: ProjectPromptError | null;
}

const IDLE_TURN: ProjectTurnState = { sending: false, error: null };

interface ProjectTurnStates {
  /**
   * The create-and-send turn. It has no conversation id to key on, so its
   * state waits here; adopting it into `byConversation` once the foundation
   * reports the conversation it created is the provisional-identity work
   * (R3.4–R3.8), which this keyed store is shaped to receive.
   */
  create: ProjectTurnState;
  byConversation: Readonly<Record<string, ProjectTurnState>>;
}

const NO_TURNS: ProjectTurnStates = { create: IDLE_TURN, byConversation: {} };

function readTurn(
  turns: ProjectTurnStates,
  conversationId: string | null,
): ProjectTurnState {
  if (conversationId === null) return turns.create;
  return turns.byConversation[conversationId] ?? IDLE_TURN;
}

function buildUserContent(
  text: string,
  images: ImagePayload[] | undefined,
): MessageContentBlock[] {
  return [
    ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
    ...(images ?? []).map((img) => ({
      type: "image" as const,
      mediaType: img.mediaType,
      base64Data: img.base64Data,
    })),
  ];
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
 *
 * Every piece of turn state — the in-flight guard, the busy flag, the error,
 * and the optimistic/streamed messages mirrored into the keyed in-flight store —
 * is per conversation. The foundation's busy check is already per conversation,
 * so a project-wide guard would discard a prompt aimed at an idle conversation
 * with no error at all, and project-wide busy/error state would render a turn on
 * whichever tab happened to be active.
 */
export function useSendProjectPrompt(
  projectName: string,
): UseSendProjectPromptResult {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<ProjectTurnStates>(NO_TURNS);
  // One entry per target with a request in flight; `null` is the create-and-send
  // turn, which has no conversation id to key on yet.
  const inFlight = useRef<Set<string | null>>(new Set());
  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();

  const patchTurn = useCallback(
    (conversationId: string | null, patch: Partial<ProjectTurnState>) => {
      setTurns((prev) =>
        conversationId === null
          ? { ...prev, create: { ...prev.create, ...patch } }
          : {
              ...prev,
              byConversation: {
                ...prev.byConversation,
                [conversationId]: {
                  ...readTurn(prev, conversationId),
                  ...patch,
                },
              },
            },
      );
    },
    [],
  );

  const isSending = useCallback(
    (conversationId: string | null) => readTurn(turns, conversationId).sending,
    [turns],
  );
  const errorFor = useCallback(
    (conversationId: string | null) => readTurn(turns, conversationId).error,
    [turns],
  );
  const clearError = useCallback(
    (conversationId: string | null) =>
      patchTurn(conversationId, { error: null }),
    [patchTurn],
  );

  const send = useCallback(
    async (input: SendProjectPromptInput): Promise<void> => {
      const { conversationId } = input;
      // Guarded per target, not project-wide: the foundation's busy check is
      // already per conversation, so a shared guard would drop a prompt aimed
      // at an idle conversation without reporting anything to the user.
      if (inFlight.current.has(conversationId)) return;
      inFlight.current.add(conversationId);
      patchTurn(conversationId, { sending: true, error: null });

      const userContent = buildUserContent(input.text, input.images);
      // Mark the target conversation's keyed in-flight state so its transcript
      // surfaces (typing indicator, optimistic prompt) react to this send. The
      // create-and-send path has no conversation id yet — the first-run view
      // has no transcript to indicate on, so it rides the create slot alone.
      if (conversationId !== null) {
        const cached = queryClient.getQueryData(
          projectConversationKeys.messages(projectName, conversationId),
        );
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
          patchTurn(conversationId, {
            error: {
              message: errBody?.error ?? `Prompt failed (${res.status})`,
              ...(errBody?.code !== undefined ? { code: errBody.code } : {}),
            },
          });
          return;
        }

        const streamBlocks: MessageContentBlock[] = [];
        await consumePromptStream(res.body, (event) => {
          switch (event.type) {
            case "content": {
              streamBlocks.push(event.block);
              // Streamed output belongs to the conversation that asked for it,
              // so it is mirrored onto that conversation's keyed transcript
              // state rather than onto whichever tab is active.
              if (conversationId !== null) {
                receiveStreamContent(conversationId, userContent, [
                  ...streamBlocks,
                ]);
              }
              break;
            }
            case "error":
              patchTurn(conversationId, {
                error: {
                  message: event.message ?? "Prompt failed",
                  ...(event.code !== undefined ? { code: event.code } : {}),
                },
              });
              break;
            // Project conversations answer questions through the durable
            // pending-question record, not this per-request stream.
            case "ask-question":
            case "aborted":
            case "done":
              break;
          }
        });
      } catch {
        patchTurn(conversationId, {
          error: { message: "Failed to send prompt" },
        });
      } finally {
        inFlight.current.delete(conversationId);
        patchTurn(conversationId, { sending: false });
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
    [
      projectName,
      queryClient,
      patchTurn,
      submitPrompt,
      receiveStreamContent,
      completePrompt,
    ],
  );

  return { send, isSending, errorFor, clearError };
}
