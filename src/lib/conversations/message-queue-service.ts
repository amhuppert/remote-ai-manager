import { stampCheckpointForkSubmission } from "@/lib/conversation-checkpoints/fork-submission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  getConversation as defaultGetConversation,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { publishEvent } from "@/lib/events/publication";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
import { createLogger } from "@/lib/logging";
import { modelSelectionKey } from "@/lib/agent-backends/model-selection";

import type { ParsedConversationCommand } from "@/lib/conversation-commands/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import {
  isActiveQueuedMessageStatus,
  pendingQueuedMessageSchema,
  queuedMessageNeedsReview,
} from "@/lib/conversations/message-queue-schemas";
import { conversationEventScopeFields } from "@/lib/conversations/project-conversation-scope";
import type {
  PendingQueuedMessage,
  QueuedMessageMetadata,
  QueuedMessageView,
  QueueReviewAction,
} from "@/lib/conversations/message-queue-schemas";

const logger = createLogger("message-queue");

/**
 * Maximum delivery attempts a queued message may consume. Each claim increments
 * `attemptCount`; a recoverable failure (`markPending`) returns the row to
 * `pending` with the count retained, so a poison message that fails every
 * delivery would otherwise cycle pending → delivering → pending forever. Once a
 * row reaches this cap, the claim paths retain it for review as
 * `failed` with QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON recorded in `error`
 * and broadcast to the client — never a silent drop.
 */
export const MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS = 5;

export const QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON = `Delivery refused: message reached the maximum of ${MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS} delivery attempts`;

