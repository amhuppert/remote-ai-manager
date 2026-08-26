import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { consumePromptStream } from "@/lib/prompt/stream-transport";
import { appendCursorContentDelta } from "@/lib/agent-backends/cursor/content-deltas";
import { CURSOR_BACKEND_ID } from "@/lib/agent-backends/cursor/backend-id";
import {
  publicConversationStateSchema,
  type AnswerQuestionRequest,
  type AskQuestionItem,
  type PublicConversationState,
  type MessageContentBlock,
} from "@/lib/conversations/schemas";
import {
  useSubmitPrompt,
  useReceiveStreamContent,
  useCompletePrompt,
  useMarkCancelled,
  useReassignInFlight,
  useDiscardInFlight,
  useAddOptimisticQueueEntry,
  useAcceptOptimisticQueueEntry,
  useRollbackOptimisticQueueEntry,
  useSetQueueError,
} from "@/stores/session-detail.store";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import {
  conversationTargetApiBase,
  projectConversationTarget,
} from "@/lib/conversations/conversation-target";
import type { QueueEnqueueResponse } from "@/lib/prompt/schemas";
import type {
  ActiveConversation,
  ActiveConversationsResponse,
} from "@/lib/active-conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { OptimisticAgentSettings } from "@/stores/session-detail/types";
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

/**
 * Patch one project conversation in the list cache — the cockpit's own view of
 * server truth for every conversation it has a tab for. `undefined` (no list
 * fetched yet) is left alone: a conversation cannot be invented from a partial
 * patch, and the fetch that resolves will carry the server's own state anyway.
 */
function patchListedConversation(
  queryClient: ReturnType<typeof useQueryClient>,
  projectName: string,
  conversationId: string,
  patch: (c: PublicConversationState) => PublicConversationState,
): void {
  queryClient.setQueryData<PublicConversationState[]>(
    projectConversationKeys.list(projectName),
    (old) => old?.map((c) => (c.id === conversationId ? patch(c) : c)),
  );
}

/**
 * Record a question batch on the conversation that asked it, in the same shape
 * the server persists — so the panel the cockpit mounts is driven by one set of
 * fields whether they arrived on this turn's stream, over SSE, or from a fetch
 * after a reload.
 */
function recordPendingQuestion(
  queryClient: ReturnType<typeof useQueryClient>,
  projectName: string,
  conversationId: string,
  questionId: string,
  questions: AskQuestionItem[],
): void {
  patchListedConversation(queryClient, projectName, conversationId, (c) => ({
    ...c,
    status: "waiting_for_input",
    pendingQuestionId: questionId,
    pendingQuestions: questions,
  }));
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

/**
 * Create a new project conversation (defaults backend via config when omitted).
 * `profile` is the identity selection and stays separate from `agentBackend`:
 * omitting it resolves the Standard Agent server-side (R7).
 */
export function useCreateProjectConversation(
  projectName: string,
): UseMutationResult<
  PublicConversationState,
  Error,
  {
    agentBackend?: AgentBackendId;
    name?: string;
    profile?: AgentProfileRef;
  } | void
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
        publicConversationStateSchema,
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
        cacheUpdate<string, PublicConversationState[]>({
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

/** What answering a project conversation's question batch reports back. */
export type ProjectAnswerResult =
  | { status: "ok" }
  | { status: "gone"; error: string | null };

/**
 * Submit answers to a project conversation's pending question batch through the
 * project route — the conversation has no session to address it by.
 *
 * A 410 is not an error: the batch was already answered or superseded (another
 * tab, or the turn moving on), and the caller clears the panel and says so.
 * Optimistically clearing the pending fields is what makes the panel disappear
 * on submit rather than on the refetch.
 */
export function useAnswerProjectQuestionMutation(
  projectName: string,
  conversationId: string,
): UseMutationResult<ProjectAnswerResult, Error, AnswerQuestionRequest> {
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: async ({
        questionId,
        answers,
      }: AnswerQuestionRequest): Promise<ProjectAnswerResult> => {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId, answers }),
          },
        );
        if (res.ok) return { status: "ok" };
        if (res.status === 410) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          return { status: "gone", error: body?.error ?? null };
        }
        throw new Error(`Answer submission failed: ${res.status}`);
      },
      updates: [
        cacheUpdate<AnswerQuestionRequest, PublicConversationState[]>({
          key: () => projectConversationKeys.list(projectName),
          update: (old) =>
            old?.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    status: "running" as const,
                    pendingQuestionId: null,
                    pendingQuestions: null,
                  }
                : c,
            ),
        }),
        cacheUpdate<AnswerQuestionRequest, ActiveConversationsResponse>({
          key: () => conversationKeys.active(),
          update: (old) =>
            patchedActiveConversation(old, conversationId, (c) => ({
              ...c,
              status: "running" as const,
              pendingQuestion: null,
              pendingQuestionId: null,
              pendingQuestions: null,
            })),
        }),
      ],
      invalidateKeys: () => [
        projectConversationKeys.list(projectName),
        projectConversationKeys.messages(projectName, conversationId),
        conversationKeys.active(),
      ],
    }),
  );
}

