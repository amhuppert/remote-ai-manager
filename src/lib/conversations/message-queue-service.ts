import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  getConversation as defaultGetConversation,
  mutateConversation as defaultMutateConversation,
} from "@/lib/state-store";
import { publishSessionStatus } from "@/lib/workflows/primitives/default-session-status-bus";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
import { createLogger } from "@/lib/logging";

import type { ParsedConversationCommand } from "@/lib/conversation-commands/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import { pendingQueuedMessageSchema } from "@/lib/conversations/message-queue-schemas";
import type {
  PendingQueuedMessage,
  QueuedMessageView,
} from "@/lib/conversations/message-queue-schemas";

const logger = createLogger("message-queue");

interface ConversationKey {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

interface EnqueueQueuedMessageInput extends ConversationKey {
  content: MessageContentBlock[];
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
 * pruned from the queue (a terminal `delivered`/`failed`/`cancelled` result) is
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

/** Active rows are `pending` and `delivering`; order is preserved. Pure. */
export function listActiveEntries(
  queue: readonly PendingQueuedMessage[],
): PendingQueuedMessage[] {
  return queue.filter(
    (entry) => entry.status === "pending" || entry.status === "delivering",
  );
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
 * a row whose status is `pending` is claimable. Returns the next queue and the
 * claimed row (or `null` if the id is absent or not pending). Pure.
 */
export function claimLiveDeliveryTransform(
  queue: readonly PendingQueuedMessage[],
  id: string,
  attemptId: string,
  now: string,
): { queue: PendingQueuedMessage[]; claimed: PendingQueuedMessage | null } {
  let claimed: PendingQueuedMessage | null = null;
  const next = queue.map((entry) => {
    if (entry.id !== id || entry.status !== "pending") {
      return entry;
    }
    claimed = {
      ...entry,
      status: "delivering",
      deliveryAttemptId: attemptId,
      deliveryStartedAt: now,
      updatedAt: now,
      attemptCount: entry.attemptCount + 1,
    };
    return claimed;
  });
  return { queue: next, claimed };
}

/**
 * Atomically claim the next deliverable batch of `pending` rows (in array
 * order) into `delivering` under one shared `attemptId`. The batch is either:
 *   (a) the maximal prefix of non-command pending rows — coalesced into one
 *       turn by the caller — stopping before the first conversation command, or
 *   (b) a single command row at the head of the pending queue, claimed alone
 *       so the drain routes it to the command service (req 8.3).
 * Returns the next queue, the claimed rows in order, and the parsed command
 * for case (b) (`null` for plain batches). Pure.
 */
export function claimNextTurnBatchTransform(
  queue: readonly PendingQueuedMessage[],
  attemptId: string,
  now: string,
): {
  queue: PendingQueuedMessage[];
  claimed: PendingQueuedMessage[];
  command: ParsedConversationCommand | null;
} {
  const pending = queue.filter((entry) => entry.status === "pending");
  const head = pending[0];
  if (!head) {
    return { queue: [...queue], claimed: [], command: null };
  }

  const headCommand = parseConversationCommand(contentToText(head.content));
  const claimIds = new Set<string>();
  if (headCommand) {
    claimIds.add(head.id);
  } else {
    for (const entry of pending) {
      if (parseConversationCommand(contentToText(entry.content))) break;
      claimIds.add(entry.id);
    }
  }

  const claimed: PendingQueuedMessage[] = [];
  const next = queue.map((entry) => {
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
  return { queue: next, claimed, command: headCommand };
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
    // Terminal results (delivered/failed) are pruned from the persisted queue:
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

/** Terminal failure: mark matching delivering rows `failed`. Pure. */
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
    true,
  );
}

/**
 * Reset every `delivering` row to `pending`, clearing its delivery claim. Used
 * during actor startup / process recovery to reclaim rows whose owning attempt
 * is gone. Returns the next queue and the recovered rows. Pure.
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
      status: "pending",
      deliveryAttemptId: null,
      deliveryStartedAt: null,
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
  cancel(
    input: ConversationKey & { id: string },
  ): Promise<"cancelled" | "not_found" | "not_cancellable">;
  recoverAbandonedDeliveries(input: ConversationKey): Promise<number>;
}

export function createMessageQueueService(
  deps: MessageQueueServiceDeps,
): MessageQueueService {
  async function enqueue(
    input: EnqueueQueuedMessageInput,
  ): Promise<PendingQueuedMessage> {
    const { projectPath, sessionName, conversationId, content } = input;
    const id = deps.newId();
    const now = deps.now();
    const entry = createPendingEntry({ id, content, now });

    await deps.mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "enqueueQueuedMessage",
      (conversation) => {
        conversation.pendingQueue = appendPendingEntry(
          conversation.pendingQueue,
          entry,
        );
      },
    );

    const projectName = deps.getProjectDisplayName(projectPath);

    try {
      deps.broadcast({
        type: "message-queued",
        projectName,
        sessionName,
        conversationId,
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
          projectName,
          sessionName: key.sessionName,
          conversationId: key.conversationId,
          message: toQueuedMessageView(row),
        });
      } catch {
        // Fire-and-forget: keep broadcasting the remaining rows.
      }
    }
  }

  async function claimLiveDelivery(
    input: ConversationKey & { id: string },
  ): Promise<PendingQueuedMessage | null> {
    const { projectPath, sessionName, conversationId, id } = input;
    const attemptId = deps.newId();
    const now = deps.now();

    const claimed = await deps.mutateConversation(
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
        return result.claimed;
      },
    );

    if (!claimed) {
      return null;
    }

    const projectName = deps.getProjectDisplayName(projectPath);
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

    const { claimed, command } = await deps.mutateConversation(
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
        return { claimed: result.claimed, command: result.command };
      },
    );

    if (claimed.length === 0) {
      return null;
    }

    const projectName = deps.getProjectDisplayName(projectPath);
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
      status: "pending",
    });

    return recovered.length;
  }

  return {
    enqueue,
    listActive,
    claimLiveDelivery,
    claimNextTurnBatch,
    markDelivered,
    markPending,
    markFailed,
    cancel,
    recoverAbandonedDeliveries,
  };
}

export const messageQueueService = createMessageQueueService({
  mutateConversation: defaultMutateConversation,
  getConversation: defaultGetConversation,
  getProjectDisplayName: defaultGetProjectDisplayName,
  broadcast: (event) => {
    publishSessionStatus(event);
  },
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
});
