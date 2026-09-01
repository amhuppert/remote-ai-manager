"use client";

import { useEffect, useMemo } from "react";
import {
  useMessageCountBeforeSubmitFor,
  useOptimisticMessagesFor,
  useOptimisticQueueFor,
  useReconcileMessages,
  useResolveOptimisticQueueEntries,
  useSendingFor,
} from "@/stores/session-detail.store";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type {
  PendingQueuedMessage,
  QueuedMessageMetadata,
} from "@/lib/conversations/message-queue-schemas";

/**
 * Display-time annotation on a transcript-shaped row that originates from the
 * pending queue rather than the delivered JSONL transcript. `id` is the durable
 * server queue id (used by the cancellation affordance); `tempId` identifies an
 * optimistic-only entry not yet durable; `status` drives pending styling.
 * `metadata` is the durable row's provenance tag — the renderer keys structured
 * cards (e.g. question answers) off it instead of sniffing the raw text.
 */
export interface QueuedDisplayMeta {
  id: string | null;
  tempId?: string;
  status: "pending" | "delivering" | "accepted";
  metadata: QueuedMessageMetadata | null;
}

/**
 * A transcript message augmented with optional queue metadata. Because it
 * extends `TranscriptMessage`, a `DisplayMessage[]` is assignable wherever a
 * `TranscriptMessage[]` was expected, so existing renderers keep compiling and
 * simply ignore `queued`.
 *
 * `provisional` marks an in-flight optimistic row: its display index and
 * content are not durable yet, so reference-bearing actions (copy-reference,
 * clip) must not be offered on it — the same exclusion queued rows get via
 * `queued`.
 */
export type DisplayMessage = TranscriptMessage & {
  queued?: QueuedDisplayMeta;
  provisional?: true;
};

/** Structural shape of a store optimistic-queue entry consumed by the pure
 * projection. Matches `OptimisticQueueEntry` in the session-detail store. */
export interface OptimisticQueueProjectionEntry {
  tempId: string;
  queueId: string | null;
  content: TranscriptMessage["content"];
  status: "pending" | "accepted" | "failed";
}

interface BuildDisplayProjectionInput {
  messages: readonly TranscriptMessage[];
  optimisticMessages: readonly TranscriptMessage[];
  messageCountBeforeSubmit: number;
  sending: boolean;
  pendingQueue: readonly PendingQueuedMessage[];
  optimisticQueue: readonly OptimisticQueueProjectionEntry[];
}

/**
 * Pure projection that merges the in-flight transcript view with active queue
 * entries into one ordered list.
 *
 * The base is the existing in-flight merge (server transcript sliced before the
 * submit point with optimistic messages appended during streaming). Active
 * queue rows are appended after it, in enqueue order: durable `pending`/
 * `delivering` entries first, then optimistic entries not yet represented in the
 * durable queue. Delivered and cancelled entries are excluded — a delivered
 * entry is shown by its JSONL transcript row only, never duplicated.
 *
 * `sending` is currently unused by the merge but kept in the input so the
 * projection has the full in-flight context the hook reconciles against.
 */
export function buildDisplayProjection({
  messages,
  optimisticMessages,
  messageCountBeforeSubmit,
  pendingQueue,
  optimisticQueue,
}: BuildDisplayProjectionInput): DisplayMessage[] {
  const base: DisplayMessage[] =
    optimisticMessages.length > 0
      ? [
          ...messages.slice(0, messageCountBeforeSubmit),
          ...optimisticMessages.map(
            (message): DisplayMessage => ({ ...message, provisional: true }),
          ),
        ]
      : [...messages];

  // Delivery stamps the transcript user row with the durable queue row's id,
  // so a queue entry (durable or optimistic) whose id already appears as a
  // transcript row id has been delivered — the transcript row alone shows it.
  const transcriptIds = new Set<string>();
  for (const message of messages) {
    if (message.id !== undefined) transcriptIds.add(message.id);
  }

  const durableRows: DisplayMessage[] = [];
  const durableIds = new Set<string>();
  for (const entry of pendingQueue) {
    if (entry.status !== "pending" && entry.status !== "delivering") continue;
    if (transcriptIds.has(entry.id)) continue;
    durableIds.add(entry.id);
    durableRows.push({
      role: "user",
      content: entry.content,
      timestamp: entry.enqueuedAt,
      queued: {
        id: entry.id,
        status: entry.status === "delivering" ? "delivering" : "pending",
        metadata: entry.metadata,
      },
    });
  }

  const optimisticRows: DisplayMessage[] = [];
  for (const entry of optimisticQueue) {
    if (entry.status === "failed") continue;
    // Durable representation wins: skip an optimistic entry already shown by
    // an included durable pending row or by the transcript row its delivery
    // stamped (both keyed by server queue id).
    if (
      entry.queueId !== null &&
      (durableIds.has(entry.queueId) || transcriptIds.has(entry.queueId))
    )
      continue;
    optimisticRows.push({
      role: "user",
      content: entry.content,
      timestamp: null,
      queued: {
        id: entry.queueId,
        tempId: entry.tempId,
        status: entry.queueId ? "accepted" : "pending",
        metadata: null,
      },
    });
  }

  return [...base, ...durableRows, ...optimisticRows];
}