/** Module-scoped so two composers never mint the same optimistic entry id. */
let queueSequence = 0;

export interface QueueProjectMessageInput {
  conversationId: string;
  text: string;
  images?: ImagePayload[];
  modelSelection?: BackendModelSelection;
}

export interface UseQueueProjectMessageResult {
  /**
   * Enqueue a follow-up into a project conversation that is already running.
   * Resolves `true` when the server durably queued it — a `false` result means
   * the composer keeps the user's text.
   */
  queue(input: QueueProjectMessageInput): Promise<boolean>;
}

/**
 * Queue a follow-up into a running project conversation.
 *
 * The queue row is durable server-side, but the user must see their message the
 * moment they send it, so an optimistic entry is added first and reconciled
 * against the server id on success (or rolled back on refusal). That optimistic
 * store is keyed by conversation id and is scope-agnostic, so a project
 * conversation's pending row renders through exactly the same transcript
 * projection a session conversation's does.
 */
export function useQueueProjectMessage(
  projectName: string,
): UseQueueProjectMessageResult {
  const queryClient = useQueryClient();
  const addOptimisticQueueEntry = useAddOptimisticQueueEntry();
  const acceptOptimisticQueueEntry = useAcceptOptimisticQueueEntry();
  const rollbackOptimisticQueueEntry = useRollbackOptimisticQueueEntry();
  const setQueueError = useSetQueueError();

  const queue = useCallback(
    async ({
      conversationId,
      text,
      images,
      modelSelection,
    }: QueueProjectMessageInput): Promise<boolean> => {
      const content = buildUserContent(text, images);
      if (content.length === 0) return false;

      const tempId = `queued-${queueSequence++}`;
      addOptimisticQueueEntry(conversationId, tempId, content);

      const url = `${conversationTargetApiBase(
        projectConversationTarget(projectName, conversationId),
      )}/queue`;
      let res: Response;
      try {
        res = await tracedFetch(url, "queue-project-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            ...(images && images.length > 0 ? { images } : {}),
            ...(modelSelection ? { modelSelection } : {}),
          }),
        });
      } catch {
        rollbackOptimisticQueueEntry(conversationId, tempId);
        setQueueError(conversationId, "Failed to queue message");
        return false;
      }

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        rollbackOptimisticQueueEntry(conversationId, tempId);
        setQueueError(conversationId, body?.error ?? "Failed to queue message");
        return false;
      }

      const data = (await res
        .json()
        .catch(() => null)) as QueueEnqueueResponse | null;
      // Adopting the server id is what makes the pending row cancellable and
      // lets the durable row that arrives next supersede it instead of
      // double-rendering the same message.
      if (data && data.queued) {
        acceptOptimisticQueueEntry(conversationId, tempId, data.message.id);
      }
      invalidateProjectLifecycle(queryClient, projectName);
      return true;
    },
    [
      projectName,
      queryClient,
      addOptimisticQueueEntry,
      acceptOptimisticQueueEntry,
      rollbackOptimisticQueueEntry,
      setQueueError,
    ],
  );

  return { queue };
}

/** A turn addressed by the conversation it runs in. */
export interface ConversationTurnKey {
  readonly kind: "conversation";
  readonly conversationId: string;
}

/**
 * A turn addressed by the slot allocated for it before the server named its
 * conversation. A create-and-send submission allocates one before issuing its
 * request, every piece of state that turn produces is attributed to it, and it
 * is released the moment the turn adopts a real conversation.
 */
export interface ProvisionalTurnKey {
  readonly kind: "provisional";
  readonly provisionalId: string;
}

/** Where one turn's client state lives while that turn is addressable. */
export type ProjectTurnKey = ConversationTurnKey | ProvisionalTurnKey;

/** Where a submission is aimed: an open conversation, or a new one to create. */
export type ProjectPromptTarget =
  | ConversationTurnKey
  | { readonly kind: "create" };

export function conversationTurnKey(
  conversationId: string,
): ConversationTurnKey {
  return { kind: "conversation", conversationId };
}

/** The id a key's state is stored under, here and in the in-flight store. */
function turnStorageId(key: ProjectTurnKey): string {
  return key.kind === "conversation" ? key.conversationId : key.provisionalId;
}

