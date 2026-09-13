import { createLogger } from "@/lib/logging";
import { getGlobalSingleton } from "@/lib/shared/global-singleton";

const logger = createLogger("merge.delivery-lifecycle");

/**
 * Prompt Delivered marking for gated final-publish merges that complete
 * through the background-job host (user /merge, HTTP merge, conflict retry).
 * The graph join path calls its own lifecycle callback; this port gives the
 * job path the same promptness. Registration is optional — read-path
 * reconciliation (published-merge lookup on status reads) remains the designed
 * backstop, and the registered implementation is idempotent by
 * (execution, mergeHash).
 */
export interface MergeDeliveryLifecycle {
  markDelivered(
    workflowExecutionId: string | undefined,
    mergeHash: string,
    specExecutionId?: string,
  ): Promise<void>;
}

/**
 * The commit a completed merge delivered, or null when it delivered nothing.
 *
 * A merge that landed carries its own commit. A merge that found the target
 * already containing the branch published none, yet delivered exactly the same
 * content, so the target tip the delivery gate evaluated as its candidate
 * stands for it — otherwise a no-op final publish would finish its session
 * while leaving the execution it delivered permanently unmarked.
 */
export function resolveDeliveredMergeSha(merge: {
  mergeHash?: string | null;
  upToDate?: boolean;
  expectedTargetSha?: string | null;
}): string | null {
  if (merge.mergeHash !== undefined && merge.mergeHash !== null) {
    return merge.mergeHash;
  }
  if (merge.upToDate !== true) return null;
  return merge.expectedTargetSha ?? null;
}

const MERGE_DELIVERY_LIFECYCLE_KEY = "__cc_merge_delivery_lifecycle" as const;

interface MergeDeliveryLifecycleState {
  lifecycle: MergeDeliveryLifecycle | null;
}

function state(): MergeDeliveryLifecycleState {
  return getGlobalSingleton(MERGE_DELIVERY_LIFECYCLE_KEY, () => ({
    lifecycle: null,
  }));
}

export function registerMergeDeliveryLifecycle(
  lifecycle: MergeDeliveryLifecycle,
): void {
  state().lifecycle = lifecycle;
}

/** Fire-and-forget: delivery marking must never fail the merge job itself. */
export function notifyRegisteredMergeDelivered(
  workflowExecutionId: string | undefined,
  mergeHash: string,
  specExecutionId?: string,
): void {
  const lifecycle = state().lifecycle;
  if (lifecycle === null) return;
  void lifecycle
    .markDelivered(workflowExecutionId, mergeHash, specExecutionId)
    .catch((err) => {
      logger.error("merge.delivery_lifecycle_failed", {
        workflowExecutionId,
        mergeHash,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export function _resetMergeDeliveryLifecycleForTesting(): void {
  state().lifecycle = null;
}
