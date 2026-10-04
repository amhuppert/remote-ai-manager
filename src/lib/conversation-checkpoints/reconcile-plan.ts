/**
 * What a deterministic checkpoint reconcile does with one operation that no
 * build in this process owns, decided from its durable record alone. Pure, so
 * the repair a reconcile performs never depends on which engine runs the
 * conversation; the caller performs the step and reports the result.
 *
 * A reconcile never asks the model anything. An operation that needs the
 * model again (an unresolved delivery, a lost continuation) is blocked behind
 * the queue review or an explicit `compact-context --recover`.
 */

import type { CheckpointRefusalCode } from "./admission";
import type { CheckpointOperation } from "./schemas";

export type CheckpointReconcilePlan =
  /** Settled, or waiting for its next ordinary turn: nothing to repair. */
  | { kind: "unchanged" }
  | { kind: "refused"; code: CheckpointRefusalCode; reason: string }
  /** A build whose outcome never landed: the restart rules settle it, as they do one a crash interrupted. */
  | { kind: "apply_restart_rules" }
  /** The payload is frozen: close the retired runtime again, then clear the reference and commit readiness. */
  | { kind: "finish_retirement" }
  /** Readiness committed and only its receipts failed: declare it ready again. */
  | { kind: "declare_ready" }
  /** A capture whose execution was never confirmed: observe that nothing of it still runs. */
  | { kind: "observe_capture_cleanup" }
  | { kind: "blocked"; code: "queue_review_required" | "recovery_required"; reason: string };

export interface CheckpointReconcileFacts {
  /** Queued deliveries are uncertain or failed and wait for the person's review. */
  queueReviewRequired: boolean;
  /** The caller acknowledged that prior capture execution has stopped. */
  captureExecutionStopped: boolean;
}

function isCaptureCleanupHold(operation: CheckpointOperation): boolean {
  const handoff = operation.handoff;
  return (
    operation.phase === "needs_reconciliation" &&
    operation.lastStablePhase === "building" &&
    operation.payloadId === null &&
    handoff !== null &&
    handoff.stage === "omitted" &&
    (handoff.omissionReason === "interrupted" || handoff.omissionReason === "cleanup_unverified")
  );
}

export function planCheckpointReconcile(
  operation: CheckpointOperation,
  facts: CheckpointReconcileFacts,
): CheckpointReconcilePlan {
  if (operation.supersededByOperationId !== null) {
    return {
      kind: "refused",
      code: "stale_operation",
      reason: `operation ${operation.id} is superseded by recovery ${operation.supersededByOperationId}`,
    };
  }
  const captureHold = isCaptureCleanupHold(operation);
  if (facts.captureExecutionStopped && !captureHold) {
    return {
      kind: "refused",
      code: "invalid_handoff",
      reason: "execution acknowledgement applies only to capture execution uncertainty",
    };
  }
  switch (operation.phase) {
    case "building":
      return { kind: "apply_restart_rules" };
    case "retiring":
      return { kind: "finish_retirement" };
    case "delivering":
      return { kind: "refused", code: "conversation_busy", reason: "a delivery attempt is in flight for this operation" };
    case "ready":
    case "applied":
    case "failed":
    case "cancelled":
      return { kind: "unchanged" };
    case "needs_reconciliation":
      break;
  }
  if (captureHold) {
    return operation.handoff?.executionSettled === true
      ? {
          kind: "blocked",
          code: "recovery_required",
          reason:
            "capture cleanup is settled; run compact-context --recover with this operation id for a fresh baseline checkpoint",
        }
      : { kind: "observe_capture_cleanup" };
  }
  switch (operation.lastStablePhase) {
    case "retiring":
      return { kind: "finish_retirement" };
    case "ready":
      return { kind: "declare_ready" };
    case "delivering":
      return facts.queueReviewRequired
        ? {
            kind: "blocked",
            code: "queue_review_required",
            reason:
              "the attempted delivery is unresolved; retry or discard the uncertain queued deliveries, then run compact-context --recover with this operation id",
          }
        : {
            kind: "blocked",
            code: "recovery_required",
            reason:
              "the attempted delivery is unresolved; run compact-context --recover with this operation id to build a fresh checkpoint",
          };
    case "applied":
      return {
        kind: "blocked",
        code: "recovery_required",
        reason:
          "the applied continuation became unusable; run compact-context --recover with this operation id to build a fresh checkpoint from the recorded history",
      };
    default:
      return {
        kind: "blocked",
        code: "recovery_required",
        reason: "this operation needs explicit recovery; run compact-context --recover with this operation id",
      };
  }
}