/**
 * Random per-page-load prefix for this client's submission tokens. A token must
 * be unique across every client of the project, not just within this one: it is
 * matched against conversations the server reports, and two browser tabs sharing
 * a token would let each adopt the other's conversation.
 *
 * `crypto.randomUUID` is unavailable outside a secure context, which a Command
 * Center reached over plain http from another machine is not, so the fallback is
 * reachable in normal use. Uniqueness is all that is needed — the token is
 * correlation, never authorization.
 */
const CLIENT_TOKEN_PREFIX = ((): string => {
  const webCrypto = globalThis.crypto;
  return typeof webCrypto?.randomUUID === "function"
    ? webCrypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
})();

/**
 * Where a submission's state lives, and — for a create-and-send — the record of
 * a turn awaiting its conversation, carrying the token the request will send.
 *
 * Both counters are monotonic and module-scoped, so two create-and-send
 * submissions are never handed the same slot or the same token, including across
 * cockpit mounts. The `provisional:` prefix keeps these ids out of the
 * conversation-id namespace they share with the in-flight store.
 */
let provisionalSequence = 0;
function allocateTurn(target: ProjectPromptTarget): {
  key: ProjectTurnKey;
  unnamedTurn: UnnamedTurn | null;
} {
  if (target.kind === "conversation") {
    return {
      key: conversationTurnKey(target.conversationId),
      unnamedTurn: null,
    };
  }
  provisionalSequence += 1;
  const key: ProvisionalTurnKey = {
    kind: "provisional",
    provisionalId: `provisional:${provisionalSequence}`,
  };
  return {
    key,
    unnamedTurn: {
      key,
      creationRequestId: `${CLIENT_TOKEN_PREFIX}-${provisionalSequence}`,
      adopted: null,
      error: null,
    },
  };
}

export interface SendProjectPromptInput {
  target: ProjectPromptTarget;
  text: string;
  images?: ImagePayload[];
  backend?: AgentBackendId;
  modelSelection?: BackendModelSelection;
  /**
   * Identity for the conversation a `create` target builds — the create-and-send
   * composer's own picker, travelling beside the runtime fields rather than
   * inside them. Ignored for a conversation target: that one's profile is
   * already resolved, and changing it is the profile PATCH route's business.
   */
  profile?: AgentProfileRef;
}

function projectPromptAgentSettings(
  input: SendProjectPromptInput,
): OptimisticAgentSettings {
  return input.modelSelection === undefined
    ? {}
    : { modelSelection: input.modelSelection };
}

export interface ProjectPromptError {
  message: string;
  /** Foundation error code (e.g. BACKEND_MISMATCH, VALIDATION_ERROR). */
  code?: string;
}

/** What a submission hands back: the key it owns, and when the turn settles. */
export interface ProjectTurnSubmission {
  /**
   * The key this turn's state is attributed to. Allocated before the request is
   * issued, so the caller can address the turn from the moment it submits.
   */
  readonly key: ProjectTurnKey;
  /**
   * Whether the server took the submission, resolved as soon as the response
   * status is known rather than when the turn ends. This is what lets a composer
   * hand the user's text back on a refusal (a busy 409, a transport failure, or
   * a duplicate submission this client dropped) instead of clearing it into
   * nothing.
   *
   * A turn that opened its stream and then failed resolves `true`: the
   * submission WAS accepted, and the failure is the turn's, surfaced through the
   * error envelope.
   */
  readonly accepted: Promise<boolean>;
  /** Resolves when the turn has streamed to completion, failed, or aborted. */
  readonly settled: Promise<void>;
}

export interface UseSendProjectPromptOptions {
  /**
   * Called once per create-and-send turn, with the conversation the server
   * named for it. The cockpit opens that conversation's tab, which is what
   * makes releasing the provisional key seamless rather than a gap.
   */
  onConversationAdopted?(conversationId: string): void;
}

export interface UseSendProjectPromptResult {
  send(input: SendProjectPromptInput): ProjectTurnSubmission;
  /**
   * Turn state is read per key, so a turn in one project conversation never
   * renders on another's tab, and an unnamed create-and-send turn renders on
   * neither. `null` reads no turn at all.
   */
  isSending(key: ProjectTurnKey | null): boolean;
  errorFor(key: ProjectTurnKey | null): ProjectPromptError | null;
  /**
   * Dismiss a turn's error. Dismissing the error of a create-and-send turn that
   * failed before it was ever named releases its key: the failure was the only
   * thing it still held.
   */
  clearError(key: ProjectTurnKey | null): void;
  /**
   * Stop the turn running in one conversation: halts backend execution through
   * the project abort route and settles that conversation's local turn state.
   *
   * Keyed by conversation, never provisional — a create-and-send turn the server
   * has not named yet has no conversation to stop, and the moment it is named it
   * becomes stoppable under that conversation's key.
   */
  abort(key: ConversationTurnKey): Promise<void>;
  /** Provisional keys still holding turn state, in allocation order. */
  provisionalKeys: readonly ProvisionalTurnKey[];
  /** The key the create composer reports on: the newest such key. */
  pendingCreateKey: ProvisionalTurnKey | null;
  /**
   * Report the project's conversations with the creation each one records. The
   * second of the two id sources, and the only one available if a turn's request
   * stream never delivers its `conversation` frame.
   *
   * A conversation names a turn when it records that turn's submission token and
   * only then. Membership proves nothing on its own — an id is equally new to
   * this client whether the server created it for a pending submission, another
   * tab created it, a closed conversation was reopened, or the first fetch just
   * resolved — so the token is what makes this source causal rather than a guess
   * at which conversation is unaccounted for.
   */
  noticeConversations(creations: readonly ProjectConversationCreation[]): void;
}

