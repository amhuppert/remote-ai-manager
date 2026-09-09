"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import type { CheckpointRefusal } from "@/lib/conversation-checkpoints/admission";
import {
  checkpointRefusalFromError,
  useCancelCheckpointMutation,
  useReconcileCheckpointMutation,
  useStartCheckpointMutation,
} from "@/lib/conversation-checkpoints/mutations";
import {
  checkpointKeys,
  type CheckpointTarget,
} from "@/lib/conversation-checkpoints/query-keys";
import {
  CHECKPOINT_RECENT_LIMIT,
  useCheckpointEligibility,
  useCheckpointList,
  useCheckpointListPages,
  type CheckpointListPage,
} from "@/lib/conversation-checkpoints/queries";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import { conversationTargetKey } from "@/lib/conversations/conversation-target";

import {
  deriveCheckpointActionState,
  deriveCheckpointChipState,
  type CheckpointActionState,
  type CheckpointChipState,
} from "./checkpoint-action-state";

/**
 * Eligibility drives a menu item's enablement, so a long cache would offer an
 * action the conversation stopped accepting. It is also a read-only server
 * predicate — no actor, no reservation — which is what makes refreshing it
 * cheap enough to keep short.
 */
export const CHECKPOINT_ELIGIBILITY_STALE_MS = 5_000;

export interface ConversationCheckpointSurface {
  target: CheckpointTarget;
  /** The newest operation, or null when the conversation has never had one. */
  latest: CheckpointReceipt | null;
  /** Newest first; the panel's recent history. */
  recent: CheckpointReceipt[];
  /** The index holds older operations than `recent` currently carries. */
  hasOlder: boolean;
  /** Read one page further back, up to the server's cap. */
  loadOlder: () => void;
  isLoadingOlder: boolean;
  chip: CheckpointChipState;
  action: CheckpointActionState;
  /** True until the durable state behind the surfaces has been read once. */
  isLoading: boolean;
  isStarting: boolean;
  isCancelling: boolean;
  isReconciling: boolean;
  /** A failure that was not a typed refusal — shown as-is, never interpreted. */
  requestError: string | null;
  start: () => void;
  startRecovery: (operationId: string) => void;
  cancel: (operationId: string) => void;
  reconcile: (operationId: string) => void;
}

/**
 * The one composition both conversation hosts use.
 *
 * Progress is read from the receipt index, never held in component state: the
 * operation outlives this hook, so closing the panel, remounting the host, or
 * reconnecting the event stream all recover the same phase from the server.
 * The mutations seed those caches and are otherwise stateless.
 */
