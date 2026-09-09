/**
 * How a `conversation-checkpoint-updated` frame reconciles the checkpoint
 * caches.
 *
 * The frame's whole body is the public receipt, so a phase change is applied
 * with `setQueryData` rather than a refetch. Eligibility is the exception: it
 * is a server-side predicate set the receipt cannot state (a freed slot, a
 * settled turn), so it is invalidated narrowly for the addressed conversation
 * and nothing else.
 *
 * Every write here is keyed by `operationId` and must be idempotent: an SSE
 * frame and the mutation response that caused it race, and neither order may
 * duplicate a receipt or drop a newer one.
 */

import type { QueryClient } from "@tanstack/react-query";

import type { ConversationTarget } from "@/lib/conversations/conversation-target";

import type { ConversationCheckpointUpdatedEvent } from "./events";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import { receiptSupersedes, type CheckpointReceipt } from "./receipt";
import type { CheckpointListPage } from "./queries";

/** The detail cache shape; the receipt route returns exactly this. */
interface CheckpointDetailCache {
  receipt: CheckpointReceipt;
}

export function checkpointTargetFromEvent(
  event: ConversationCheckpointUpdatedEvent,
): ConversationTarget {
  return event.scope === "session"
    ? {
        scope: "session",
        projectName: event.projectName,
        sessionName: event.sessionName,
        conversationId: event.conversationId,
      }
    : {
        scope: "project",
        projectName: event.projectName,
        conversationId: event.conversationId,
      };
}

/**
 * Fold one receipt into a descending-by-ordinal page.
 *
 * A receipt already in the page is replaced in place — the phase moved, the
 * page did not — unless the cached row is already newer. A receipt the page
 * has never seen belongs at the head only when it is genuinely newer than
 * everything there AND the page has no `before` cursor (a cursored page
 * describes older ordinals, and prepending a new operation onto it would state
 * a window the server never returned). Prepending onto a full page drops its
 * oldest row so the page keeps the size its own limit asked for.
 */
export function foldReceiptIntoPage(
  page: CheckpointListPage,
  receipt: CheckpointReceipt,
  options: { cursored: boolean; limit: number | null },
): CheckpointListPage {
  const index = page.receipts.findIndex(
    (existing) => existing.operationId === receipt.operationId,
  );
  if (index !== -1) {
    const cached = page.receipts[index];
    if (cached !== undefined && !receiptSupersedes(receipt, cached)) {
      return page;
    }
    return {
      ...page,
      receipts: page.receipts.map((existing, at) =>
        at === index ? receipt : existing,
      ),
    };
  }
  const newest = page.receipts[0];
  if (options.cursored) return page;
  if (newest !== undefined && receipt.ordinal <= newest.ordinal) return page;

  const grown = [receipt, ...page.receipts];
  const size = options.limit ?? page.receipts.length;
  // A page shorter than its limit had no more rows to give, so growing it is
  // the truth; a full page keeps its size and hands the tail back to paging.
  const capped = size > 0 && grown.length > size ? grown.slice(0, size) : grown;
  if (capped.length === grown.length) return { ...page, receipts: capped };
  // Rows were evicted. They are still saved operations, so the page has to
  // start advertising a cursor for them — a page that dropped its tail while
  // reporting `nextBefore: null` would claim nothing older exists and delete
  // the only route back to what it just pushed off.
  const oldestKept = capped[capped.length - 1];
  return {
    ...page,
    receipts: capped,
    nextBefore: oldestKept?.ordinal ?? page.nextBefore,
  };
}

interface ListKeyOptions {
  before: number | null;
  limit: number | null;
}

function listKeyOptions(key: readonly unknown[]): ListKeyOptions {
  const tail = key[key.length - 1];
  if (typeof tail !== "object" || tail === null) {
    return { before: null, limit: null };
  }
  const record = tail as Record<string, unknown>;
  return {
    before: typeof record["before"] === "number" ? record["before"] : null,
    limit: typeof record["limit"] === "number" ? record["limit"] : null,
  };
}

/**
 * Publish one receipt into the caches of the conversation it names. Nothing
 * outside that conversation's key prefix is touched, so the two scopes cannot
 * patch each other even when they share a conversation id.
 *
 * Shared by the SSE frame and by every mutation response, so the two cannot
 * reconcile a page differently and their arrival order does not matter.
 */
export function publishCheckpointReceipt(
  queryClient: QueryClient,
  target: CheckpointTarget,
  receipt: CheckpointReceipt,
): void {
  queryClient.setQueryData<CheckpointDetailCache>(
    checkpointKeys.detail(target, receipt.operationId),
    (cached) =>
      cached !== undefined && !receiptSupersedes(receipt, cached.receipt)
        ? cached
        : { receipt },
  );

  for (const [key, page] of queryClient.getQueriesData<CheckpointListPage>({
    queryKey: checkpointKeys.lists(target),
  })) {
    if (page === undefined) continue;
    const options = listKeyOptions(key);
    queryClient.setQueryData(
      key,
      foldReceiptIntoPage(page, receipt, {
        cursored: options.before !== null,
        limit: options.limit,
      }),
    );
  }

  // Eligibility is a server predicate set, not a receipt field: a settled
  // operation frees the slot and a new one takes it, and neither fact is
  // spelled by the frame that reports the phase.
  queryClient.invalidateQueries({
    queryKey: checkpointKeys.eligibility(target),
  });
}

/** Apply one durable phase change announced over SSE. */
export function applyConversationCheckpointUpdatedEvent(
  queryClient: QueryClient,
  event: ConversationCheckpointUpdatedEvent,
): void {
  publishCheckpointReceipt(
    queryClient,
    checkpointTargetFromEvent(event),
    event.receipt,
  );
}