/**
 * What the conversation list reports about one conversation's creation:
 * the submission token the server recorded for it, or `null` when it records
 * none (created by any path other than a create-and-send submission).
 */
export interface ProjectConversationCreation {
  readonly conversationId: string;
  readonly creationRequestId: string | null;
}

/** Busy flag and error envelope for one key's turn. */
interface ProjectTurnState {
  sending: boolean;
  error: ProjectPromptError | null;
}

const IDLE_TURN: ProjectTurnState = { sending: false, error: null };

interface ProjectTurnStates {
  byConversation: Readonly<Record<string, ProjectTurnState>>;
  /**
   * Turns whose conversation the server has not named yet, in allocation order
   * (the ids are non-numeric, so object key order is insertion order).
   */
  byProvisional: Readonly<Record<string, ProjectTurnState>>;
}

const NO_TURNS: ProjectTurnStates = { byConversation: {}, byProvisional: {} };

function readTurn(
  turns: ProjectTurnStates,
  key: ProjectTurnKey,
): ProjectTurnState {
  const state =
    key.kind === "conversation"
      ? turns.byConversation[key.conversationId]
      : turns.byProvisional[key.provisionalId];
  return state ?? IDLE_TURN;
}

/** Seed a turn's state at submission time. */
function withStartedTurn(
  turns: ProjectTurnStates,
  key: ProjectTurnKey,
): ProjectTurnStates {
  const started: ProjectTurnState = { sending: true, error: null };
  return key.kind === "conversation"
    ? {
        ...turns,
        byConversation: {
          ...turns.byConversation,
          [key.conversationId]: started,
        },
      }
    : {
        ...turns,
        byProvisional: { ...turns.byProvisional, [key.provisionalId]: started },
      };
}

/**
 * Patch a turn's state. A released provisional key is never resurrected: no
 * late stream frame or dismissal can make it reachable again.
 */
function withPatchedTurn(
  turns: ProjectTurnStates,
  key: ProjectTurnKey,
  patch: Partial<ProjectTurnState>,
): ProjectTurnStates {
  if (key.kind === "conversation") {
    const existing = turns.byConversation[key.conversationId] ?? IDLE_TURN;
    return {
      ...turns,
      byConversation: {
        ...turns.byConversation,
        [key.conversationId]: { ...existing, ...patch },
      },
    };
  }
  const existing = turns.byProvisional[key.provisionalId];
  if (existing === undefined) return turns;
  return {
    ...turns,
    byProvisional: {
      ...turns.byProvisional,
      [key.provisionalId]: { ...existing, ...patch },
    },
  };
}

function withoutProvisional(
  turns: ProjectTurnStates,
  provisionalId: string,
): ProjectTurnStates {
  if (!(provisionalId in turns.byProvisional)) return turns;
  const remaining = { ...turns.byProvisional };
  delete remaining[provisionalId];
  return { ...turns, byProvisional: remaining };
}

/** Move a provisional turn's state onto the conversation the server named. */
function withAdoptedProvisional(
  turns: ProjectTurnStates,
  provisionalId: string,
  conversationId: string,
): ProjectTurnStates {
  const state = turns.byProvisional[provisionalId];
  if (state === undefined) return turns;
  const remaining = { ...turns.byProvisional };
  delete remaining[provisionalId];
  return {
    byProvisional: remaining,
    byConversation: { ...turns.byConversation, [conversationId]: state },
  };
}

/**
 * A create-and-send turn's identity while it is still unnamed. `adopted` is set
 * exactly once, by whichever id source arrives first; the running turn reads it
 * to know where the rest of its state belongs.
 */
