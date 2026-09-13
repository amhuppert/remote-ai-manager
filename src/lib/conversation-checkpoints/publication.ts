/**
 * Checkpoint SSE publication, installed as a decorator over the repository.
 *
 * "Publish only after the phase change is durable" is a property of where this
 * lives, not of any caller's discipline. The checkpoint lifecycle is written
 * from four production modules — the manager's start path, maintenance,
 * restart, and pre-turn delivery — and a publish call sprinkled across those
 * call sites would be one edit away from firing before a transaction commits,
 * or from being forgotten by the next one. Wrapping the repository puts the
 * publish strictly after the write it describes and gives every existing and
 * future call site the event for free.
 *
 * The frame body is the same public receipt `GET /checkpoints/<id>` returns,
 * re-read from storage rather than assembled from the write's return value, so
 * a client patching its cache from SSE and a client reading after a reconnect
 * cannot disagree. SSE remains an update channel; the GET is the authority.
 */

import {
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { createLogger, type Logger } from "@/lib/logging";

import { checkpointErrorFields } from "./diagnostics";
import {
  CONVERSATION_CHECKPOINT_UPDATED_EVENT,
  type ConversationCheckpointUpdatedEvent,
} from "./events";
import type { CheckpointReceipt } from "./receipt";
import type {
  AdmitCheckpointInput,
  AdmitCheckpointRecoveryInput,
  AdmittedCheckpoint,
  BeginCheckpointDeliveryInput,
  CheckpointResult,
  CommitCheckpointReadyInput,
  ConversationCheckpointsRepo,
  FreezeCheckpointPayloadInput,
  RecordCheckpointAcceptanceInput,
  RecordCheckpointOutcomeInput,
} from "./repo";
import type { CheckpointOperation, CheckpointScopeKey } from "./schemas";

export interface CheckpointPublicationDeps {
  /** Resolves the public project name from the stored filesystem path. */
  projectName(projectPath: string): string;
  /** Injectable publication; defaults to the typed SSE entry point. */
  publish?: PublishFn;
  log?: Logger;
}

const defaultLogger = createLogger("conversation-checkpoints");

/**
 * Build the scoped frame. A project conversation carries no session key at
 * all — an absent key rather than a placeholder, because a session-less
 * conversation has no correct session name to report.
 */
export function checkpointUpdatedEvent(
  key: CheckpointScopeKey,
  receipt: CheckpointReceipt,
  projectName: string,
): ConversationCheckpointUpdatedEvent {
  const body = {
    type: CONVERSATION_CHECKPOINT_UPDATED_EVENT,
    conversationId: receipt.conversationId,
    receipt,
  } as const;
  return key.sessionName === null
    ? { ...body, scope: "project", projectName }
    : { ...body, scope: "session", projectName, sessionName: key.sessionName };
}

export function withCheckpointPublication(
  repo: ConversationCheckpointsRepo,
  deps: CheckpointPublicationDeps,
): ConversationCheckpointsRepo {
  const log = deps.log ?? defaultLogger;

  function logFields(
    key: CheckpointScopeKey,
    operationId: string,
  ): Record<string, unknown> {
    const scoped =
      key.sessionName === null
        ? { scope: "project" as const }
        : { scope: "session" as const, sessionName: key.sessionName };
    return {
      ...scoped,
      projectName: deps.projectName(key.projectPath),
      conversationId: key.conversationId,
      operationId,
    };
  }

  /**
   * Publish the current receipt of every operation the settled write could have
   * changed. Re-read rather than projected from the caller's return value: a
   * write that also relinks a superseded predecessor changes a row the caller
   * never sees, and reading each one keeps the frame equal to what a GET would
   * answer at this instant.
   */
  async function publishReceipts(
    key: CheckpointScopeKey,
    operationIds: readonly string[],
  ): Promise<void> {
    for (const operationId of new Set(operationIds)) {
      let receipt: CheckpointReceipt | null;
      try {
        receipt = await repo.getReceipt(key, operationId);
      } catch (error) {
        // The write is already durable; a failed read costs the update frame,
        // never the mutation, and the next GET still reports the true state.
        log.warn("checkpoint.event.receipt_read_failed", {
          ...logFields(key, operationId),
          ...checkpointErrorFields(error),
        });
        continue;
      }
      if (receipt === null) continue;
      const built = receipt;
      publishEventBestEffort({
        build: () =>
          checkpointUpdatedEvent(key, built, deps.projectName(key.projectPath)),
        logger: log,
        failureEvent: "checkpoint.event.publish_failed",
        context: { ...logFields(key, operationId), phase: built.phase },
        // The publisher is shared infrastructure and its default failure field
        // is the exception message; a transport that names the reference it
        // lost would put that in a checkpoint log through a helper this module
        // does not own.
        describeError: checkpointErrorFields,
        ...(deps.publish ? { publish: deps.publish } : {}),
      });
    }
  }

  async function publishOperation<T>(
    result: CheckpointResult<T>,
    key: CheckpointScopeKey,
    ids: (value: T) => readonly string[],
  ): Promise<CheckpointResult<T>> {
    if (result.ok) await publishReceipts(key, ids(result.value));
    return result;
  }

  return {
    async createFork(input) {
      return publishOperation(
        await repo.createFork(input),
        input.key,
        (created) => (created.reused ? [] : [created.operation.id]),
      );
    },
    async admitOperation(
      input: AdmitCheckpointInput,
    ): Promise<CheckpointResult<AdmittedCheckpoint>> {
      return publishOperation(
        await repo.admitOperation(input),
        input.key,
        // A reused request id rejoins the operation it already opened: nothing
        // became durable, so there is no phase change to announce.
        (admitted) =>
          admitted.outcome === "admitted" ? [admitted.operation.id] : [],
      );
    },

    async admitRecovery(
      input: AdmitCheckpointRecoveryInput,
    ): Promise<CheckpointResult<AdmittedCheckpoint>> {
      return publishOperation(
        await repo.admitRecovery(input),
        input.key,
        (admitted) =>
          admitted.outcome === "admitted"
            ? [admitted.operation.id, input.recoversOperationId]
            : [],
      );
    },

    async freezePayload(
      input: FreezeCheckpointPayloadInput,
    ): Promise<CheckpointResult<CheckpointOperation>> {
      return publishOperation(
        await repo.freezePayload(input),
        input.key,
        linkedIds,
      );
    },

    async commitReady(
      input: CommitCheckpointReadyInput,
    ): Promise<CheckpointResult<CheckpointOperation>> {
      return publishOperation(
        await repo.commitReady(input),
        input.key,
        linkedIds,
      );
    },

    async beginDelivery(
      input: BeginCheckpointDeliveryInput,
    ): Promise<CheckpointResult<CheckpointOperation>> {
      return publishOperation(
        await repo.beginDelivery(input),
        input.key,
        linkedIds,
      );
    },

    async recordAcceptance(
      input: RecordCheckpointAcceptanceInput,
    ): Promise<CheckpointResult<CheckpointOperation>> {
      return publishOperation(
        await repo.recordAcceptance(input),
        input.key,
        linkedIds,
      );
    },

    async recordOutcome(
      input: RecordCheckpointOutcomeInput,
    ): Promise<CheckpointResult<CheckpointOperation>> {
      return publishOperation(
        await repo.recordOutcome(input),
        input.key,
        linkedIds,
      );
    },

    getStateForAdmission: (key) => repo.getStateForAdmission(key),
    getOperation: (key, operationId) => repo.getOperation(key, operationId),
    getReceipt: (key, operationId) => repo.getReceipt(key, operationId),
    getPayload: (key, operationId) => repo.getPayload(key, operationId),
    listReceipts: (key, options) => repo.listReceipts(key, options),
  };
}

/**
 * The operation a write settled, plus the recovery gate it may have relinked in
 * the same transaction. Publishing both keeps a receipt list correct after a
 * supersession or a restored gate, neither of which is visible in the addressed
 * operation alone.
 */
function linkedIds(operation: CheckpointOperation): readonly string[] {
  return operation.recoversOperationId === null
    ? [operation.id]
    : [operation.id, operation.recoversOperationId];
}
