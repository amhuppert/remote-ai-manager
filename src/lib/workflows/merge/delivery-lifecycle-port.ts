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
  markDelivered(workflowExecutionId: string, mergeHash: string): Promise<void>;
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
  workflowExecutionId: string,
  mergeHash: string,
): void {
  const lifecycle = state().lifecycle;
  if (lifecycle === null) return;
  void lifecycle.markDelivered(workflowExecutionId, mergeHash).catch((err) => {
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
