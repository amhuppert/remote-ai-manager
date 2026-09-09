/**
 * Checkpoint admission: the one predicate set behind `checkpoint check`, an
 * ordinary start and a recovery start.
 *
 * Pure over an observation the conversation manager assembles from the
 * durable row, the hosted actor when one exists, the background-activity
 * channel, the backend descriptor and the checkpoint repository. Keeping the
 * predicates here rather than inline in the manager is what lets a read-only
 * check report exactly what a start would refuse without starting an actor,
 * draining a queue, reserving an operation or touching a provider.
 */

import { z } from "zod";

import type { ConversationRole } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

import type { CheckpointAdmissionState } from "./repo";
import {
  checkpointPhaseSchema,
  checkpointStorageRefusalCodeSchema,
  isActiveCheckpointPhase,
  type CheckpointActorProjection,
  type CheckpointOperation,
  type CheckpointPhase,
} from "./schemas";

export const checkpointLifecycleRefusalCodeSchema = z.enum([
  "conversation_not_found",
  "conversation_transient",
  "conversation_archived",
  "conversation_owned",
  "backend_unsupported",
  "debug_mode",
  "question_pending",
  "turn_active",
  "background_work",
  "conversation_busy",
  "no_recorded_history",
  "checkpoint_pending",
  "recovery_required",
  "recovery_target_mismatch",
  "not_cancellable",
  "not_owned",
  /** Queued deliveries are uncertain or failed; review them first. */
  "queue_review_required",
  /** A deterministic reconcile step failed; the operation stays owned. */
  "reconciliation_failed",
]);

export const checkpointRefusalCodeSchema = z.enum([
  ...checkpointLifecycleRefusalCodeSchema.options,
  ...checkpointStorageRefusalCodeSchema.options,
]);
export type CheckpointRefusalCode = z.infer<typeof checkpointRefusalCodeSchema>;

export const checkpointRefusalSchema = z
  .object({
    code: checkpointRefusalCodeSchema,
    reason: z.string().min(1),
    operationId: z.string().min(1).nullable(),
    phase: checkpointPhaseSchema.nullable(),
  })
  .strict();
export type CheckpointRefusal = z.infer<typeof checkpointRefusalSchema>;

export interface CheckpointConversationObservation {
  archived: boolean;
  role: ConversationRole;
  owned: boolean;
  agentBackend: AgentBackendId;
  debugActive: boolean;
  questionPending: boolean;
  transient: boolean;
  promptCount: number;
  transcriptPath: string | null;
  running: boolean;
}

export interface CheckpointHostObservation {
  idle: boolean;
  turnActive: boolean;
  busy: boolean;
  trackedWork: boolean;
}

export interface CheckpointAdmissionObservation {
  requestId: string | null;
  recover: string | null;
  conversation: CheckpointConversationObservation | null;
  backendSupportsCheckpoint: boolean;
  host: CheckpointHostObservation | null;
  /**
   * The manager's in-process reservation for this conversation, reported
   * whether or not a host exists yet: a start reserves before it wakes a
   * dormant host, and a check made in that window must refuse exactly as a
   * competing start would. A start excludes its own reservation.
   */
  reservation: { operationId: string | null } | null;
  backgroundActivity: boolean;
  /**
   * A queued delivery is uncertain or failed. An uncertain entry may or may
   * not have reached the provider, so neither an ordinary checkpoint nor a
   * recovery may proceed until the existing queue review resolves it.
   */
  queueReviewRequired: boolean;
  checkpoints: CheckpointAdmissionState;
  /**
   * An applied checkpoint's accepted continuation is gone — the conversation
   * holds no live reference — and no operation records that yet. A start
   * records it before evaluating; a read-only check reports it as the
   * recovery the start would require.
   */
  continuationLost: { operationId: string; phase: CheckpointPhase } | null;
}

export type CheckpointAdmissionVerdict =
  | {
      eligible: true;
      reuse: CheckpointOperation | null;
      recovers: CheckpointOperation | null;
    }
  | { eligible: false; refusals: [CheckpointRefusal, ...CheckpointRefusal[]] };

function refusal(
  code: CheckpointRefusalCode,
  reason: string,
  operation: CheckpointOperation | null = null,
): CheckpointRefusal {
  return {
    code,
    reason,
    operationId: operation?.id ?? null,
    phase: operation?.phase ?? null,
  };
}

/**
 * Every predicate is reported, not only the first, so a check can list what a
 * start would trip. Order is stable: identity, ownership, capability, settled
 * state, history, then the checkpoint slot itself.
 */
/**
 * The predicates a durable row answers on its own. Shared with the pre-freeze
 * recheck, which re-reads the row so a claim or archival that landed during
 * generation fails the build instead of retiring an owned conversation.
 */