/**
 * Merge server transcript with in-flight optimistic messages and active queue
 * entries for display, and reconcile once the stream is done and the server
 * transcript has caught up.
 *
 * During streaming the server transcript is written in real-time and polled
 * every 3s, so `messages` may already contain the assistant response that is
 * also in `optimisticMessages`. To avoid duplicates we slice server messages
 * to before the submit point and append optimistic instead.
 *
 * Pending queue entries (durable + optimistic) are appended after the in-flight
 * assistant message so a queued follow-up is visible as pending until it is
 * delivered (shown by its transcript row) or cancelled.
 */
export function useDisplayMessages(
  conversationId: string,
  messages: readonly TranscriptMessage[],
  pendingQueue: readonly PendingQueuedMessage[] = [],
): readonly DisplayMessage[] {
  const optimisticMessages = useOptimisticMessagesFor(conversationId);
  const optimisticQueue = useOptimisticQueueFor(conversationId);
  const messageCountBeforeSubmit =
    useMessageCountBeforeSubmitFor(conversationId);
  const sending = useSendingFor(conversationId);
  const reconcileMessages = useReconcileMessages();
  const resolveOptimisticQueueEntries = useResolveOptimisticQueueEntries();

  // The reconcile is keyed to this conversation, so it only ever clears this
  // conversation's optimistic echo — multiple surfaces mounting the same
  // conversation reconcile idempotently.
  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    if (!sending && messages.length > messageCountBeforeSubmit) {
      reconcileMessages(conversationId, messages.length);
    }
  }, [
    conversationId,
    messages.length,
    optimisticMessages.length,
    messageCountBeforeSubmit,
    sending,
    reconcileMessages,
  ]);

  // Reconcile accepted optimistic queue entries: once an entry's durable
  // representation is observed — its durable queue row, or the transcript row
  // its delivery stamped with the queue id — drop the bridge entry from the
  // store. Delivery prunes the durable row server-side, so an unreconciled
  // accepted entry would outlive its dedup key and re-render the message as a
  // duplicate at the end of the feed.
  useEffect(() => {
    if (optimisticQueue.length === 0) return;
    const represented = new Set<string>();
    for (const message of messages) {
      if (message.id !== undefined) represented.add(message.id);
    }
    for (const entry of pendingQueue) {
      if (entry.status === "pending" || entry.status === "delivering") {
        represented.add(entry.id);
      }
    }
    const resolved: string[] = [];
    for (const entry of optimisticQueue) {
      if (entry.queueId !== null && represented.has(entry.queueId)) {
        resolved.push(entry.queueId);
      }
    }
    if (resolved.length > 0) {
      resolveOptimisticQueueEntries(conversationId, resolved);
    }
  }, [
    conversationId,
    messages,
    pendingQueue,
    optimisticQueue,
    resolveOptimisticQueueEntries,
  ]);

  return useMemo(() => {
    if (
      optimisticMessages.length === 0 &&
      pendingQueue.length === 0 &&
      optimisticQueue.length === 0
    ) {
      return messages;
    }
    return buildDisplayProjection({
      messages,
      optimisticMessages,
      messageCountBeforeSubmit,
      sending,
      pendingQueue,
      optimisticQueue,
    });
  }, [
    messages,
    optimisticMessages,
    messageCountBeforeSubmit,
    sending,
    pendingQueue,
    optimisticQueue,
  ]);
}