interface UnnamedTurn {
  readonly key: ProvisionalTurnKey;
  /**
   * Token this submission sent with its request. The conversation the server
   * created for it records the same token, so a conversation reported by the
   * list identifies this turn by carrying it — and identifies no other turn,
   * because no other submission sent it.
   */
  readonly creationRequestId: string;
  adopted: string | null;
  /**
   * The failure this turn currently holds under its provisional key. Kept here
   * rather than in the running turn's closure so dismissing it reaches the turn:
   * a dismissal that only cleared the rendered error would leave the key held by
   * a settled turn holding nothing, unreachable and never dismissible again.
   */
  error: ProjectPromptError | null;
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
 * Send a turn to the foundation's project prompt route. A `create` target posts
 * to the create-and-send entry (`POST /api/projects/[name]/prompt`) so the
 * foundation creates a conversation; a conversation target posts to the
 * per-conversation prompt route. The SSE stream is read to completion so we
 * know when to invalidate; transcript/list updates ride React Query
 * invalidation and the global SSE→invalidation path (NotificationListener
 * handles `scope:"project"` events). Prompt errors (busy / backend-mismatch /
 * validation) are surfaced through the error envelope without redefining the
 * foundation's codes.
 *
 * Every piece of turn state — the in-flight guard, the busy flag, the error,
 * and the optimistic/streamed messages mirrored into the keyed in-flight store —
 * is per key. The foundation's busy check is already per conversation, so a
 * project-wide guard would discard a prompt aimed at an idle conversation with
 * no error at all, and project-wide busy/error state would render a turn on
 * whichever tab happened to be active.
 *
 * A create-and-send turn has no conversation to key on, so it allocates a
 * provisional key before issuing its request and owns that key until the server
 * names its conversation. The name arrives from either the turn's own request
 * stream (a `conversation` frame, which names that turn's conversation exactly)
 * or the project conversation list; whichever arrives first adopts, moving the
 * turn's state onto the conversation key and releasing the provisional one, and
 * the other finds nothing left to adopt. A turn that fails before it was ever
 * named keeps its failure under its own key until the user dismisses it or
 * retries, and nothing else can reach that key in the meantime.
 *
 * Both sources are causal, and neither infers. The stream frame arrives on the
 * very request that created the conversation. The list is causal because the
 * submission sends a token the server records on the conversation it creates for
 * it: a reported conversation names a turn by carrying that turn's token. What
 * the list can never do is say which submission caused a conversation to exist by
 * membership alone — an id is equally new to this client whether it was created
 * for a pending submission, created by another tab, reopened after being closed,
 * or merely absent from a first fetch that had not resolved yet. So a conversation
 * with no token, or with another submission's token, names nothing here, and a
 * turn whose token has not been reported stays provisional.
 */
export function useSendProjectPrompt(
  projectName: string,
  options: UseSendProjectPromptOptions = {},
): UseSendProjectPromptResult {
  const queryClient = useQueryClient();
  const [turns, setTurns] = useState<ProjectTurnStates>(NO_TURNS);
  /** Storage ids with a request in flight — one guard per addressable target. */
  const inFlight = useRef<Set<string>>(new Set());
  /** Create-and-send turns still awaiting a conversation, by provisional id. */
  const unnamed = useRef<Map<string, UnnamedTurn>>(new Map());
  /** Provisional keys whose turn failed before it was ever named. */
  const failedProvisionals = useRef<Set<string>>(new Set());
  /**
   * The cancellation handle of each running turn, under the storage id its
   * state is keyed by. Keyed rather than single-slot (as the session sender's
   * is) because project conversations run concurrently: one handle would let a
   * stop aimed at one tab cancel whichever turn started last.
   */
  const streams = useRef<Map<string, AbortController>>(new Map());

  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();
  const markCancelled = useMarkCancelled();
  const reassignInFlight = useReassignInFlight();
  const discardInFlight = useDiscardInFlight();

  const adoptedCallback = useRef(options.onConversationAdopted);
  useEffect(() => {
    adoptedCallback.current = options.onConversationAdopted;
  }, [options.onConversationAdopted]);

  const cachedMessageCount = useCallback(
    (key: ProjectTurnKey): number => {
      if (key.kind !== "conversation") return 0;
      const cached = queryClient.getQueryData(
        projectConversationKeys.messages(projectName, key.conversationId),
      );
      return Array.isArray(cached) ? cached.length : 0;
    },
    [queryClient, projectName],
  );

  /** Move one turn onto the conversation created for it. */
  const adopt = useCallback(
    (provisionalId: string, conversationId: string) => {
      const turn = unnamed.current.get(provisionalId);
      // Exactly-once: whichever id source arrives first takes the turn out of
      // the unnamed set, so the other finds nothing left to adopt. Both sources
      // report the same conversation for a given turn — the stream frame comes
      // from the request that created it, the list entry from the record that
      // request wrote — so the second arrival has nothing to add either.
      if (turn === undefined) return;

      unnamed.current.delete(provisionalId);
      turn.adopted = conversationId;

      inFlight.current.delete(provisionalId);
      inFlight.current.add(conversationId);
      // The cancellation handle moves too: a turn becomes stoppable exactly
      // when it becomes addressable by conversation.
      const stream = streams.current.get(provisionalId);
      if (stream !== undefined) {
        streams.current.delete(provisionalId);
        streams.current.set(conversationId, stream);
      }
      // The optimistic prompt and whatever has streamed so far move with the
      // turn, so the conversation's transcript opens on the turn in progress
      // rather than on an empty tab.
      reassignInFlight(provisionalId, conversationId);
      setTurns((prev) =>
        withAdoptedProvisional(prev, provisionalId, conversationId),
      );
      adoptedCallback.current?.(conversationId);
    },
    [reassignInFlight],
  );

  /** Drop a provisional key everywhere it is held, leaving it unreachable. */
  const releaseProvisional = useCallback(
    (provisionalId: string) => {
      unnamed.current.delete(provisionalId);
      failedProvisionals.current.delete(provisionalId);
      inFlight.current.delete(provisionalId);
      streams.current.delete(provisionalId);
      discardInFlight(provisionalId);
      setTurns((prev) => withoutProvisional(prev, provisionalId));
    },
    [discardInFlight],
  );

  const noticeConversations = useCallback(
    (creations: readonly ProjectConversationCreation[]) => {
      for (const creation of creations) {
        if (creation.creationRequestId === null) continue;
        // The turn that sent this token, if it is still waiting to be named.
        // Every other reported conversation — including one this client's own
        // settled submission created — matches nothing and is left alone.
        const turn = [...unnamed.current.values()].find(
          (t) => t.creationRequestId === creation.creationRequestId,
        );
        if (turn === undefined) continue;
        adopt(turn.key.provisionalId, creation.conversationId);
      }
    },
    [adopt],
  );

  const isSending = useCallback(
    (key: ProjectTurnKey | null) =>
      key === null ? false : readTurn(turns, key).sending,
    [turns],
  );
  const errorFor = useCallback(
    (key: ProjectTurnKey | null) =>
      key === null ? null : readTurn(turns, key).error,
    [turns],
  );
  const clearError = useCallback(
    (key: ProjectTurnKey | null) => {
      if (key === null) return;
      if (key.kind === "provisional") {
        if (failedProvisionals.current.has(key.provisionalId)) {
          releaseProvisional(key.provisionalId);
          return;
        }
        // A turn still awaiting its conversation keeps its key — it is still
        // running — but the dismissal reaches the turn, so the key is not held
        // past the turn if this failure turns out to be its last.
        const running = unnamed.current.get(key.provisionalId);
        if (running !== undefined) running.error = null;
      }
      setTurns((prev) => withPatchedTurn(prev, key, { error: null }));
    },
    [releaseProvisional],
  );

  /**
   * Release a finished turn's state and refresh what it changed. Called only by
   * the turn that still owns its key — a superseded turn settles nothing.
   */
  const settleTurn = useCallback(
    (settledKey: ProjectTurnKey, unnamedTurn: UnnamedTurn | null): void => {
      const settledId = turnStorageId(settledKey);

      // Read at settle time, not captured when the failure arrived: a failure
      // the user has already dismissed is no longer this turn's to hold.
      const unsettledFailure = unnamedTurn?.error ?? null;
      if (settledKey.kind === "provisional" && unsettledFailure === null) {
        // The turn ended holding no error to show, so its key is released
        // rather than left behind holding an idle turn.
        releaseProvisional(settledKey.provisionalId);
      } else {
        setTurns((prev) =>
          withPatchedTurn(prev, settledKey, { sending: false }),
        );
        completePrompt(settledId);
        if (settledKey.kind === "provisional") {
          // The failure stays readable under the key that owns it until the
          // user dismisses it or retries, and the turn stops awaiting a name:
          // this request will not deliver one. If the server did create a
          // conversation before the connection broke, the list will report it
          // carrying this turn's token and match nothing — which is right. The
          // conversation exists as its own tab; this turn's error belongs to
          // the submission, not to it (R3.8).
          unnamed.current.delete(settledKey.provisionalId);
          failedProvisionals.current.add(settledKey.provisionalId);
        }
      }

      invalidateProjectLifecycle(queryClient, projectName);
      if (settledKey.kind === "conversation") {
        void queryClient.invalidateQueries({
          queryKey: projectConversationKeys.messages(
            projectName,
            settledKey.conversationId,
          ),
        });
      }
    },
    [projectName, queryClient, releaseProvisional, completePrompt],
  );

  const runTurn = useCallback(
    async (
      key: ProjectTurnKey,
      unnamedTurn: UnnamedTurn | null,
      input: SendProjectPromptInput,
      userContent: MessageContentBlock[],
      reportAccepted: (accepted: boolean) => void,
    ): Promise<void> => {
      /** The key this turn's state is attributed to right now. */
      const currentKey = (): ProjectTurnKey =>
        unnamedTurn !== null && unnamedTurn.adopted !== null
          ? conversationTurnKey(unnamedTurn.adopted)
          : key;
      const failTurn = (error: ProjectPromptError): void => {
        if (unnamedTurn !== null) unnamedTurn.error = error;
        const target = currentKey();
        setTurns((prev) => withPatchedTurn(prev, target, { error }));
      };

      const url =
        key.kind === "provisional"
          ? `/api/projects/${encodeURIComponent(projectName)}/prompt`
          : `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(key.conversationId)}/prompt`;

      // Registered before the request goes out, so a Stop pressed the instant
      // the turn starts still finds a handle to cancel.
      const controller = new AbortController();
      streams.current.set(turnStorageId(key), controller);

      const body: Record<string, unknown> = { prompt: input.text };
      // Sent only on the create-and-send entry, which is the only request that
      // creates a conversation this client cannot yet name — and the only one
      // whose conversation has an identity still to be chosen.
      if (unnamedTurn !== null) {
        body.creationRequestId = unnamedTurn.creationRequestId;
        if (input.profile !== undefined) body.profile = input.profile;
      }
      if (input.modelSelection !== undefined) {
        body.modelSelection = input.modelSelection;
      }
      if (input.images !== undefined && input.images.length > 0)
        body.images = input.images;
      if (input.backend !== undefined) body.backend = input.backend;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          reportAccepted(false);
          const errBody = (await res.json().catch(() => null)) as {
            error?: string;
            code?: string;
          } | null;
          failTurn({
            message: errBody?.error ?? `Prompt failed (${res.status})`,
            ...(errBody?.code !== undefined ? { code: errBody.code } : {}),
          });
          return;
        }
        reportAccepted(true);

        const streamBlocks: MessageContentBlock[] = [];
        await consumePromptStream(res.body, (event) => {
          // A stopped turn produces nothing more for this client: whatever the
          // connection is still holding belongs to a turn the user ended, so it
          // must not re-enter the transcript or resurrect an error.
          if (controller.signal.aborted) return;
          switch (event.type) {
            // Only the create-and-send entry emits this, and only for the
            // conversation it created for this very turn.
            case "conversation":
              if (unnamedTurn !== null) {
                adopt(unnamedTurn.key.provisionalId, event.conversationId);
              }
              break;
            case "content": {
              if (input.backend === CURSOR_BACKEND_ID) {
                appendCursorContentDelta(streamBlocks, event.block);
              } else {
                streamBlocks.push(event.block);
              }
              // Streamed output belongs to the turn that asked for it, so it is
              // mirrored onto that turn's current key rather than onto whichever
              // tab is active.
              receiveStreamContent(
                turnStorageId(currentKey()),
                userContent,
                [...streamBlocks],
                projectPromptAgentSettings(input),
              );
              break;
            }
            case "error":
              failTurn({
                message: event.message ?? "Prompt failed",
                ...(event.code !== undefined ? { code: event.code } : {}),
              });
              break;
            case "ask-question": {
              // The cockpit reads pending questions off the conversation's
              // DURABLE fields, so the streamed batch is recorded there rather
              // than in a live-event-only slot: one source of truth that renders
              // now and survives a reload. Keyed to the conversation the turn is
              // running in — the create-and-send entry names its conversation
              // ahead of the turn, so this key is a real one by the time a
              // question can arrive.
              const questionKey = currentKey();
              if (questionKey.kind === "conversation") {
                recordPendingQuestion(
                  queryClient,
                  projectName,
                  questionKey.conversationId,
                  event.questionId,
                  event.questions,
                );
              }
              break;
            }
            // Terminal frames. `consumePromptStream` returns on either, and the
            // settle block below clears the turn's busy flag and reconciles the
            // caches — an abort is a cancelled turn, not a failure, so neither
            // surfaces an error (mirroring the session sender).
            case "aborted":
            case "done":
              break;
          }
        });
      } catch {
        // A stop is the user ending the turn, not the turn failing.
        if (!controller.signal.aborted) {
          reportAccepted(false);
          failTurn({ message: "Failed to send prompt" });
        }
      } finally {
        const settledKey = currentKey();
        const settledId = turnStorageId(settledKey);
        // Compare-and-settle. A stop followed by an immediate resend registers
        // the replacement turn under the same id while this one is still
        // unwinding, and a superseded turn settling would clear the LIVE turn's
        // guard, its busy flag, and its cancellation handle — leaving a running
        // turn shown as idle and unstoppable.
        if (streams.current.get(settledId) === controller) {
          streams.current.delete(settledId);
          inFlight.current.delete(settledId);
          settleTurn(settledKey, unnamedTurn);
        }
      }
    },
    [projectName, adopt, receiveStreamContent, settleTurn],
  );