export function useConversationCheckpoint(
  target: CheckpointTarget,
  options: { enabled?: boolean } = {},
): ConversationCheckpointSurface {
  const enabled = options.enabled ?? true;

  // The newest page NEVER changes key. The chip, the panel header and the
  // composer's maintenance hold all read it, so paging history back must not
  // move it — a key that shifted with pagination would stop being refetched,
  // and a build that started during a stream interruption would reach the
  // panel while the composer still believed the conversation was free.
  const headQuery = useCheckpointList(
    target,
    { limit: CHECKPOINT_RECENT_LIMIT },
    { enabled },
  );
  // Older history is read by cursor instead, one page per request the reader
  // makes. Cursors also carry past the server's page cap, where a widening
  // limit would silently stop.
  //
  // What is remembered is HOW MANY pages back the reader asked for, never the
  // cursor ordinals themselves. The index moves under a reader: admitting a
  // checkpoint slides the head page and evicts its oldest row into the window
  // the first cursor covers. A frozen ordinal would keep addressing the old
  // window and leave that evicted row in a hole between two pages, so the
  // chain is rebuilt from what each loaded page reports behind it.
  const [pagesBack, setPagesBack] = useState(0);
  const targetKey = conversationTargetKey(target).join("/");
  const [loadedTargetKey, setLoadedTargetKey] = useState(targetKey);
  if (loadedTargetKey !== targetKey) {
    // A different conversation has its own ordinals; carrying a page count
    // across would claim history this one may not have.
    setLoadedTargetKey(targetKey);
    setPagesBack(0);
  }

  const queryClient = useQueryClient();
  const cursors: number[] = [];
  let walked = headQuery.data;
  while (cursors.length < pagesBack) {
    const next = walked?.nextBefore ?? null;
    if (next === null) break;
    cursors.push(next);
    // Read the already-cached page to extend the chain. The page is fetched by
    // the hook below, which subscribes to it, so this converges: each page that
    // arrives re-renders and lets the chain grow by one.
    walked = queryClient.getQueryData<CheckpointListPage>(
      checkpointKeys.list(target, {
        before: next,
        limit: CHECKPOINT_RECENT_LIMIT,
      }),
    );
    if (walked === undefined) break;
  }
  const olderQueries = useCheckpointListPages(target, cursors, { enabled });
  const eligibilityQuery = useCheckpointEligibility(target, {
    enabled,
    staleTime: CHECKPOINT_ELIGIBILITY_STALE_MS,
  });

  const startMutation = useStartCheckpointMutation(target);
  const cancelMutation = useCancelCheckpointMutation(target);
  const reconcileMutation = useReconcileCheckpointMutation(target);

  const olderPages = olderQueries.map((query) => query.data);
  // Merged on every render rather than memoized: the dependency would be a
  // list whose LENGTH changes as pages are read, and React cannot compare a
  // dependency array that grows — it would keep returning the first merge and
  // silently drop every page after it.
  const recent: CheckpointReceipt[] = [];
  const seenOperationIds = new Set<string>();
  for (const page of [headQuery.data, ...olderPages]) {
    for (const receipt of page?.receipts ?? []) {
      if (seenOperationIds.has(receipt.operationId)) continue;
      seenOperationIds.add(receipt.operationId);
      recent.push(receipt);
    }
  }
  // The newest page always leads: the head query is the authoritative pointer
  // at the current operation, never a paged-in row.
  const latest = headQuery.data?.receipts[0] ?? null;

  // What the last page READ says is behind it — the only authority on whether
  // more saved operations exist.
  const lastLoadedPage = olderPages[olderPages.length - 1] ?? headQuery.data;
  const nextCursor = lastLoadedPage?.nextBefore ?? null;
  const hasOlder = nextCursor !== null;
  const loadOlder = useCallback(() => {
    if (nextCursor === null) return;
    setPagesBack((current) => current + 1);
  }, [nextCursor]);

  // A refusal from any of the three: whichever the user last acted on is the
  // one whose answer they are waiting to read.
  //
  // It is honoured only while it is still the NEWEST word on the subject. A
  // refusal describes the instant the request lost its race — a turn was
  // running, the slot was taken — and every one of those conditions clears on
  // its own. Once the server has answered eligibility again, that answer is
  // more recent than the refusal and wins, so one unlucky click cannot disable
  // the action for the life of the mounted host.
  const eligibilityReadAt = eligibilityQuery.dataUpdatedAt;
  const freshRefusal = (mutation: {
    error: unknown;
    submittedAt: number;
  }): CheckpointRefusal | null =>
    mutation.submittedAt >= eligibilityReadAt
      ? checkpointRefusalFromError(mutation.error)
      : null;

  const serverRefusal =
    freshRefusal(startMutation) ??
    freshRefusal(cancelMutation) ??
    freshRefusal(reconcileMutation);

  const action = deriveCheckpointActionState({
    eligibility: eligibilityQuery.data,
    isLoading: eligibilityQuery.isLoading,
    serverRefusal,
  });

  const start = useCallback(() => {
    startMutation.mutate({});
  }, [startMutation]);

  const startRecovery = useCallback(
    (operationId: string) => {
      startMutation.mutate({ recoversOperationId: operationId });
    },
    [startMutation],
  );

  const cancel = useCallback(
    (operationId: string) => {
      cancelMutation.mutate({ operationId });
    },
    [cancelMutation],
  );

  const reconcile = useCallback(
    (operationId: string) => {
      reconcileMutation.mutate({ operationId });
    },
    [reconcileMutation],
  );

  // The same freshness rule applies to an untyped failure: a dropped
  // connection is not a standing verdict either.
  const untypedFailure =
    serverRefusal !== null
      ? null
      : ([startMutation, cancelMutation, reconcileMutation]
          .filter((mutation) => mutation.submittedAt >= eligibilityReadAt)
          .map((mutation) => mutation.error)
          .find((error) => error != null) ?? null);

  return {
    target,
    latest,
    recent,
    hasOlder,
    loadOlder,
    isLoadingOlder: olderQueries.some((query) => query.isFetching),
    chip: deriveCheckpointChipState(latest),
    action,
    isLoading: headQuery.isLoading || eligibilityQuery.isLoading,
    isStarting: startMutation.isPending,
    isCancelling: cancelMutation.isPending,
    isReconciling: reconcileMutation.isPending,
    requestError: untypedFailure === null ? null : untypedFailure.message,
    start,
    startRecovery,
    cancel,
    reconcile,
  };
}
