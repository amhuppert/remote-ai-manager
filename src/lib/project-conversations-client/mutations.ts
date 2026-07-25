import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useReassignInFlight,
  useDiscardInFlight,
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
  modelId?: string;
  effort?: string;
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

  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();
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

  const runTurn = useCallback(
    async (
      key: ProjectTurnKey,
      unnamedTurn: UnnamedTurn | null,
      input: SendProjectPromptInput,
      userContent: MessageContentBlock[],
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

      const body: Record<string, unknown> = { prompt: input.text };
      // Sent only on the create-and-send entry, which is the only request that
      // creates a conversation this client cannot yet name.
      if (unnamedTurn !== null) {
        body.creationRequestId = unnamedTurn.creationRequestId;
      }
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
          failTurn({
            message: errBody?.error ?? `Prompt failed (${res.status})`,
            ...(errBody?.code !== undefined ? { code: errBody.code } : {}),
          });
          return;
        }

        const streamBlocks: MessageContentBlock[] = [];
        await consumePromptStream(res.body, (event) => {
          switch (event.type) {
            // Only the create-and-send entry emits this, and only for the
            // conversation it created for this very turn.
            case "conversation":
              if (unnamedTurn !== null) {
                adopt(unnamedTurn.key.provisionalId, event.conversationId);
              }
              break;
            case "content": {
              streamBlocks.push(event.block);
              // Streamed output belongs to the turn that asked for it, so it is
              // mirrored onto that turn's current key rather than onto whichever
              // tab is active.
              receiveStreamContent(turnStorageId(currentKey()), userContent, [
                ...streamBlocks,
              ]);
              break;
            }
            case "error":
              failTurn({
                message: event.message ?? "Prompt failed",
                ...(event.code !== undefined ? { code: event.code } : {}),
              });
              break;
            // Project conversations answer questions through the durable
            // pending-question record on the conversation, not this per-request
            // stream — so a pending question cannot exist before the
            // conversation does, and is reachable only through it. The
            // create-and-send entry names its conversation ahead of running the
            // turn, so any question this stream carries arrives after adoption.
            case "ask-question":
            case "aborted":
            case "done":
              break;
          }
        });
      } catch {
        failTurn({ message: "Failed to send prompt" });
      } finally {
        const settledKey = currentKey();
        const settledId = turnStorageId(settledKey);
        inFlight.current.delete(settledId);

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
      }
    },
    [
      projectName,
      queryClient,
      adopt,
      releaseProvisional,
      receiveStreamContent,
      completePrompt,
    ],
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
        return { key, settled: Promise.resolve() };
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
      submitPrompt(storageId, userContent, cachedMessageCount(key));

      if (unnamedTurn !== null) {
        unnamed.current.set(unnamedTurn.key.provisionalId, unnamedTurn);
      }

      return { key, settled: runTurn(key, unnamedTurn, input, userContent) };
    },
    [runTurn, releaseProvisional, submitPrompt, cachedMessageCount],
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
    provisionalKeys,
    pendingCreateKey,
    noticeConversations,
  };
}
