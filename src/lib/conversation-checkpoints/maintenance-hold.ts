/**
 * Whether checkpoint maintenance currently holds a conversation, and the
 * client-side read of that fact.
 *
 * This exists because checkpoint maintenance is INVISIBLE to ordinary turn
 * state. The manager reserves the conversation to build and retire a
 * checkpoint without running an ordinary turn, so `status` stays idle while a
 * direct prompt would be refused as busy. A composer that routes on status
 * alone therefore sends into the refusal and loses the user's message instead
 * of durably queuing it.
 */

import { useCallback, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";

import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import type { CheckpointListPage } from "./queries";
import type { CheckpointReceipt } from "./receipt";
import type { CheckpointPhase } from "./schemas";

/**
 * The phases during which the manager owns the conversation for maintenance.
 *
 * `ready` is deliberately absent: readiness is the whole point of the feature,
 * and the next ordinary message is what carries the seed — holding it back
 * would strand the checkpoint it was built for. `delivering` is absent too,
 * because a turn attempt is in flight by then and ordinary turn state already
 * describes it.
 */
const HOLDING_PHASES: readonly CheckpointPhase[] = ["building", "retiring"];

export function checkpointMaintenanceHoldsConversation(
  latest: CheckpointReceipt | null,
): boolean {
  return latest !== null && HOLDING_PHASES.includes(latest.phase);
}

/**
 * The hold, read from whatever the conversation's checkpoint surfaces have
 * already cached.
 *
 * Deliberately fetch-free: the host's chip and panel own the receipt query, so
 * subscribing to the same key here keeps the composer reactive without adding
 * a second observer that would poll the index from every composer on screen. A
 * conversation whose host renders no checkpoint surface simply reads no hold,
 * which is the same behavior as before this existed.
 */
export function useCheckpointMaintenanceHold(
  target: CheckpointTarget | null,
  listOptions: { limit?: number } = {},
): boolean {
  const queryClient = useQueryClient();
  // A conversation-less composer observes a key nothing writes, rather than
  // the domain prefix — subscribing to the prefix would make it a sibling of
  // every real cache entry.
  const queryKey =
    target === null
      ? ([...checkpointKeys.all, "no-conversation"] as const)
      : checkpointKeys.list(target, listOptions);
  const subscribe = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(notify)),
    [queryClient],
  );
  const snapshot = () => queryClient.getQueryData<CheckpointListPage>(queryKey);
  const data = useSyncExternalStore(subscribe, snapshot, snapshot);
  return checkpointMaintenanceHoldsConversation(data?.receipts[0] ?? null);
}