  const send = useCallback(
    (input: SendProjectPromptInput): ProjectTurnSubmission => {
      // Allocated before the request is issued — including the token that
      // request carries — so this turn is addressable, and the conversation the
      // server creates for it identifiable, from the moment it submits.
      const { key, unnamedTurn } = allocateTurn(input.target);
      const storageId = turnStorageId(key);

      // Guarded per target, not project-wide: the foundation's busy check is
      // already per conversation, so a shared guard would drop a prompt aimed at
      // an idle conversation without reporting anything to the user. A freshly
      // allocated provisional key is never in flight, so a create-and-send is
      // never blocked by another one.
      if (inFlight.current.has(storageId)) {
        // Dropped, not sent: reporting it unaccepted is what hands the user's
        // text back rather than clearing it into a submission that never was.
        return {
          key,
          accepted: Promise.resolve(false),
          settled: Promise.resolve(),
        };
      }
      inFlight.current.add(storageId);

      // Retrying a create-and-send releases the keys of create-and-send turns
      // that already failed — this attempt supersedes their errors. Turns still
      // awaiting a conversation are untouched.
      if (key.kind === "provisional") {
        for (const failed of [...failedProvisionals.current]) {
          releaseProvisional(failed);
        }
      }

      const userContent = buildUserContent(input.text, input.images);
      setTurns((prev) => withStartedTurn(prev, key));
      // The optimistic prompt is attributed to this turn's key before the
      // request goes out, so no state this turn produces ever exists without a
      // key that owns it.
      submitPrompt(
        storageId,
        userContent,
        cachedMessageCount(key),
        projectPromptAgentSettings(input),
      );

      if (unnamedTurn !== null) {
        unnamed.current.set(unnamedTurn.key.provisionalId, unnamedTurn);
      }

      // Settled exactly once, by whichever outcome the request reaches first;
      // the `finally` below covers a turn that returns without reporting.
      let report: ((accepted: boolean) => void) | null = null;
      const accepted = new Promise<boolean>((resolve) => {
        report = resolve;
      });
      const reportAccepted = (value: boolean): void => {
        report?.(value);
        report = null;
      };

      return {
        key,
        accepted,
        settled: runTurn(
          key,
          unnamedTurn,
          input,
          userContent,
          reportAccepted,
        ).finally(() => reportAccepted(true)),
      };
    },
    [runTurn, releaseProvisional, submitPrompt, cachedMessageCount],
  );

