/**
 * Checkpoint authority hydration: what a host learns from the checkpoint
 * repository before it starts, drains or admits anything.
 *
 * The repository is the authority for checkpoint phase; a machine snapshot is
 * a resume token that may predate a retirement or may be missing or rejected
 * altogether. Hydration therefore reads the durable operation first and, when
 * no process owns it — which after a restart is always — applies the restart
 * rules of design §6 to whatever boundary the crash left it at:
 *
 * - `building`: the generation died with the process. It is failed before any
 *   drain; the source runtime, its reference and its history are untouched.
 * - `retiring`: the payload is durable, so retirement finishes from it. There
 *   is no hosted handle to close after a restart; the reference clear is the
 *   remaining half, and it commits through the same clear-and-commit as a
 *   live retirement. The prior reference is never resumed.
 * - `ready`: stays ready; the next ordinary turn delivers it.
 * - `delivering`: the attempt's outcome is unknown. It enters
 *   `needs_reconciliation` and holds ordinary admission; nothing here infers
 *   acceptance from a reference or resends the input.
 * - `needs_reconciliation`: held, as it was.
 *
 * Callers hold the actor host exclusive section. A refused write is an
 * invariant failure, not a reason to retry against a different operation.
 *
 * Private to the conversation lifecycle (`boundaries.arch.test.ts`): the
 * manager, the actor input loader and startup rehydration call it; nothing
 * else applies restart rules. Every caller applies them only for a
 * conversation with no live host — a hosted one had them applied when its
 * host loaded, and its running work would otherwise read as interrupted —
 * and reads a hosted conversation's authority through
 * `readCheckpointAuthority` instead.
 */

import type {
  CheckpointAdmissionState,
  ConversationCheckpointsRepo,
} from "@/lib/conversation-checkpoints/repo";
import {
  checkpointActorProjection,
  type CheckpointActorProjection,
  type CheckpointOperation,
  type CheckpointScopeKey,
} from "@/lib/conversation-checkpoints/schemas";
import type { Logger } from "@/lib/logging";

export interface CheckpointRestartInfrastructure {
  repo: ConversationCheckpointsRepo;
  now(): string;
  log: Logger;
}

export type CheckpointRestartOutcome =
  | { kind: "none" }
  | { kind: "ready"; operation: CheckpointOperation }
  | { kind: "held"; operation: CheckpointOperation }
  | { kind: "build_interrupted"; operation: CheckpointOperation }
  | { kind: "retirement_completed"; operation: CheckpointOperation }
  | { kind: "retirement_blocked"; operation: CheckpointOperation }
  | { kind: "delivery_unresolved"; operation: CheckpointOperation };

export interface CheckpointAuthorityHydration {
  /** What the actor starts with; null when no operation holds the slot. */
  projection: CheckpointActorProjection | null;
  /** The admission state after the restart rules were applied. */
  state: CheckpointAdmissionState;
  outcome: CheckpointRestartOutcome;
  /**
   * The conversation row owns its provider reference during retirement and
   * recovery. A row clear can settle before snapshot persistence fails, so a
   * held retirement must not restore the reference from an older snapshot.
   */
  continuationRetired: boolean;
}

/** Log identity for one scope key. A project key has no session name to leak. */
export function checkpointKeyLogFields(
  key: CheckpointScopeKey,
): Record<string, string> {
  return {
    scope: key.scope,
    conversationId: key.conversationId,
    ...(key.sessionName === null ? {} : { sessionName: key.sessionName }),
  };
}

function retiredByState(state: CheckpointAdmissionState): boolean {
  if (state.latestAccepted !== null) return true;
  const active = state.active;
  if (active === null) return false;
  if (active.phase === "ready" || active.phase === "delivering") return true;
  return active.phase === "needs_reconciliation";
}

function settled(
  state: CheckpointAdmissionState,
  outcome: CheckpointRestartOutcome,
): CheckpointAuthorityHydration {
  return {
    projection: checkpointActorProjection(state.active),
    state,
    outcome,
    continuationRetired: retiredByState(state),
  };
}

/** The outcome of a state no restart rule applies to: none, ready or held. */
function restingOutcome(
  state: CheckpointAdmissionState,
): CheckpointRestartOutcome {
  const active = state.active;
  return active === null
    ? { kind: "none" }
    : active.phase === "ready"
      ? { kind: "ready", operation: active }
      : { kind: "held", operation: active };
}

/**
 * The authority as it stands, with no restart rule applied: for a
 * conversation whose live host already applied them when it loaded.
 */