export function evaluateCheckpointConversation(
  conversation: CheckpointConversationObservation | null,
  backendSupportsCheckpoint: boolean,
): CheckpointRefusal[] {
  if (conversation === null) {
    return [
      refusal("conversation_not_found", "the conversation does not exist"),
    ];
  }
  const refusals: CheckpointRefusal[] = [];
  if (conversation.transient) {
    refusals.push(
      refusal(
        "conversation_transient",
        "a synthetic lane has no conversation record to checkpoint",
      ),
    );
  }
  if (conversation.archived) {
    refusals.push(
      refusal("conversation_archived", "the conversation is archived"),
    );
  }
  if (conversation.role !== null || conversation.owned) {
    refusals.push(
      refusal(
        "conversation_owned",
        conversation.role !== null
          ? `a ${conversation.role} conversation is owned by its workflow`
          : "the conversation is held by a running collaboration",
      ),
    );
  }
  if (!backendSupportsCheckpoint) {
    refusals.push(
      refusal(
        "backend_unsupported",
        `backend ${conversation.agentBackend} has no certified checkpoint continuation`,
      ),
    );
  }
  if (conversation.debugActive) {
    refusals.push(refusal("debug_mode", "the conversation is in debug mode"));
  }
  if (conversation.questionPending) {
    refusals.push(
      refusal("question_pending", "a question batch is waiting for an answer"),
    );
  }
  if (conversation.promptCount === 0 || conversation.transcriptPath === null) {
    refusals.push(
      refusal(
        "no_recorded_history",
        "the conversation has no recorded turns to checkpoint",
      ),
    );
  }
  return refusals;
}

export function evaluateCheckpointAdmission(
  observation: CheckpointAdmissionObservation,
): CheckpointAdmissionVerdict {
  const { conversation, host, checkpoints } = observation;
  if (conversation === null) {
    return {
      eligible: false,
      refusals: [
        refusal("conversation_not_found", "the conversation does not exist"),
      ],
    };
  }
  const refusals = evaluateCheckpointConversation(
    conversation,
    observation.backendSupportsCheckpoint,
  );
  const turnActive =
    host === null ? conversation.running : host.turnActive || !host.idle;
  if (turnActive) {
    refusals.push(refusal("turn_active", "a turn is running or admitted"));
  }
  if (observation.backgroundActivity || host?.trackedWork === true) {
    refusals.push(
      refusal(
        "background_work",
        "background agent or tool work is still running",
      ),
    );
  }
  if (host?.busy === true) {
    refusals.push(
      refusal(
        "conversation_busy",
        "the conversation host is stopping, reconciling or running a command",
      ),
    );
  }
  if (observation.queueReviewRequired) {
    refusals.push(
      refusal(
        "queue_review_required",
        "queued deliveries are uncertain or failed; retry or discard them before a checkpoint",
      ),
    );
  }

  const active = checkpoints.active;
  let reuse: CheckpointOperation | null = null;
  let recovers: CheckpointOperation | null = null;
  const lost = active === null ? observation.continuationLost : null;
  if (lost !== null && observation.recover !== lost.operationId) {
    refusals.push({
      code: "recovery_required",
      reason: `operation ${lost.operationId} was applied but its continuation was lost; run compact-context --recover with that operation id`,
      operationId: lost.operationId,
      phase: lost.phase,
    });
  }
  if (lost !== null && observation.recover === lost.operationId) {
    // A start records the loss before it evaluates, so this branch is the
    // read-only check's view of the same recovery: it would be admitted.
  } else if (observation.recover !== null) {
    if (
      active === null ||
      active.id !== observation.recover ||
      active.phase !== "needs_reconciliation" ||
      active.supersededByOperationId !== null
    ) {
      refusals.push(
        refusal(
          "recovery_target_mismatch",
          active === null
            ? "no checkpoint operation requires recovery"
            : `operation ${active.id} is ${active.phase} and is not the recovery target`,
          active,
        ),
      );
    } else {
      recovers = active;
    }
  } else if (active !== null) {
    if (observation.requestId !== null && active.id === observation.requestId) {
      reuse = active;
    } else if (active.phase === "needs_reconciliation") {
      refusals.push(
        refusal(
          "recovery_required",
          `operation ${active.id} needs reconciliation or explicit recovery before another checkpoint`,
          active,
        ),
      );
    } else {
      refusals.push(
        refusal(
          "checkpoint_pending",
          `operation ${active.id} is ${active.phase}`,
          active,
        ),
      );
    }
  }
  const reservation = observation.reservation;
  if (
    reservation !== null &&
    (reservation.operationId === null ||
      (reservation.operationId !== reuse?.id &&
        reservation.operationId !== recovers?.id)) &&
    !refusals.some((entry) => entry.code === "checkpoint_pending")
  ) {
    refusals.push(
      refusal(
        "checkpoint_pending",
        "a checkpoint is being admitted for this conversation",
      ),
    );
  }

  const [first, ...rest] = refusals;
  if (first !== undefined) {
    return { eligible: false, refusals: [first, ...rest] };
  }
  return { eligible: true, reuse, recovers };
}

export function checkpointHoldsOrdinaryAdmission(
  projection: CheckpointActorProjection | null | undefined,
): boolean {
  return (
    projection != null &&
    isActiveCheckpointPhase(projection.phase) &&
    projection.phase !== "ready"
  );
}

/**
 * Whether a provider-initiated turn is refused. A build in progress cannot
 * refuse one — the provider already started it — so the machine admits it and
 * the build yields to it at the freeze fence instead; once the runtime is
 * being retired or replaced there is no runtime for such a turn to belong to.
 */
export function checkpointHoldsExternalAdmission(
  projection: CheckpointActorProjection | null | undefined,
): boolean {
  return (
    checkpointHoldsOrdinaryAdmission(projection) &&
    projection?.phase !== "building"
  );
}