  const abort = useCallback(
    async (key: ConversationTurnKey): Promise<void> => {
      const { conversationId } = key;

      // Local first, and unconditionally: the user ended this turn, so its
      // indicator must not outlive the request — a stopped backend closes its
      // stream, but a wedged connection would otherwise leave the tab busy
      // forever. Every step below addresses this conversation's key alone, so a
      // turn running in another project conversation is untouched.
      streams.current.get(conversationId)?.abort();
      inFlight.current.delete(conversationId);
      setTurns((prev) => withPatchedTurn(prev, key, { sending: false }));
      completePrompt(conversationId);

      let stopped = false;
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectName)}/conversations/${encodeURIComponent(conversationId)}/abort`,
          { method: "POST" },
        );
        // 409 means the server had nothing left to stop — the same settled
        // outcome the user asked for, so it is not a failure to report.
        stopped = res.ok || res.status === 409;
      } catch {
        // Network failure: the local turn is already settled, and the server
        // state the invalidations below would re-read is unknown.
        return;
      }
      if (!stopped) return;

      markCancelled(conversationId);
      invalidateProjectLifecycle(queryClient, projectName);
      // Refetches this conversation's transcript and its record — the record is
      // what carries the pending question the abort transition cleared.
      void queryClient.invalidateQueries({
        queryKey: projectConversationKeys.messages(projectName, conversationId),
      });
    },
    [projectName, queryClient, completePrompt, markCancelled],
  );

  const provisionalKeys = useMemo<readonly ProvisionalTurnKey[]>(
    () =>
      Object.keys(turns.byProvisional).map((provisionalId) => ({
        kind: "provisional",
        provisionalId,
      })),
    [turns],
  );
  const pendingCreateKey = provisionalKeys.at(-1) ?? null;

  return {
    send,
    isSending,
    errorFor,
    clearError,
    abort,
    provisionalKeys,
    pendingCreateKey,
    noticeConversations,
  };
}
