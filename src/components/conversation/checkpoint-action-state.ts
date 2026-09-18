/**
 * What the checkpoint surfaces show, derived from the two server reads that
 * own the answer: the newest receipt (what happened) and the eligibility
 * predicate set (what may happen next).
 *
 * Three rules shape it. Readiness is not acceptance — `ready` and `applied`
 * are separate states with separate sentences, because a ready seed has
 * retired the old runtime and still not been used by a turn. A refusal the
 * SERVER just returned outranks a cached eligibility read, so a client that
 * lost a race reports the reason it was actually given rather than the one it
 * predicted. And a conversation whose refusal is structural — owned by a
 * workflow, on a backend with no checkpoint capability — offers no executable
 * action at all, rather than an enabled control that would always refuse.
 *
 * Shared by the session and project hosts: the two scopes differ in how a
 * conversation is addressed, never in what a checkpoint means.
 */

import type {
  CheckpointRefusal,
  CheckpointRefusalCode,
} from "@/lib/conversation-checkpoints/admission";
import type { CheckpointEligibility } from "@/lib/conversation-checkpoints/queries";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import type { CheckpointPhase } from "@/lib/conversation-checkpoints/schemas";

// ---------------------------------------------------------------------------
// Chip state — what the newest operation is doing
// ---------------------------------------------------------------------------

export type CheckpointChipState =
  | { kind: "none" }
  | { kind: "building"; captureStage?: "pending" | "running" | "settling" }
  | { kind: "retiring" }
  | { kind: "ready" }
  | { kind: "delivering" }
  | { kind: "applied" }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" }
  | { kind: "needs_reconciliation"; lastStablePhase: CheckpointPhase | null };

export function deriveCheckpointChipState(
  latest: CheckpointReceipt | null | undefined,
): CheckpointChipState {
  if (latest === null || latest === undefined) return { kind: "none" };
  switch (latest.phase) {
    case "building": {
      const stage = latest.handoff?.stage;
      return stage === "pending" || stage === "running" || stage === "settling"
        ? { kind: "building", captureStage: stage }
        : { kind: "building" };
    }
    case "retiring":
    case "ready":
    case "delivering":
    case "applied":
    case "cancelled":
      return { kind: latest.phase };
    case "failed":
      return {
        kind: "failed",
        // A failed operation always carries a typed failure; the fallback
        // states the absence rather than inventing a cause.
        message: latest.failure?.message ?? "The checkpoint build failed.",
      };
    case "needs_reconciliation":
      return {
        kind: "needs_reconciliation",
        lastStablePhase: latest.lastStablePhase,
      };
  }
}

export function checkpointChipLabel(state: CheckpointChipState): string {
  switch (state.kind) {
    case "none":
      return "No checkpoint";
    case "building":
      return state.captureStage === "settling"
        ? "Stopping handoff…"
        : state.captureStage
          ? "Capturing agent handoff…"
          : "Checkpointing…";
    case "retiring":
      return "Retiring context…";
    case "ready":
      return "Checkpoint ready";
    case "delivering":
      return "Delivering…";
    case "applied":
      return "Checkpoint applied";
    case "failed":
      return "Checkpoint failed";
    case "cancelled":
      return "Checkpoint cancelled";
    case "needs_reconciliation":
      return "Needs reconciliation";
  }
}

/**
 * The full sentence a panel and an assistive technology announce. `ready` and
 * `applied` are the pair the design names explicitly: readiness says the next
 * ordinary message will carry the seed, acceptance says one already did.
 */
export function checkpointPhaseHeadline(state: CheckpointChipState): string {
  switch (state.kind) {
    case "none":
      return "No checkpoint has been taken for this conversation";
    case "building":
      return state.captureStage === "settling"
        ? "Stopping handoff…"
        : state.captureStage
          ? "Capturing agent handoff…"
          : "Building the checkpoint";
    case "retiring":
      return "Retiring the current context";
    case "ready":
      return "Checkpoint ready — used by the next message";
    case "delivering":
      return "Delivering the checkpoint to a turn";
    case "applied":
      return "Checkpoint applied";
    case "failed":
      return "Checkpoint failed";
    case "cancelled":
      return "Checkpoint cancelled";
    case "needs_reconciliation":
      return state.lastStablePhase === null
        ? "Checkpoint needs reconciliation"
        : `Checkpoint needs reconciliation — interrupted while ${state.lastStablePhase}`;
  }
}

/** Phases where work is in flight and a progress indicator is honest. */
export function checkpointChipIsBusy(state: CheckpointChipState): boolean {
  return (
    state.kind === "building" ||
    state.kind === "retiring" ||
    state.kind === "delivering"
  );
}

// ---------------------------------------------------------------------------
// Action state — what the user may do next
// ---------------------------------------------------------------------------

