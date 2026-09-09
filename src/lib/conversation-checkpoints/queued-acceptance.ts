/**
 * Whether a durable checkpoint acceptance may stand in for a queue receipt
 * the crash never wrote.
 *
 * The delivery turn records the checkpoint's acceptance before it marks the
 * queued rows delivered, so a crash between the two leaves an accepted
 * checkpoint whose binding still names the queued attempt and row, while the
 * rows sit `delivering` or `uncertain`. Three facts, all durable, have to
 * agree before those rows may be confirmed: the acceptance is for the very
 * attempt the binding bound, the rows were claimed under the queued attempt
 * the binding names and include the row it names, and the input reassembled
 * from those rows fingerprints exactly as the bound SUBMITTED input did — the
 * assembled prompt the provider saw also carried the seed and transient
 * context, which no repair can rebuild. Anything
 * short of that — a later attempt's rows, a disagreeing fingerprint, a
 * provider reference with no acceptance — leaves the rows for review, where
 * only an explicit retry can send them again.
 */

import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

import type { CheckpointOperation } from "./schemas";

export interface QueuedAcceptanceRepair {
  /** Every row claimed under the accepted attempt, in queue order. */
  messageIds: string[];
  deliveryAttemptId: string;
  rows: PendingQueuedMessage[];
}

export function repairableQueuedAcceptance(input: {
  operation: Pick<CheckpointOperation, "id" | "delivery" | "acceptance">;
  queue: readonly PendingQueuedMessage[];
  /** The submitted-input fingerprint the drain's assembly of these rows binds. */
  fingerprintRows(rows: readonly PendingQueuedMessage[]): string;
}): QueuedAcceptanceRepair | null {
  const { delivery, acceptance } = input.operation;
  if (delivery === null || acceptance === null) return null;
  if (acceptance.attemptId !== delivery.attemptId) return null;
  if (delivery.queuedAttemptId === null || delivery.queuedMessageId === null)
    return null;
  const rows = input.queue.filter(
    (row) =>
      row.deliveryAttemptId === delivery.queuedAttemptId &&
      (row.status === "delivering" || row.status === "uncertain"),
  );
  if (rows.length === 0) return null;
  if (!rows.some((row) => row.id === delivery.queuedMessageId)) return null;
  if (input.fingerprintRows(rows) !== delivery.submittedInputFingerprint)
    return null;
  return {
    messageIds: rows.map((row) => row.id),
    deliveryAttemptId: delivery.queuedAttemptId,
    rows,
  };
}