interface ConversationKey {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

interface EnqueueQueuedMessageInput extends ConversationKey {
  backend?: AgentBackendId;
  content: MessageContentBlock[];
  metadata?: QueuedMessageMetadata;
  modelSelection?: BackendModelSelection;
}

interface ConsumingEnqueueQueuedMessageInput extends EnqueueQueuedMessageInput {
  /**
   * The enqueue commits only if `conversation.pendingQuestionId` still equals
   * this id, clearing `pendingQuestionId`/`pendingQuestions` in the SAME
   * durable write as the row append (docs/design/cc-cli/03 §3 — consuming the
   * pending question and submitting the answer are atomic, so a crash can
   * never strand a consumed marker without its queued answer). Enqueue
   * returns null (no row, no broadcast) when the marker is already gone.
   */
  consumePendingQuestionId: string;
}

/**
 * Build a fresh `pending` queue row. All terminal timestamps and the
 * delivery-claim fields start null; `attemptCount` starts at 0. The queue —
 * not the JSONL transcript — owns this entry until delivery is confirmed.
 */
export function createPendingEntry(args: {
  id: string;
  content: MessageContentBlock[];
  now: string;
  metadata?: QueuedMessageMetadata;
  modelSelection?: BackendModelSelection;
}): PendingQueuedMessage {
  return {
    id: args.id,
    content: args.content,
    status: "pending",
    enqueuedAt: args.now,
    updatedAt: args.now,
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: args.metadata ?? null,
    ...(args.modelSelection ? { modelSelection: args.modelSelection } : {}),
  };
}

/** Append an entry to the queue; array order is enqueue order. Pure. */
export function appendPendingEntry(
  queue: readonly PendingQueuedMessage[],
  entry: PendingQueuedMessage,
): PendingQueuedMessage[] {
  return [...queue, entry];
}

/**
 * Deep-detach a queue row from the Immer draft it was built over. A row that is
 * pruned from the queue (a terminal `delivered`/`cancelled` result) is
 * never re-inserted into the finalized state tree, so the store's
 * `createDraft`/`finishDraft` cycle revokes the draft proxies it still aliases —
 * notably the nested `content` array. Without this snapshot the post-mutation
 * broadcast throws "Cannot perform 'get' on a proxy that has been revoked" on
 * the first read of `content`. Retained rows do not need this: Immer finalizes
 * them in place because they remain reachable from `pendingQueue`.
 *
 * Must be called while the draft is still live (inside the mutator), so the
 * JSON round-trip reads through the proxy to plain data. `structuredClone`
 * cannot be used here: it rejects the Immer proxy with a DataCloneError.
 */
function detachQueueRow(entry: PendingQueuedMessage): PendingQueuedMessage {
  return pendingQueuedMessageSchema.parse(JSON.parse(JSON.stringify(entry)));
}

function isAttemptLimitReached(entry: PendingQueuedMessage): boolean {
  return entry.attemptCount >= MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS;
}

/**
 * Retain a row at the attempt cap with its refusal reason for explicit review.
 */
function refuseAttemptLimitEntry(
  entry: PendingQueuedMessage,
  now: string,
): PendingQueuedMessage {
  return detachQueueRow({
    ...entry,
    status: "failed",
    failedAt: now,
    error: QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON,
    updatedAt: now,
  });
}

/** Rows still owned by the queue; order is preserved. Pure. */
export function listActiveEntries(
  queue: readonly PendingQueuedMessage[],
): PendingQueuedMessage[] {
  return queue.filter((entry) => isActiveQueuedMessageStatus(entry.status));
}

/**
 * Project a persisted queue row to the client-safe view, dropping the internal
 * delivery-claim fields (`deliveryStartedAt`, `deliveryAttemptId`,
 * `attemptCount`) the client never renders.
 */
export function toQueuedMessageView(
  entry: PendingQueuedMessage,
): QueuedMessageView {
  return {
    id: entry.id,
    content: entry.content,
    status: entry.status,
    enqueuedAt: entry.enqueuedAt,
    updatedAt: entry.updatedAt,
    deliveredAt: entry.deliveredAt,
    cancelledAt: entry.cancelledAt,
    failedAt: entry.failedAt,
    error: entry.error,
    metadata: entry.metadata,
    ...(entry.modelSelection ? { modelSelection: entry.modelSelection } : {}),
  };
}

/**
 * Concatenate the text of all `text` blocks (newline-joined). Returns "" when
 * there is no text. Needed because the `message-queued` event schema still
 * carries a `text` field alongside the structured queued-message view.
 */
export function contentToText(content: readonly MessageContentBlock[]): string {
  return content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Concatenate each entry's `content` in array order (order-preserving). This is
 * the coalescing primitive the next-turn drain reuses to deliver multiple
 * pending entries as one turn. Pure: inputs are not mutated.
 */
export function coalesceContent(
  entries: readonly PendingQueuedMessage[],
): MessageContentBlock[] {
  return entries.flatMap((entry) => entry.content);
}

/**
 * Claim a single `pending` row by id into `delivering` under `attemptId`. Only
 * a row whose status is `pending` is claimable. A pending row already at the
 * attempt cap is retained as `failed` with the refusal reason and returned as
 * `refused` so the caller can broadcast the review requirement. Returns the next
 * queue and the claimed row (or `null` if
 * the id is absent, not pending, or refused). Pure.
 */
export function claimLiveDeliveryTransform(
  queue: readonly PendingQueuedMessage[],
  id: string,
  attemptId: string,
  now: string,
): {
  queue: PendingQueuedMessage[];
  claimed: PendingQueuedMessage | null;
  refused: PendingQueuedMessage | null;
} {
  if (queue.some((entry) => queuedMessageNeedsReview(entry.status))) {
    return { queue: [...queue], claimed: null, refused: null };
  }
  let claimed: PendingQueuedMessage | null = null;
  let refused: PendingQueuedMessage | null = null;
  const next: PendingQueuedMessage[] = [];
  for (const entry of queue) {
    if (entry.id !== id || entry.status !== "pending") {
      next.push(entry);
      continue;
    }
    if (isAttemptLimitReached(entry)) {
      refused = refuseAttemptLimitEntry(entry, now);
      next.push(refused);
      continue;
    }
    claimed = {
      ...entry,
      status: "delivering",
      deliveryAttemptId: attemptId,
      deliveryStartedAt: now,
      updatedAt: now,
      attemptCount: entry.attemptCount + 1,
    };
    next.push(claimed);
  }
  return { queue: next, claimed, refused };
}

/**
 * Atomically claim the next deliverable batch of `pending` rows (in array
 * order) into `delivering` under one shared `attemptId`. The batch is either:
 *   (a) the maximal prefix of non-command pending rows — coalesced into one
 *       turn by the caller — stopping before the first conversation command, or
 *   (b) a single command row at the head of the pending queue, claimed alone
 *       so the drain routes it to the command service (req 8.3).
 * Pending rows at the attempt cap become `failed` and block later claims until
 * explicit retry or discard, preserving both the payload and queue order.
 * Returns the next queue, the claimed rows in order, the refused rows, and the
 * parsed command for case (b) (`null` for plain batches). Pure.
 */
export function claimNextTurnBatchTransform(
  queue: readonly PendingQueuedMessage[],
  attemptId: string,
  now: string,
): {
  queue: PendingQueuedMessage[];
  claimed: PendingQueuedMessage[];
  command: ParsedConversationCommand | null;
  refused: PendingQueuedMessage[];
} {
  // A claimed batch owns the next turn until acceptance or release. Letting a
  // second drainer skip it can dispatch later model selections out of order.
  if (
    queue.some(
      (entry) =>
        entry.status === "delivering" || queuedMessageNeedsReview(entry.status),
    )
  ) {
    return { queue: [...queue], claimed: [], command: null, refused: [] };
  }
  const refused: PendingQueuedMessage[] = [];
  const survivors: PendingQueuedMessage[] = [];
  for (const entry of queue) {
    if (entry.status === "pending" && isAttemptLimitReached(entry)) {
      const held = refuseAttemptLimitEntry(entry, now);
      refused.push(held);
      survivors.push(held);
      continue;
    }
    survivors.push(entry);
  }

  if (refused.length > 0)
    return { queue: survivors, claimed: [], command: null, refused };
  const pending = survivors.filter((entry) => entry.status === "pending");
  const head = pending[0];
  if (!head) {
    return { queue: survivors, claimed: [], command: null, refused };
  }

  const headCommand = parseConversationCommand(contentToText(head.content));
  const claimIds = new Set<string>();
  if (headCommand) {
    claimIds.add(head.id);
  } else {
    for (const entry of pending) {
      if (parseConversationCommand(contentToText(entry.content))) break;
      if (!sameModelSelection(head.modelSelection, entry.modelSelection)) break;
      claimIds.add(entry.id);
    }
  }

  const claimed: PendingQueuedMessage[] = [];
  const next = survivors.map((entry) => {
    if (entry.status !== "pending" || !claimIds.has(entry.id)) {
      return entry;
    }
    const updated: PendingQueuedMessage = {
      ...entry,
      status: "delivering",
      deliveryAttemptId: attemptId,
      deliveryStartedAt: now,
      updatedAt: now,
      attemptCount: entry.attemptCount + 1,
    };
    claimed.push(updated);
    return updated;
  });
  return { queue: next, claimed, command: headCommand, refused };
}

function sameModelSelection(
  left: BackendModelSelection | undefined,
  right: BackendModelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return modelSelectionKey(left) === modelSelectionKey(right);
}

/**
 * Apply a delivery result to the rows named by `ids`, but only when a row is
 * currently `delivering` AND its `deliveryAttemptId` matches `attemptId`. Rows
 * that do not match are left unchanged — this is the "reject mismatched
 * attempt" semantics that stops a stale handler from mutating a newer attempt.
 * Returns the next queue and the rows actually changed. Pure.
 */
function applyDeliveryResult(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  update: (entry: PendingQueuedMessage) => PendingQueuedMessage,
  prune: boolean,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  const idSet = new Set(ids);
  const affected: PendingQueuedMessage[] = [];
  const next: PendingQueuedMessage[] = [];
  for (const entry of queue) {
    if (
      !idSet.has(entry.id) ||
      entry.status !== "delivering" ||
      entry.deliveryAttemptId !== attemptId
    ) {
      next.push(entry);
      continue;
    }
    const updated = update(entry);
    // Confirmed deliveries are pruned from the persisted queue:
    // nothing reads a terminal entry and retaining them grows the row
    // unboundedly. markPending is a retry (back to pending) and must be kept.
    if (prune) {
      affected.push(detachQueueRow(updated));
    } else {
      affected.push(updated);
      next.push(updated);
    }
  }
  return { queue: next, affected };
}

/** Mark matching delivering rows `delivered`. Pure. See `applyDeliveryResult`. */
export function markDeliveredTransform(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  now: string,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  return applyDeliveryResult(
    queue,
    ids,
    attemptId,
    (entry) => ({
      ...entry,
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
    }),
    true,
  );
}

/**
 * Recoverable failure: return matching delivering rows to `pending`, clearing
 * the delivery claim and recording `error`. `attemptCount` is retained so the
 * next claim sees the accumulated attempts. Pure. See `applyDeliveryResult`.
 */
export function markPendingTransform(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  error: string,
  now: string,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  return applyDeliveryResult(
    queue,
    ids,
    attemptId,
    (entry) => ({
      ...entry,
      status: "pending",
      deliveryAttemptId: null,
      deliveryStartedAt: null,
      error,
      updatedAt: now,
    }),
    false,
  );
}

/** Known failure: retain the rejected input for review. Pure. */
export function markFailedTransform(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  error: string,
  now: string,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  return applyDeliveryResult(
    queue,
    ids,
    attemptId,
    (entry) => ({
      ...entry,
      status: "failed",
      failedAt: now,
      error,
      updatedAt: now,
    }),
    false,
  );
}

/**
 * Confirm rows an attempt delivered but never acknowledged: the rows named
 * by `ids` that are still `delivering` or already held `uncertain` under
 * `attemptId` become `delivered` and leave the queue. Reserved for a caller
 * holding durable, attempt-correlated acceptance evidence for that input —
 * a checkpoint delivery's recorded acceptance — because it is the one path
 * that releases a row from review without the user's explicit retry or
 * discard. Rows under another attempt, or already back at `pending`, are
 * untouched. Pure.
 */
export function confirmDeliveryTransform(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  now: string,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  const idSet = new Set(ids);
  const affected: PendingQueuedMessage[] = [];
  const next: PendingQueuedMessage[] = [];
  for (const entry of queue) {
    if (
      !idSet.has(entry.id) ||
      entry.deliveryAttemptId !== attemptId ||
      (entry.status !== "delivering" && entry.status !== "uncertain")
    ) {
      next.push(entry);
      continue;
    }
    affected.push(
      detachQueueRow({
        ...entry,
        status: "delivered",
        deliveredAt: now,
        error: null,
        updatedAt: now,
      }),
    );
  }
  return { queue: next, affected };
}

/** Preserve an ambiguous attempt; only explicit review may release its rows. */
export function markUncertainTransform(
  queue: readonly PendingQueuedMessage[],
  ids: readonly string[],
  attemptId: string,
  error: string,
  now: string,
): { queue: PendingQueuedMessage[]; affected: PendingQueuedMessage[] } {
  return applyDeliveryResult(
    queue,
    ids,
    attemptId,
    (entry) => ({ ...entry, status: "uncertain", error, updatedAt: now }),
    false,
  );
}

/**
 * Hold abandoned claims for explicit review. A missing owner does not prove
 * that the provider never received the request; replay could repeat its work.
 */
export function recoverAbandonedDeliveriesTransform(
  queue: readonly PendingQueuedMessage[],
  now: string,
): { queue: PendingQueuedMessage[]; recovered: PendingQueuedMessage[] } {
  const recovered: PendingQueuedMessage[] = [];
  const next = queue.map((entry) => {
    if (entry.status !== "delivering") {
      return entry;
    }
    const updated: PendingQueuedMessage = {
      ...entry,
      status: "uncertain",
      error:
        "Delivery was interrupted and may have reached the agent. Review before retrying or discarding.",
      updatedAt: now,
    };
    recovered.push(updated);
    return updated;
  });
  return { queue: next, recovered };
}

/**
 * Cancel the row named by `id`. Cancellation succeeds only for a `pending` row;
 * a row in any other status (`delivering`/`delivered`/`failed`/`cancelled`)
 * cannot be cancelled because delivery may already be visible to the agent. A
 * missing id is `not_found`. Pure: the input queue/rows are not mutated.
 */
export function cancelTransform(
  queue: readonly PendingQueuedMessage[],
  id: string,
  now: string,
): {
  queue: PendingQueuedMessage[];
  result: "cancelled" | "not_found" | "not_cancellable";
  cancelled: PendingQueuedMessage | null;
} {
  const existing = queue.find((entry) => entry.id === id);
  if (!existing) {
    return { queue: [...queue], result: "not_found", cancelled: null };
  }
  if (existing.status !== "pending") {
    return { queue: [...queue], result: "not_cancellable", cancelled: null };
  }

  let cancelled: PendingQueuedMessage | null = null;
  const next: PendingQueuedMessage[] = [];
  for (const entry of queue) {
    if (entry.id !== id) {
      next.push(entry);
      continue;
    }
    // Pruned: returned as `cancelled` for the broadcast but dropped from the
    // persisted queue (a terminal entry is never read again). Detached from the
    // draft so the broadcast can read its content after finalization.
    cancelled = detachQueueRow({
      ...entry,
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
    });
  }
  return { queue: next, result: "cancelled", cancelled };
}

export interface ClaimedQueuedBatch {
  deliveryAttemptId: string;
  messageIds: string[];
  content: MessageContentBlock[];
  modelSelection?: BackendModelSelection;
  /**
   * Non-null when the batch is a single conversation-command row claimed alone
   * at the queue head; the drain routes it to the command service instead of
   * dispatching a SUBMIT_PROMPT turn.
   */
  command: ParsedConversationCommand | null;
}

export interface MessageQueueServiceDeps {
  mutateConversation<T>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getProjectDisplayName(projectPath: string): string;
  broadcast(event: SSEEvent): void;
  now(): string;
  newId(): string;
}

export interface MessageQueueService {
  enqueue(
    input: ConsumingEnqueueQueuedMessageInput,
  ): Promise<PendingQueuedMessage | null>;
  enqueue(input: EnqueueQueuedMessageInput): Promise<PendingQueuedMessage>;
  listActive(input: ConversationKey): Promise<PendingQueuedMessage[]>;
  claimLiveDelivery(
    input: ConversationKey & { id: string },
  ): Promise<PendingQueuedMessage | null>;
  claimNextTurnBatch(
    input: ConversationKey,
  ): Promise<ClaimedQueuedBatch | null>;
  markDelivered(
    input: ConversationKey & { ids: string[]; deliveryAttemptId: string },
  ): Promise<void>;
  markPending(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void>;
  markFailed(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void>;
  markUncertain(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void>;
  /**
   * Release rows from `delivering`/`uncertain` on durable acceptance evidence
   * for their attempt; see `confirmDeliveryTransform`.
   */
  confirmDelivery(
    input: ConversationKey & { ids: string[]; deliveryAttemptId: string },
  ): Promise<number>;
  cancel(
    input: ConversationKey & { id: string },
  ): Promise<"cancelled" | "not_found" | "not_cancellable">;
  /** Retry keeps position and payload with a fresh identity; discard removes it. */
  resolveDelivery(
    input: ConversationKey & { id: string; action: QueueReviewAction },
  ): Promise<"resolved" | "not_found" | "not_reviewable">;
  /** Only a process/actor owner that knows the prior delivery stopped may recover. */
  recoverAbandonedDeliveries(input: ConversationKey): Promise<number>;
}

export function createMessageQueueService(
  deps: MessageQueueServiceDeps,
): MessageQueueService {
  async function enqueue(
    input: ConsumingEnqueueQueuedMessageInput,
  ): Promise<PendingQueuedMessage | null>;
  async function enqueue(
    input: EnqueueQueuedMessageInput,
  ): Promise<PendingQueuedMessage>;
  async function enqueue(
    input: EnqueueQueuedMessageInput & { consumePendingQuestionId?: string },
  ): Promise<PendingQueuedMessage | null> {
    const {
      projectPath,
      sessionName,
      conversationId,
      content,
      metadata,
      modelSelection,
      consumePendingQuestionId,
    } = input;
    const id = deps.newId();
    const now = deps.now();
    const entry = createPendingEntry({
      id,
      content,
      now,
      metadata,
      modelSelection,
    });

    // The store's serialized write queue makes the check-consume-append
    // race-free: a concurrent duplicate sees `committed: false`.
    const committed = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "enqueueQueuedMessage",
      (conversation) => {
        if (consumePendingQuestionId !== undefined) {
          if (conversation.pendingQuestionId !== consumePendingQuestionId) {
            return false;
          }
          conversation.pendingQuestionId = null;
          conversation.pendingQuestions = null;
        }
        stampCheckpointForkSubmission(
          conversation,
          input.backend ?? conversation.agentBackend,
          now,
        );
        conversation.pendingQueue = appendPendingEntry(
          conversation.pendingQueue,
          entry,
        );
        return true;
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);

    if (!committed) {
      logger.info("queue.enqueue_rejected", {
        projectName,
        sessionName,
        conversationId,
        messageIds: [id],
        consumePendingQuestionId,
      });
      return null;
    }

    try {
      deps.broadcast({
        type: "message-queued",
        ...conversationEventScopeFields(
          projectName,
          sessionName,
          conversationId,
        ),
        text: contentToText(content),
        message: toQueuedMessageView(entry),
      });
    } catch {
      // Fire-and-forget: a broadcast failure must not fail the durable enqueue.
    }

    logger.info("queue.enqueue", {
      projectName,
      sessionName,
      conversationId,
      messageIds: [id],
      status: "pending",
    });

    return entry;
  }

  async function listActive(
    input: ConversationKey,
  ): Promise<PendingQueuedMessage[]> {
    const conversation = await deps.getConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    return conversation ? listActiveEntries(conversation.pendingQueue) : [];
  }

  /**
   * Emit one `message-queue-updated` event per row. Fire-and-forget: a broadcast
   * failure must never fail the durable write that already committed.
   */
  function broadcastUpdated(
    key: ConversationKey,
    projectName: string,
    rows: readonly PendingQueuedMessage[],
  ): void {
    for (const row of rows) {
      try {
        deps.broadcast({
          type: "message-queue-updated",
          ...conversationEventScopeFields(
            projectName,
            key.sessionName,
            key.conversationId,
          ),
          message: toQueuedMessageView(row),
        });
      } catch {
        // Fire-and-forget: keep broadcasting the remaining rows.
      }
    }
  }

  /**
   * Broadcast rows refused at the attempt cap (`failed` with the
   * refusal reason) and log the refusal. The retained payload and reason are
   * committed in the same durable write as the claim decision.
   */
  function reportRefused(
    key: ConversationKey,
    projectName: string,
    refused: readonly PendingQueuedMessage[],
  ): void {
    if (refused.length === 0) {
      return;
    }
    broadcastUpdated(key, projectName, refused);
    logger.warn("queue.refused", {
      projectName,
      sessionName: key.sessionName,
      conversationId: key.conversationId,
      messageIds: refused.map((row) => row.id),
      status: "failed",
      reason: QUEUED_MESSAGE_ATTEMPT_LIMIT_REFUSAL_REASON,
      maxAttempts: MAX_QUEUED_MESSAGE_DELIVERY_ATTEMPTS,
    });
  }

  async function claimLiveDelivery(
    input: ConversationKey & { id: string },
  ): Promise<PendingQueuedMessage | null> {
    const { projectPath, sessionName, conversationId, id } = input;
    const attemptId = deps.newId();
    const now = deps.now();

    const { claimed, refused } = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "claimLiveDelivery",
      (conversation) => {
        const result = claimLiveDeliveryTransform(
          conversation.pendingQueue,
          id,
          attemptId,
          now,
        );
        conversation.pendingQueue = result.queue;
        return { claimed: result.claimed, refused: result.refused };
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    reportRefused(input, projectName, refused ? [refused] : []);

    if (!claimed) {
      return null;
    }

    broadcastUpdated(input, projectName, [claimed]);

    logger.info("queue.claim", {
      projectName,
      sessionName,
      conversationId,
      messageIds: [claimed.id],
      deliveryAttemptId: attemptId,
      status: claimed.status,
      attemptCount: claimed.attemptCount,
    });

    return claimed;
  }

  async function claimNextTurnBatch(
    input: ConversationKey,
  ): Promise<ClaimedQueuedBatch | null> {
    const { projectPath, sessionName, conversationId } = input;
    const attemptId = deps.newId();
    const now = deps.now();

    const { claimed, command, refused } = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "claimNextTurnBatch",
      (conversation) => {
        const result = claimNextTurnBatchTransform(
          conversation.pendingQueue,
          attemptId,
          now,
        );
        conversation.pendingQueue = result.queue;
        return {
          claimed: result.claimed,
          command: result.command,
          refused: result.refused,
        };
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    reportRefused(input, projectName, refused);

    if (claimed.length === 0) {
      return null;
    }

    broadcastUpdated(input, projectName, claimed);

    const messageIds = claimed.map((row) => row.id);
    logger.info("queue.claim", {
      projectName,
      sessionName,
      conversationId,
      messageIds,
      deliveryAttemptId: attemptId,
      status: "delivering",
      command: command?.command ?? null,
    });

    return {
      deliveryAttemptId: attemptId,
      messageIds,
      content: coalesceContent(claimed),
      command,
      ...(claimed[0]?.modelSelection
        ? { modelSelection: claimed[0].modelSelection }
        : {}),
    };
  }

  async function markDelivered(
    input: ConversationKey & { ids: string[]; deliveryAttemptId: string },
  ): Promise<void> {
    const { projectPath, sessionName, conversationId, ids, deliveryAttemptId } =
      input;
    const now = deps.now();

    const affected = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "markDelivered",
      (conversation) => {
        const result = markDeliveredTransform(
          conversation.pendingQueue,
          ids,
          deliveryAttemptId,
          now,
        );
        conversation.pendingQueue = result.queue;
        return result.affected;
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    broadcastUpdated(input, projectName, affected);

    logger.info("queue.accepted", {
      projectName,
      sessionName,
      conversationId,
      messageIds: affected.map((row) => row.id),
      deliveryAttemptId,
      status: "delivered",
    });
  }

  async function markPending(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void> {
    const {
      projectPath,
      sessionName,
      conversationId,
      ids,
      deliveryAttemptId,
      error,
    } = input;
    const now = deps.now();

    const affected = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "markPending",
      (conversation) => {
        const result = markPendingTransform(
          conversation.pendingQueue,
          ids,
          deliveryAttemptId,
          error,
          now,
        );
        conversation.pendingQueue = result.queue;
        return result.affected;
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    broadcastUpdated(input, projectName, affected);

    logger.info("queue.failed", {
      projectName,
      sessionName,
      conversationId,
      messageIds: affected.map((row) => row.id),
      deliveryAttemptId,
      status: "pending",
      recoverable: true,
      error,
    });
  }

  async function markFailed(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void> {
    const {
      projectPath,
      sessionName,
      conversationId,
      ids,
      deliveryAttemptId,
      error,
    } = input;
    const now = deps.now();

    const affected = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "markFailed",
      (conversation) => {
        const result = markFailedTransform(
          conversation.pendingQueue,
          ids,
          deliveryAttemptId,
          error,
          now,
        );
        conversation.pendingQueue = result.queue;
        return result.affected;
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);
    broadcastUpdated(input, projectName, affected);

    logger.info("queue.failed", {
      projectName,
      sessionName,
      conversationId,
      messageIds: affected.map((row) => row.id),
      deliveryAttemptId,
      status: "failed",
      recoverable: false,
      error,
    });
  }

  async function cancel(
    input: ConversationKey & { id: string },
  ): Promise<"cancelled" | "not_found" | "not_cancellable"> {
    const { projectPath, sessionName, conversationId, id } = input;
    const now = deps.now();

    const { result, cancelled } = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "cancelQueuedMessage",
      (conversation) => {
        const transform = cancelTransform(conversation.pendingQueue, id, now);
        conversation.pendingQueue = transform.queue;
        return { result: transform.result, cancelled: transform.cancelled };
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);

    if (result === "cancelled" && cancelled) {
      broadcastUpdated(input, projectName, [cancelled]);
      logger.info("queue.cancelled", {
        projectName,
        sessionName,
        conversationId,
        messageIds: [cancelled.id],
        status: cancelled.status,
      });
      return result;
    }

    logger.debug("queue.cancelled", {
      projectName,
      sessionName,
      conversationId,
      messageIds: [id],
      result,
    });

    return result;
  }

  async function recoverAbandonedDeliveries(
    input: ConversationKey,
  ): Promise<number> {
    const { projectPath, sessionName, conversationId } = input;
    const now = deps.now();

    const recovered = await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "recoverAbandonedDeliveries",
      (conversation) => {
        const result = recoverAbandonedDeliveriesTransform(
          conversation.pendingQueue,
          now,
        );
        conversation.pendingQueue = result.queue;
        return result.recovered;
      },
    );

    if (recovered.length === 0) {
      return 0;
    }

    const projectName = deps.getProjectDisplayName(projectPath);
    broadcastUpdated(input, projectName, recovered);

    logger.info("queue.recovered", {
      projectName,
      sessionName,
      conversationId,
      messageIds: recovered.map((row) => row.id),
      status: "uncertain",
    });

    return recovered.length;
  }

  async function markUncertain(
    input: ConversationKey & {
      ids: string[];
      deliveryAttemptId: string;
      error: string;
    },
  ): Promise<void> {
    const affected = await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "markQueuedUncertain",
      (conversation) => {
        const result = markUncertainTransform(
          conversation.pendingQueue,
          input.ids,
          input.deliveryAttemptId,
          input.error,
          deps.now(),
        );
        conversation.pendingQueue = result.queue;
        return result.affected;
      },
    );
    if (affected.length === 0) return;
    broadcastUpdated(
      input,
      deps.getProjectDisplayName(input.projectPath),
      affected,
    );
    logger.warn("queue.delivery_uncertain", {
      conversationId: input.conversationId,
      messageIds: affected.map((row) => row.id),
      deliveryAttemptId: input.deliveryAttemptId,
      error: input.error,
    });
  }

  async function confirmDelivery(
    input: ConversationKey & { ids: string[]; deliveryAttemptId: string },
  ): Promise<number> {
    const affected = await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "confirmQueuedDelivery",
      (conversation) => {
        const result = confirmDeliveryTransform(
          conversation.pendingQueue,
          input.ids,
          input.deliveryAttemptId,
          deps.now(),
        );
        conversation.pendingQueue = result.queue;
        return result.affected;
      },
    );
    if (affected.length === 0) return 0;
    broadcastUpdated(
      input,
      deps.getProjectDisplayName(input.projectPath),
      affected,
    );
    logger.info("queue.delivery_confirmed", {
      conversationId: input.conversationId,
      messageIds: affected.map((row) => row.id),
      deliveryAttemptId: input.deliveryAttemptId,
      status: "delivered",
    });
    return affected.length;
  }

  async function resolveDelivery(
    input: ConversationKey & { id: string; action: QueueReviewAction },
  ): Promise<"resolved" | "not_found" | "not_reviewable"> {
    const outcome = await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "resolveQueuedDelivery",
      (conversation) => {
        const entry = conversation.pendingQueue.find(
          (row) => row.id === input.id,
        );
        if (!entry) return { result: "not_found" as const };
        if (!queuedMessageNeedsReview(entry.status))
          return { result: "not_reviewable" as const };
        const now = deps.now();
        // Retry is an explicit repeat: a fresh queue identity gives it a distinct
        // transcript receipt even if the earlier attempt already appended one.
        const updated = detachQueueRow(
          input.action === "discard"
            ? {
                ...entry,
                status: "cancelled",
                cancelledAt: now,
                updatedAt: now,
              }
            : {
                ...entry,
                id: deps.newId(),
                status: "pending",
                deliveryAttemptId: null,
                deliveryStartedAt: null,
                failedAt: null,
                error: null,
                attemptCount: 0,
                updatedAt: now,
              },
        );
        conversation.pendingQueue = conversation.pendingQueue.flatMap((row) =>
          row.id !== input.id
            ? [row]
            : input.action === "discard"
              ? []
              : [updated],
        );
        return {
          result: "resolved" as const,
          entries:
            input.action === "retry"
              ? [
                  detachQueueRow({
                    ...entry,
                    status: "cancelled",
                    cancelledAt: now,
                    updatedAt: now,
                  }),
                  updated,
                ]
              : [updated],
        };
      },
    );
    if (outcome.entries)
      broadcastUpdated(
        input,
        deps.getProjectDisplayName(input.projectPath),
        outcome.entries,
      );
    logger.info("queue.review_resolved", {
      conversationId: input.conversationId,
      messageId: input.id,
      action: input.action,
      result: outcome.result,
    });
    return outcome.result;
  }

  return {
    enqueue,
    listActive,
    claimLiveDelivery,
    claimNextTurnBatch,
    markDelivered,
    markPending,
    markFailed,
    markUncertain,
    confirmDelivery,
    cancel,
    resolveDelivery,
    recoverAbandonedDeliveries,
  };
}

export const messageQueueService = createMessageQueueService({
  mutateConversation: defaultMutateConversation,
  getConversation: defaultGetConversation,
  getProjectDisplayName: defaultGetProjectDisplayName,
  broadcast: (event) => {
    publishEvent(event);
  },
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
});