export type CheckpointActionState =
  | { kind: "loading" }
  | { kind: "available" }
  | {
      kind: "in_progress";
      code: CheckpointRefusalCode;
      reason: string;
      operationId: string | null;
      phase: CheckpointPhase | null;
    }
  | { kind: "disabled"; code: CheckpointRefusalCode; reason: string }
  | { kind: "unsupported"; code: CheckpointRefusalCode; reason: string }
  | {
      kind: "recovery";
      code: CheckpointRefusalCode;
      reason: string;
      operationId: string | null;
    }
  | {
      kind: "queue_review";
      code: CheckpointRefusalCode;
      reason: string;
      operationId: string | null;
    };

/**
 * Refusals that are a property of the conversation rather than of this moment.
 * Waiting does not clear any of them, so their surfaces offer no executable
 * action — only the sentence that explains why.
 */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "conversation_transient",
  "conversation_archived",
  "conversation_owned",
  "backend_unsupported",
  "no_recorded_history",
  "conversation_not_found",
  "target_conversation_missing",
]);

/**
 * The user-facing sentence for each refusal. Written for someone looking at
 * the conversation — the CLI's own remedies name `cctl` commands and are not
 * reusable here — and kept to what the refusal actually establishes.
 */
const REFUSAL_REASON: Readonly<Partial<Record<string, string>>> = {
  conversation_transient:
    "This conversation is transient — it has no durable continuity to retire.",
  conversation_archived:
    "This conversation is archived. Unarchive it to take a checkpoint.",
  conversation_owned:
    "A workflow or collaboration owns this conversation's turns, so a checkpoint would retire context it is still using.",
  backend_unsupported:
    "This conversation's agent backend declares no checkpoint capability. Generate a compaction artifact instead.",
  no_recorded_history:
    "There is no recorded history yet — send at least one message first.",
  conversation_not_found: "This conversation no longer exists in this scope.",
  target_conversation_missing:
    "The conversation this checkpoint retires no longer exists in this scope.",
  debug_mode: "Leave debug mode to take a checkpoint.",
  question_pending: "Answer the pending question first.",
  turn_active: "A turn is running. The checkpoint can start once it settles.",
  background_work:
    "Background work is still running in this conversation. The checkpoint can start once it settles.",
  conversation_busy:
    "The conversation is busy. The checkpoint can start once it settles.",
  checkpoint_pending: "A checkpoint is already running for this conversation.",
  recovery_required:
    "An earlier checkpoint's outcome is unresolved. Supersede it explicitly with a recovery checkpoint — it is never continued in place.",
  recovery_target_mismatch:
    "Recovery addresses one named operation, and this one does not require recovery.",
  reconciliation_failed:
    "A deterministic repair step failed. Reconcile again to retry it.",
  queue_review_required:
    "A queued delivery may or may not have reached the provider. Review the uncertain queued messages first — CC never replays uncertain input automatically.",
  not_cancellable:
    "This operation already retired the conversation's context, and cancelling cannot restore a provider session.",
  not_owned: "This operation is not owned by this conversation any more.",
};

export function checkpointRefusalReason(refusal: CheckpointRefusal): string {
  // The server's own sentence is the fallback rather than a placeholder: a
  // refusal code this table has not met still says something true.
  return REFUSAL_REASON[refusal.code] ?? refusal.reason;
}

function fromRefusal(
  refusal: CheckpointRefusal,
  active: CheckpointReceipt | null,
): CheckpointActionState {
  const reason = checkpointRefusalReason(refusal);
  const operationId = refusal.operationId ?? active?.operationId ?? null;
  if (UNSUPPORTED_CODES.has(refusal.code)) {
    return { kind: "unsupported", code: refusal.code, reason };
  }
  if (refusal.code === "queue_review_required") {
    return { kind: "queue_review", code: refusal.code, reason, operationId };
  }
  if (
    refusal.code === "recovery_required" ||
    refusal.code === "recovery_target_mismatch" ||
    refusal.code === "reconciliation_failed"
  ) {
    return { kind: "recovery", code: refusal.code, reason, operationId };
  }
  if (refusal.code === "checkpoint_pending") {
    return {
      kind: "in_progress",
      code: refusal.code,
      reason,
      operationId,
      phase: refusal.phase ?? active?.phase ?? null,
    };
  }
  return { kind: "disabled", code: refusal.code, reason };
}

export interface CheckpointActionInput {
  eligibility: CheckpointEligibility | undefined;
  isLoading?: boolean;
  /**
   * A refusal the server returned to THIS client's last attempt. It outranks
   * the cached predicate set: the race it lost is exactly the case where the
   * cached read is stale.
   */
  serverRefusal?: CheckpointRefusal | null;
}

export function deriveCheckpointActionState(
  input: CheckpointActionInput,
): CheckpointActionState {
  const active = input.eligibility?.active ?? null;
  if (input.serverRefusal != null) {
    return fromRefusal(input.serverRefusal, active);
  }
  if (input.eligibility === undefined) {
    return { kind: "loading" };
  }
  if (input.eligibility.eligible) return { kind: "available" };

  // The server orders refusals primary-first, so the head is the one to show.
  const primary = input.eligibility.refusals[0];
  return primary === undefined
    ? { kind: "loading" }
    : fromRefusal(primary, active);
}