export async function readCheckpointAuthority(
  key: CheckpointScopeKey,
  repo: Pick<ConversationCheckpointsRepo, "getStateForAdmission">,
): Promise<CheckpointAuthorityHydration> {
  const state = await repo.getStateForAdmission(key);
  return settled(state, restingOutcome(state));
}

export async function hydrateCheckpointAuthority(
  key: CheckpointScopeKey,
  infra: CheckpointRestartInfrastructure,
): Promise<CheckpointAuthorityHydration> {
  const { repo, log } = infra;
  const fields = checkpointKeyLogFields(key);

  let state = await repo.getStateForAdmission(key);
  const active = state.active;
  if (active === null) return settled(state, { kind: "none" });
  const at = infra.now();
  const operationFields = {
    ...fields,
    operationId: active.id,
    ordinal: active.ordinal,
  };
  switch (active.phase) {
    case "ready":
      return settled(state, { kind: "ready", operation: active });
    case "needs_reconciliation":
      log.info("checkpoint.restart.held", {
        ...operationFields,
        lastStablePhase: active.lastStablePhase,
        errorCode: active.failure?.code ?? null,
      });
      return settled(state, { kind: "held", operation: active });
    case "building": {
      const failed = await repo.recordOutcome({
        key,
        operationId: active.id,
        expectedPhase: "building",
        phase: "failed",
        failure: {
          code: "interrupted",
          message:
            "generation was interrupted by a restart before its payload was frozen",
        },
        at,
      });
      if (failed.ok) {
        log.warn("checkpoint.restart.build_interrupted", operationFields);
        state = await repo.getStateForAdmission(key);
        return settled(state, {
          kind: "build_interrupted",
          operation: failed.value,
        });
      }
      log.warn("checkpoint.restart.write_refused", {
        ...operationFields,
        refusal: failed.refusal.code,
      });
      throw new Error(`checkpoint restart refused: ${failed.refusal.code}`);
    }
    case "retiring": {
      const committed = await repo.commitReady({
        key,
        operationId: active.id,
        at,
      });
      if (committed.ok) {
        log.info("checkpoint.restart.retirement_completed", operationFields);
        state = await repo.getStateForAdmission(key);
        return settled(state, {
          kind: "retirement_completed",
          operation: committed.value,
        });
      }
      if (
        committed.refusal.code === "stale_operation" ||
        committed.refusal.code === "checkpoint_not_found"
      ) {
        log.warn("checkpoint.restart.write_refused", {
          ...operationFields,
          refusal: committed.refusal.code,
        });
        throw new Error(
          `checkpoint restart refused: ${committed.refusal.code}`,
        );
      }
      // The clear itself was refused — the conversation this operation
      // retires is not where the operation says it is. The payload stays
      // durable and the operation stays owned for an explicit repair.
      const blocked = await repo.recordOutcome({
        key,
        operationId: active.id,
        expectedPhase: "retiring",
        phase: "needs_reconciliation",
        failure: {
          code: "readiness_commit_refused",
          message: `readiness was refused after a restart: ${committed.refusal.code}`,
        },
        at,
      });
      if (!blocked.ok) {
        throw new Error(`checkpoint restart refused: ${blocked.refusal.code}`);
      }
      log.error("checkpoint.restart.retirement_blocked", {
        ...operationFields,
        refusal: committed.refusal.code,
        held: blocked.ok,
      });
      state = await repo.getStateForAdmission(key);
      return settled(state, {
        kind: "retirement_blocked",
        operation: blocked.value,
      });
    }
    case "delivering": {
      const held = await repo.recordOutcome({
        key,
        operationId: active.id,
        expectedPhase: "delivering",
        attemptId: active.delivery?.attemptId,
        phase: "needs_reconciliation",
        failure: {
          code: "delivery_unresolved",
          message:
            "a delivery attempt was interrupted by a restart before its acceptance was recorded; review queued deliveries, then run checkpoint reconcile or compact-context --recover",
        },
        at,
      });
      if (held.ok) {
        log.error("checkpoint.restart.delivery_unresolved", {
          ...operationFields,
          attemptId: active.delivery?.attemptId ?? null,
          queuedAttemptId: active.delivery?.queuedAttemptId ?? null,
        });
        state = await repo.getStateForAdmission(key);
        return settled(state, {
          kind: "delivery_unresolved",
          operation: held.value,
        });
      }
      log.warn("checkpoint.restart.write_refused", {
        ...operationFields,
        refusal: held.refusal.code,
      });
      throw new Error(`checkpoint restart refused: ${held.refusal.code}`);
    }
    case "applied":
    case "failed":
    case "cancelled":
      throw new Error(
        `checkpoint restart found inactive phase: ${active.phase}`,
      );
  }
}
