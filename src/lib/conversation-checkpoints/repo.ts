import { discardHandoffCandidate } from "./schemas";
import { isValidCheckpointForkPayload } from "./fork-validation";
/**
 * The durable authority for a conversation's checkpoint phase.
 *
 * Standalone repository over the shared connection and write queue, in the
 * `context_artifacts` / memory-telemetry shape rather than a member of
 * `AllRepos`: nothing here belongs to a conversation row, and no ordinary row
 * write may reach it.
 *
 * Two rules shape every method:
 *
 * 1. **Evidence, not intent.** A caller states the operation it believes it
 *    holds and the phase it believes that operation is in; a write that does
 *    not match is refused with the operation's actual phase rather than
 *    applied. The lifecycle itself lives in `transitions.ts`, so no method
 *    encodes its own copy.
 * 2. **Refusals are values.** Every contested outcome is a typed
 *    `CheckpointStorageRefusal` the caller can report; a thrown error here
 *    means the database itself failed, not that the caller lost a race.
 */

import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { createLogger, type Logger } from "@/lib/logging";
import {
  parseTrusted,
  registerTrustedSchema,
} from "@/lib/shared/parse-trusted";
import { PersistenceError } from "@/lib/shared/errors";
import type { WriteQueue } from "@/lib/state-store/write-queue";

import type { ConversationState } from "@/lib/conversations/schemas";
import type { CheckpointForkOrigin } from "./fork-schemas";

import type { CheckpointConversationGateway } from "./continuation";
import { checkpointReceipt, type CheckpointReceipt } from "./receipt";
import type { CheckpointPayloadReceipt } from "./receipt";
import {
  ACTIVE_CHECKPOINT_PHASES,
  checkpointExecutionStopAttestationSchema,
  checkpointHandoffSchema,
  checkpointOperationSchema,
  checkpointPayloadSchema,
  checkpointSeedBytesAgree,
  type CheckpointHandoff,
  type CheckpointExecutionStopAttestation,
  type CheckpointAcceptance,
  type CheckpointDeliveryBinding,
  type CheckpointFailure,
  type CheckpointOperation,
  type CheckpointPayload,
  type CheckpointPhase,
  type CheckpointScopeKey,
  type CheckpointSourceBasis,
  type CheckpointStorageRefusal,
  type CheckpointStorageRefusalCode,
  type CheckpointUsage,
} from "./schemas";
import {
  validateCaptureTransition,
  validateCheckpointOutcomeEdge,
  validateCheckpointTransition,
} from "./transitions";

type Db = InstanceType<typeof Database>;

const defaultLogger = createLogger("conversation-checkpoints.repo");

export const DEFAULT_CHECKPOINT_LIST_LIMIT = 20;
export const MAX_CHECKPOINT_LIST_LIMIT = 100;

export type CheckpointResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: CheckpointStorageRefusal };

export type CheckpointAdmissionOutcome = "admitted" | "reused";

export interface AdmittedCheckpoint {
  outcome: CheckpointAdmissionOutcome;
  operation: CheckpointOperation;
}

export interface CreateCheckpointForkInput {
  sourceKey: CheckpointScopeKey;
  sourceOperationId: string;
  key: CheckpointScopeKey;
  conversation: ConversationState;
  origin: CheckpointForkOrigin;
}

export interface CreatedCheckpointFork {
  conversation: ConversationState;
  operation: CheckpointOperation;
  reused: boolean;
}

export interface AdmitCheckpointInput {
  handoff?: CheckpointHandoff | null;
  key: CheckpointScopeKey;
  /** Caller-generated UUID; becomes the operation and checkpoint id. */
  requestId: string;
  sourceBasis: CheckpointSourceBasis;
  priorBackendRef: string | null;
  requestedAt: string;
}

export interface AdmitCheckpointRecoveryInput extends AdmitCheckpointInput {
  /** The recovery-required operation this build supersedes. */
  recoversOperationId: string;
}

export interface BeginCheckpointCaptureInput {
  key: CheckpointScopeKey;
  operationId: string;
  captureId: string;
  expectedSourceBasis: CheckpointSourceBasis;
  at: string;
}

export interface SettleCheckpointCaptureInput extends BeginCheckpointCaptureInput {
  expectedStage: "pending" | "running" | "settling";
  settlement:
    | { kind: "stop"; intent: "skip" | "cancel" }
    | { kind: "result"; handoff: CheckpointHandoff };
}

export interface FreezeCheckpointPayloadInput {
  handoffDecision?: "included" | "seed_budget";
  key: CheckpointScopeKey;
  operationId: string;
  payload: CheckpointPayload;
  /**
   * Measured cost of the generation that produced this payload. Recorded here
   * because a successful build reaches no later outcome write; absent fields
   * stay unavailable rather than becoming zero.
   */
  usage?: CheckpointUsage;
  at: string;
  /**
   * Runs inside the write's critical section immediately before the insert,
   * handed the addressed conversation row as it stands in that transaction.
   * A returned failure refuses the freeze with `fence_refused` and writes
   * nothing, so neither an in-process condition — a cancel, a provider turn,
   * background work — nor a durable one — a claim, an archival — can land
   * between an asynchronous observation and the commit that retires the
   * runtime.
   */
  fence?(conversation: ConversationState | null): CheckpointFailure | null;
}

export interface CommitCheckpointReadyInput {
  key: CheckpointScopeKey;
  operationId: string;
  at: string;
}

export interface BeginCheckpointDeliveryInput {
  key: CheckpointScopeKey;
  operationId: string;
  binding: CheckpointDeliveryBinding;
  at: string;
}

export interface RecordCheckpointAcceptanceInput {
  key: CheckpointScopeKey;
  operationId: string;
  acceptance: CheckpointAcceptance;
  acceptedBackendRef: string;
}

export interface RecordCheckpointOutcomeInput {
  /** Observations from the owned adapter result; never settlement authority. */
  captureObservation?: Pick<
    CheckpointHandoff,
    | "captureId"
    | "modeEstablished"
    | "submitted"
    | "correlatedCompletion"
    | "activity"
    | "usage"
    | "continuationDisposition"
  >;
  captureCleanupObserved?: { captureId: string };
  captureExecutionStopAttestation?: CheckpointExecutionStopAttestation;
  key: CheckpointScopeKey;
  operationId: string;
  expectedPhase: CheckpointPhase;
  /**
   * The delivery attempt this outcome is about. Required when the operation is
   * `delivering`, because phase alone does not identify a delivery: a failed
   * attempt returns the seed to `ready`, a later attempt re-enters
   * `delivering`, and the first attempt's late outcome would otherwise land on
   * the second one's work. Outcomes from every other phase are not
   * attempt-scoped and leave this unset.
   */
  attemptId?: string;
  phase: CheckpointPhase;
  failure?: CheckpointFailure;
  usage?: CheckpointUsage;
  generationPassCount?: number;
  at: string;
}

/**
 * The accepted provenance of one conversation, selected by its recorded
 * acceptance rather than by current phase — an operation that later needs
 * recovery keeps the proof that this seed was once applied.
 */
export interface CheckpointAcceptedProvenance {
  operationId: string;
  ordinal: number;
  currentPhase: CheckpointPhase;
  acceptance: CheckpointAcceptance;
  /**
   * Protected: the reference that accepted the seed. The admission gate
   * compares it against live continuation to detect loss; it is never
   * published, so this projection is internal and has no receipt counterpart.
   */
  acceptedBackendRef: string;
}

export interface CheckpointAdmissionState {
  active: CheckpointOperation | null;
  latestAccepted: CheckpointAcceptedProvenance | null;
}

export interface ListCheckpointReceiptsOptions {
  /** Exclusive upper bound: return ordinals strictly below this one. */
  before?: number;
  limit?: number;
}

export interface CheckpointReceiptPage {
  receipts: CheckpointReceipt[];
  /** Cursor for the next page, or null when this page is the last. */
  nextBefore: number | null;
}

export interface ConversationCheckpointsRepo {
  beginCapture(
    input: BeginCheckpointCaptureInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  settleCapture(
    input: SettleCheckpointCaptureInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  createFork(
    input: CreateCheckpointForkInput,
  ): Promise<CheckpointResult<CreatedCheckpointFork>>;
  /**
   * Admit an ordinary checkpoint. Idempotent on the request UUID for the same
   * conversation; refused while any other operation holds the slot.
   */
  admitOperation(
    input: AdmitCheckpointInput,
  ): Promise<CheckpointResult<AdmittedCheckpoint>>;
  /**
   * Admit a recovery build against a named recovery-required operation,
   * superseding it in the same transaction. Ordinary start cannot do this.
   */
  admitRecovery(
    input: AdmitCheckpointRecoveryInput,
  ): Promise<CheckpointResult<AdmittedCheckpoint>>;
  /**
   * Insert the immutable payload and advance `building → retiring` atomically.
   * Runs after the source basis is compared, so a build over changed source
   * cannot retire a runtime.
   */
  freezePayload(
    input: FreezeCheckpointPayloadInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  /**
   * Advance to `ready` once the retired runtime is closed, clearing the target's
   * stored provider reference in the same transaction. Also the repair for a
   * reconciliation that interrupted that retirement, because finishing it is
   * the same clear-and-commit.
   */
  commitReady(
    input: CommitCheckpointReadyInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  /** Bind the admitted attempt to this seed before the provider is called. */
  beginDelivery(
    input: BeginCheckpointDeliveryInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  /**
   * Record acceptance against matching attempt and seed-hash evidence. A repeat
   * with identical evidence is idempotent; anything else is refused.
   */
  recordAcceptance(
    input: RecordCheckpointAcceptanceInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  /**
   * Apply a validated failure, cancellation, return-to-ready, or reconciliation
   * transition. A failing recovery build restores the gate it superseded in the
   * same transaction. Reports work that finished, so it reaches only the edges
   * no other method owns: a payload freeze, a retirement, a delivery binding
   * and an acceptance each need their own evidence, and returning a blocked
   * seed to `ready` needs the evidence for the block it repairs.
   */
  recordOutcome(
    input: RecordCheckpointOutcomeInput,
  ): Promise<CheckpointResult<CheckpointOperation>>;
  /** What the admission gate needs, without reading any payload text. */
  getStateForAdmission(
    key: CheckpointScopeKey,
  ): Promise<CheckpointAdmissionState>;
  getOperation(
    key: CheckpointScopeKey,
    operationId: string,
  ): Promise<CheckpointOperation | null>;
  getReceipt(
    key: CheckpointScopeKey,
    operationId: string,
  ): Promise<CheckpointReceipt | null>;
  /** The explicit seed disclosure. Every other read omits payload bodies. */
  getPayload(
    key: CheckpointScopeKey,
    operationId: string,
  ): Promise<CheckpointPayload | null>;
  listReceipts(
    key: CheckpointScopeKey,
    options?: ListCheckpointReceiptsOptions,
  ): Promise<CheckpointReceiptPage>;
}

// ============================================================
// Row contracts
// ============================================================

const operationRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    scope: z.enum(["session", "project"]),
    project_path: z.string(),
    session_name: z.string().nullable(),
    conversation_id: z.string(),
    ordinal: z.number().int(),
    phase: z.string(),
    last_stable_phase: z.string().nullable(),
    captured_through_seq: z.number().int(),
    source_hash: z.string(),
    handoff_json: z.string().nullable(),
    prior_backend_ref: z.string().nullable(),
    accepted_backend_ref: z.string().nullable(),
    payload_id: z.string().nullable(),
    delivery_attempt_id: z.string().nullable(),
    delivery_input_fingerprint: z.string().nullable(),
    delivery_submitted_input_fingerprint: z.string().nullable(),
    queued_delivery_attempt_id: z.string().nullable(),
    queued_delivery_message_id: z.string().nullable(),
    accepted_attempt_id: z.string().nullable(),
    accepted_seed_hash: z.string().nullable(),
    accepted_at: z.string().nullable(),
    failure_code: z.string().nullable(),
    failure_message: z.string().nullable(),
    recovers_operation_id: z.string().nullable(),
    superseded_by_operation_id: z.string().nullable(),
    generation_pass_count: z.number().int().nullable(),
    usage_input_tokens: z.number().int().nullable(),
    usage_cached_input_tokens: z.number().int().nullable(),
    usage_output_tokens: z.number().int().nullable(),
    usage_cost_usd: z.number().nullable(),
    usage_duration_ms: z.number().int().nullable(),
    requested_at: z.string(),
    updated_at: z.string(),
  }),
  "conversation-checkpoint-operation-row",
);

const payloadRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    schema_version: z.number().int(),
    captured_through_seq: z.number().int(),
    source_hash: z.string(),
    source_artifact_id: z.string().nullable(),
    source_artifact_hash: z.string().nullable(),
    generator_version: z.string(),
    builder_version: z.string(),
    normalizer_version: z.string(),
    model_selection_json: z.string(),
    sections_json: z.string(),
    seed_text: z.string(),
    seed_sha256: z.string(),
    section_bytes_json: z.string(),
    omissions_json: z.string(),
    generation_pass_count: z.number().int(),
    created_at: z.string(),
  }),
  "conversation-checkpoint-payload-row",
);

/** The bounded payload columns a receipt may carry — never a body. */
const payloadReceiptRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    schema_version: z.number().int(),
    seed_sha256: z.string(),
    section_bytes_json: z.string(),
    omissions_json: z.string(),
    generator_version: z.string(),
    builder_version: z.string(),
    normalizer_version: z.string(),
    source_artifact_id: z.string().nullable(),
    source_artifact_hash: z.string().nullable(),
    created_at: z.string(),
  }),
  "conversation-checkpoint-payload-receipt-row",
);

const PAYLOAD_RECEIPT_COLUMNS = `
  p.id                   AS id,
  p.schema_version       AS schema_version,
  p.seed_sha256          AS seed_sha256,
  p.section_bytes_json   AS section_bytes_json,
  p.omissions_json       AS omissions_json,
  p.generator_version    AS generator_version,
  p.builder_version      AS builder_version,
  p.normalizer_version   AS normalizer_version,
  p.source_artifact_id   AS source_artifact_id,
  p.source_artifact_hash AS source_artifact_hash,
  p.created_at           AS created_at
`;

function jsonColumn(entity: string, id: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new PersistenceError({
      kind: "validation",
      entity,
      identifier: id,
      issues: cause,
    });
  }
}

function rowToOperation(raw: unknown): CheckpointOperation {
  const row = parseTrusted(operationRowSchema, raw);
  return parseTrusted(checkpointOperationSchema, {
    id: row.id,
    scope: row.scope,
    projectPath: row.project_path,
    sessionName: row.session_name,
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    phase: row.phase,
    lastStablePhase: row.last_stable_phase,
    handoff:
      row.handoff_json === null
        ? null
        : checkpointHandoffSchema.parse(
            jsonColumn(
              "conversation-checkpoint-operation",
              row.id,
              row.handoff_json,
            ),
          ),
    sourceBasis: {
      capturedThroughSeq: row.captured_through_seq,
      sourceHash: row.source_hash,
    },
    protectedReferences: {
      priorBackendRef: row.prior_backend_ref,
      acceptedBackendRef: row.accepted_backend_ref,
    },
    payloadId: row.payload_id,
    delivery:
      row.delivery_attempt_id === null ||
      row.delivery_input_fingerprint === null ||
      row.delivery_submitted_input_fingerprint === null
        ? null
        : {
            attemptId: row.delivery_attempt_id,
            inputFingerprint: row.delivery_input_fingerprint,
            submittedInputFingerprint: row.delivery_submitted_input_fingerprint,
            queuedAttemptId: row.queued_delivery_attempt_id,
            queuedMessageId: row.queued_delivery_message_id,
          },
    acceptance:
      row.accepted_attempt_id === null ||
      row.accepted_seed_hash === null ||
      row.accepted_at === null
        ? null
        : {
            attemptId: row.accepted_attempt_id,
            seedHash: row.accepted_seed_hash,
            acceptedAt: row.accepted_at,
          },
    failure:
      row.failure_code === null || row.failure_message === null
        ? null
        : { code: row.failure_code, message: row.failure_message },
    recoversOperationId: row.recovers_operation_id,
    supersededByOperationId: row.superseded_by_operation_id,
    generationPassCount: row.generation_pass_count,
    usage: {
      inputTokens: row.usage_input_tokens,
      cachedInputTokens: row.usage_cached_input_tokens,
      outputTokens: row.usage_output_tokens,
      costUsd: row.usage_cost_usd,
      durationMs: row.usage_duration_ms,
    },
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  });
}

function rowToPayload(raw: unknown): CheckpointPayload {
  const row = parseTrusted(payloadRowSchema, raw);
  const entity = "conversation-checkpoint-payload";
  return parseTrusted(checkpointPayloadSchema, {
    id: row.id,
    schemaVersion: row.schema_version,
    sourceBasis: {
      capturedThroughSeq: row.captured_through_seq,
      sourceHash: row.source_hash,
    },
    artifactProvenance:
      row.source_artifact_id === null || row.source_artifact_hash === null
        ? null
        : {
            artifactId: row.source_artifact_id,
            artifactSourceHash: row.source_artifact_hash,
          },
    versions: {
      generatorVersion: row.generator_version,
      builderVersion: row.builder_version,
      normalizerVersion: row.normalizer_version,
    },
    modelSelection: jsonColumn(entity, row.id, row.model_selection_json),
    sections: jsonColumn(entity, row.id, row.sections_json),
    seedText: row.seed_text,
    seedSha256: row.seed_sha256,
    sectionBytes: jsonColumn(entity, row.id, row.section_bytes_json),
    omissions: jsonColumn(entity, row.id, row.omissions_json),
    generationPassCount: row.generation_pass_count,
    createdAt: row.created_at,
  });
}

function rowToPayloadReceipt(raw: unknown): CheckpointPayloadReceipt {
  const row = parseTrusted(payloadReceiptRowSchema, raw);
  const entity = "conversation-checkpoint-payload";
  const sectionBytes = jsonColumn(entity, row.id, row.section_bytes_json);
  const omissions = jsonColumn(entity, row.id, row.omissions_json);
  if (!isSectionBytes(sectionBytes) || !isOmissionList(omissions)) {
    throw new PersistenceError({
      kind: "validation",
      entity,
      identifier: row.id,
      issues: "payload receipt columns did not decode to their declared shape",
    });
  }
  return {
    checkpointId: row.id,
    schemaVersion: row.schema_version,
    seedSha256: row.seed_sha256,
    sectionBytes,
    omissions,
    versions: {
      generatorVersion: row.generator_version,
      builderVersion: row.builder_version,
      normalizerVersion: row.normalizer_version,
    },
    artifactProvenance:
      row.source_artifact_id === null || row.source_artifact_hash === null
        ? null
        : {
            artifactId: row.source_artifact_id,
            artifactSourceHash: row.source_artifact_hash,
          },
    createdAt: row.created_at,
  };
}

function isSectionBytes(
  value: unknown,
): value is CheckpointPayloadReceipt["sectionBytes"] {
  return (
    typeof value === "object" &&
    value !== null &&
    "total" in value &&
    typeof (value as { total: unknown }).total === "number"
  );
}

function isOmissionList(
  value: unknown,
): value is CheckpointPayloadReceipt["omissions"] {
  return Array.isArray(value);
}

// ============================================================
// Refusals
// ============================================================

function refuse<T>(
  code: CheckpointStorageRefusalCode,
  reason: string,
  operation: { id: string; phase: CheckpointPhase } | null,
): CheckpointResult<T> {
  return {
    ok: false,
    refusal: {
      code,
      reason,
      operationId: operation?.id ?? null,
      phase: operation?.phase ?? null,
    },
  };
}

function ok<T>(value: T): CheckpointResult<T> {
  return { ok: true, value };
}

/**
 * `lastStablePhase` names what a reconciliation interrupted: written on the way
 * in, cleared on the way out. The rules for leaving `needs_reconciliation` ask
 * this field what the block was about, so a value left behind after the repair
 * would answer for an interruption that no longer exists.
 */
function nextLastStablePhase(
  operation: CheckpointOperation,
  to: CheckpointPhase,
): CheckpointPhase | null {
  if (to === "needs_reconciliation") return operation.phase;
  if (operation.phase === "needs_reconciliation") return null;
  return operation.lastStablePhase;
}

/**
 * Refuse a write to an operation a recovery build has taken over.
 *
 * Supersession is a link rather than a phase (see `transitions.ts`), so the
 * transition table cannot express it: a superseded operation keeps
 * `needs_reconciliation` precisely so it still records why it was blocked, and
 * that phase is otherwise a legal starting point for both `ready` and
 * `applied`. Every mutation that accepts `needs_reconciliation` as a from-phase
 * therefore has to ask the link, not the phase.
 */
function supersededRefusal<T>(
  operation: CheckpointOperation,
): CheckpointResult<T> | null {
  if (operation.supersededByOperationId === null) return null;
  return refuse(
    "stale_operation",
    `operation ${operation.id} is superseded by recovery ${operation.supersededByOperationId}`,
    operation,
  );
}

/** Log identity for one operation. Never carries a provider reference. */
function operationLogFields(
  key: CheckpointScopeKey,
  operationId: string,
): Record<string, string> {
  return {
    scope: key.scope,
    conversationId: key.conversationId,
    operationId,
    ...(key.sessionName === null ? {} : { sessionName: key.sessionName }),
  };
}

export function createConversationCheckpointsRepo(
  db: Db,
  writeQueue: WriteQueue,
  continuation: CheckpointConversationGateway,
  logger: Logger = defaultLogger,
): ConversationCheckpointsRepo {
  const activePhaseList = ACTIVE_CHECKPOINT_PHASES.map(
    (phase) => `'${phase}'`,
  ).join(", ");

  /** Refuse when the conversation an admission would address is not there. */
  function missingTargetRefusal<T>(
    key: CheckpointScopeKey,
  ): CheckpointResult<T> | null {
    if (continuation.exists(key)) return null;
    return refuse(
      "target_conversation_missing",
      "the addressed conversation does not exist in this scope",
      null,
    );
  }

  const findByIdStmt = db.prepare(
    `SELECT * FROM conversation_checkpoint_operations WHERE id = ?`,
  );
  const findScopedStmt = db.prepare(
    `SELECT * FROM conversation_checkpoint_operations
      WHERE id = @id AND scope = @scope AND project_path = @project_path
        AND session_name IS @session_name AND conversation_id = @conversation_id`,
  );
  const findActiveStmt = db.prepare(
    `SELECT * FROM conversation_checkpoint_operations
      WHERE scope = @scope AND project_path = @project_path
        AND session_name IS @session_name AND conversation_id = @conversation_id
        AND phase IN (${activePhaseList})
        AND superseded_by_operation_id IS NULL
      LIMIT 1`,
  );
  const findLatestAcceptedStmt = db.prepare(
    `SELECT * FROM conversation_checkpoint_operations
      WHERE scope = @scope AND project_path = @project_path
        AND session_name IS @session_name AND conversation_id = @conversation_id
        AND accepted_at IS NOT NULL
      ORDER BY accepted_at DESC, ordinal DESC
      LIMIT 1`,
  );
  const nextOrdinalStmt = db
    .prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 FROM conversation_checkpoint_operations
        WHERE scope = @scope AND conversation_id = @conversation_id`,
    )
    .pluck();
  const insertOperationStmt = db.prepare(
    `INSERT INTO conversation_checkpoint_operations (
       id, scope, project_path, session_name, conversation_id, ordinal, phase,
       captured_through_seq, source_hash, prior_backend_ref,
       recovers_operation_id, requested_at, updated_at, handoff_json
     ) VALUES (
       @id, @scope, @project_path, @session_name, @conversation_id, @ordinal,
       'building', @captured_through_seq, @source_hash, @prior_backend_ref,
       @recovers_operation_id, @requested_at, @updated_at, @handoff_json
     )`,
  );
  const setSupersededByStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET superseded_by_operation_id = @superseded_by, updated_at = @updated_at
      WHERE id = @id`,
  );
  const insertPayloadStmt = db.prepare(
    `INSERT INTO conversation_checkpoints (
       id, schema_version, captured_through_seq, source_hash,
       source_artifact_id, source_artifact_hash, generator_version,
       builder_version, normalizer_version, model_selection_json, sections_json,
       seed_text, seed_sha256, section_bytes_json, omissions_json,
       generation_pass_count, created_at
     ) VALUES (
       @id, @schema_version, @captured_through_seq, @source_hash,
       @source_artifact_id, @source_artifact_hash, @generator_version,
       @builder_version, @normalizer_version, @model_selection_json,
       @sections_json, @seed_text, @seed_sha256, @section_bytes_json,
       @omissions_json, @generation_pass_count, @created_at
     )`,
  );
  const freezeOperationStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET phase = 'retiring', payload_id = @id, handoff_json = @handoff_json,
            generation_pass_count = @generation_pass_count,
            usage_input_tokens = COALESCE(@usage_input_tokens, usage_input_tokens),
            usage_cached_input_tokens =
              COALESCE(@usage_cached_input_tokens, usage_cached_input_tokens),
            usage_output_tokens =
              COALESCE(@usage_output_tokens, usage_output_tokens),
            usage_cost_usd = COALESCE(@usage_cost_usd, usage_cost_usd),
            usage_duration_ms = COALESCE(@usage_duration_ms, usage_duration_ms),
            updated_at = @updated_at
      WHERE id = @id AND phase = 'building'`,
  );
  const setPhaseStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET phase = @phase, last_stable_phase = @last_stable_phase,
            updated_at = @updated_at
      WHERE id = @id AND phase = @expected_phase
        AND superseded_by_operation_id IS NULL`,
  );
  const beginDeliveryStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET phase = 'delivering', delivery_attempt_id = @attempt_id,
            delivery_input_fingerprint = @input_fingerprint,
            delivery_submitted_input_fingerprint = @submitted_input_fingerprint,
            queued_delivery_attempt_id = @queued_attempt_id,
            queued_delivery_message_id = @queued_message_id,
            updated_at = @updated_at
      WHERE id = @id AND phase = @expected_phase`,
  );
  const recordAcceptanceStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET phase = 'applied', accepted_attempt_id = @attempt_id,
            accepted_seed_hash = @seed_hash, accepted_at = @accepted_at,
            accepted_backend_ref = @accepted_backend_ref,
            last_stable_phase = NULL, updated_at = @accepted_at
      WHERE id = @id AND phase = @expected_phase
        AND superseded_by_operation_id IS NULL
        AND accepted_attempt_id IS NULL`,
  );
  const recordOutcomeStmt = db.prepare(
    `UPDATE conversation_checkpoint_operations
        SET phase = @phase, handoff_json = @handoff_json,
            last_stable_phase = @last_stable_phase,
            failure_code = COALESCE(@failure_code, failure_code),
            failure_message = COALESCE(@failure_message, failure_message),
            generation_pass_count =
              COALESCE(@generation_pass_count, generation_pass_count),
            usage_input_tokens = COALESCE(@usage_input_tokens, usage_input_tokens),
            usage_cached_input_tokens =
              COALESCE(@usage_cached_input_tokens, usage_cached_input_tokens),
            usage_output_tokens =
              COALESCE(@usage_output_tokens, usage_output_tokens),
            usage_cost_usd = COALESCE(@usage_cost_usd, usage_cost_usd),
            usage_duration_ms = COALESCE(@usage_duration_ms, usage_duration_ms),
            updated_at = @updated_at
      WHERE id = @id AND phase = @expected_phase
        AND superseded_by_operation_id IS NULL
        AND (@expected_attempt_id IS NULL
             OR delivery_attempt_id = @expected_attempt_id)`,
  );
  const findPayloadStmt = db.prepare(
    `SELECT p.* FROM conversation_checkpoints p
       JOIN conversation_checkpoint_operations o ON o.id = p.id
      WHERE p.id = @id AND o.scope = @scope AND o.project_path = @project_path
        AND o.session_name IS @session_name
        AND o.conversation_id = @conversation_id`,
  );
  const findPayloadReceiptStmt = db.prepare(
    `SELECT ${PAYLOAD_RECEIPT_COLUMNS} FROM conversation_checkpoints p
      WHERE p.id = ?`,
  );
  const listOperationsStmt = db.prepare(
    `SELECT * FROM conversation_checkpoint_operations
      WHERE scope = @scope AND project_path = @project_path
        AND session_name IS @session_name AND conversation_id = @conversation_id
        AND ordinal < @before
      ORDER BY ordinal DESC
      LIMIT @limit`,
  );

  function insertPayload(payload: CheckpointPayload): void {
    insertPayloadStmt.run({
      id: payload.id,
      schema_version: payload.schemaVersion,
      captured_through_seq: payload.sourceBasis.capturedThroughSeq,
      source_hash: payload.sourceBasis.sourceHash,
      source_artifact_id: payload.artifactProvenance?.artifactId ?? null,
      source_artifact_hash:
        payload.artifactProvenance?.artifactSourceHash ?? null,
      generator_version: payload.versions.generatorVersion,
      builder_version: payload.versions.builderVersion,
      normalizer_version: payload.versions.normalizerVersion,
      model_selection_json: JSON.stringify(payload.modelSelection),
      sections_json: JSON.stringify(payload.sections),
      seed_text: payload.seedText,
      seed_sha256: payload.seedSha256,
      section_bytes_json: JSON.stringify(payload.sectionBytes),
      omissions_json: JSON.stringify(payload.omissions),
      generation_pass_count: payload.generationPassCount,
      created_at: payload.createdAt,
    });
  }

  function scopeBind(key: CheckpointScopeKey): {
    scope: string;
    project_path: string;
    session_name: string | null;
    conversation_id: string;
  } {
    return {
      scope: key.scope,
      project_path: key.projectPath,
      session_name: key.sessionName,
      conversation_id: key.conversationId,
    };
  }

  function findScoped(
    key: CheckpointScopeKey,
    operationId: string,
  ): CheckpointOperation | null {
    const raw: unknown = findScopedStmt.get({
      ...scopeBind(key),
      id: operationId,
    });
    return raw === undefined ? null : rowToOperation(raw);
  }

  function findActive(key: CheckpointScopeKey): CheckpointOperation | null {
    const raw: unknown = findActiveStmt.get(scopeBind(key));
    return raw === undefined ? null : rowToOperation(raw);
  }

  function reload(operationId: string): CheckpointOperation {
    const raw: unknown = findByIdStmt.get(operationId);
    if (raw === undefined) {
      throw new PersistenceError({
        kind: "not_found",
        entity: "conversation-checkpoint-operation",
        identifier: operationId,
      });
    }
    return rowToOperation(raw);
  }

  /**
   * Shared prelude for admission: resolve a reused request id, or the operation
   * that currently holds the slot. Returns `null` when the caller may proceed.
   */
  function admissionBlock(
    key: CheckpointScopeKey,
    requestId: string,
    ignoreActiveId: string | null,
  ): CheckpointResult<AdmittedCheckpoint> | null {
    const raw: unknown = findByIdStmt.get(requestId);
    if (raw !== undefined) {
      const existing = rowToOperation(raw);
      const sameTarget =
        existing.scope === key.scope &&
        existing.projectPath === key.projectPath &&
        existing.sessionName === key.sessionName &&
        existing.conversationId === key.conversationId;
      if (sameTarget) {
        return ok({ outcome: "reused", operation: existing });
      }
      // The colliding operation belongs to another conversation, so this caller
      // learns that the id is taken and nothing else about it.
      return refuse(
        "request_id_conflict",
        "this request id already addresses a different conversation",
        null,
      );
    }

    const active = findActive(key);
    if (active !== null && active.id !== ignoreActiveId) {
      return refuse(
        "checkpoint_pending",
        `checkpoint operation ${active.id} is already ${active.phase}`,
        active,
      );
    }
    return null;
  }

  function captureOperation(
    input: BeginCheckpointCaptureInput,
  ): CheckpointResult<CheckpointOperation> {
    const operation = findScoped(input.key, input.operationId);
    if (operation === null)
      return refuse(
        "checkpoint_not_found",
        "no such checkpoint operation in this scope",
        null,
      );
    if (
      operation.phase !== "building" ||
      operation.payloadId !== null ||
      operation.supersededByOperationId !== null
    )
      return refuse(
        "stale_operation",
        "capture requires an unfrozen active build",
        operation,
      );
    if (
      operation.handoff === null ||
      operation.handoff.captureId !== input.captureId
    )
      return refuse(
        "invalid_handoff",
        "capture identity does not match the admitted intent",
        operation,
      );
    return ok(operation);
  }

  function writeCapture(
    operation: CheckpointOperation,
    handoff: CheckpointHandoff,
    at: string,
  ): CheckpointResult<CheckpointOperation> {
    const parsed = checkpointHandoffSchema.safeParse(handoff);
    if (!parsed.success)
      return refuse(
        "invalid_handoff",
        "capture metadata does not describe a valid state",
        operation,
      );
    const basis = handoff.finalSourceBasis ?? operation.sourceBasis;
    const written = db
      .prepare(
        `UPDATE conversation_checkpoint_operations
      SET handoff_json = @handoff, captured_through_seq = @seq, source_hash = @hash, updated_at = @at
      WHERE id = @id AND phase = 'building' AND payload_id IS NULL AND superseded_by_operation_id IS NULL
      AND captured_through_seq = @prior_seq AND source_hash = @prior_hash`,
      )
      .run({
        id: operation.id,
        handoff: JSON.stringify(parsed.data),
        seq: basis.capturedThroughSeq,
        hash: basis.sourceHash,
        at,
        prior_seq: operation.sourceBasis.capturedThroughSeq,
        prior_hash: operation.sourceBasis.sourceHash,
      });
    if (written.changes !== 1)
      return refuse(
        "stale_operation",
        "capture changed before the write",
        operation,
      );
    logger.info("checkpoint.capture.persisted", {
      operationId: operation.id,
      conversationId: operation.conversationId,
      scope: operation.scope,
      captureId: handoff.captureId,
      stage: handoff.stage,
    });
    return ok(reload(operation.id));
  }

  function invalidHandoffAdmission(
    input: AdmitCheckpointInput,
  ): CheckpointResult<AdmittedCheckpoint> | null {
    if (input.handoff == null) return null;
    const parsed = checkpointHandoffSchema.safeParse(input.handoff);
    if (
      !parsed.success ||
      parsed.data.stage !== "pending" ||
      parsed.data.captureId !== `${input.requestId}:capture` ||
      parsed.data.admissionSourceBasis.capturedThroughSeq !==
        input.sourceBasis.capturedThroughSeq ||
      parsed.data.admissionSourceBasis.sourceHash !==
        input.sourceBasis.sourceHash
    ) {
      return refuse(
        "invalid_handoff",
        "capture admission requires a pending intent bound to this operation and source",
        null,
      );
    }
    return null;
  }

  function insertAdmitted(
    input: AdmitCheckpointInput,
    recoversOperationId: string | null,
  ): CheckpointOperation {
    const ordinal = nextOrdinalStmt.get({
      scope: input.key.scope,
      conversation_id: input.key.conversationId,
    });
    if (typeof ordinal !== "number") {
      throw new PersistenceError({
        kind: "io",
        cause: "checkpoint ordinal allocation returned a non-numeric value",
      });
    }
    insertOperationStmt.run({
      ...scopeBind(input.key),
      id: input.requestId,
      ordinal,
      captured_through_seq: input.sourceBasis.capturedThroughSeq,
      source_hash: input.sourceBasis.sourceHash,
      prior_backend_ref: input.priorBackendRef,
      handoff_json:
        input.handoff == null
          ? null
          : JSON.stringify(checkpointHandoffSchema.parse(input.handoff)),
      recovers_operation_id: recoversOperationId,
      requested_at: input.requestedAt,
      updated_at: input.requestedAt,
    });
    return reload(input.requestId);
  }

  return {
    async beginCapture(input) {
      return writeQueue.withWriteQueueSync("checkpoint.beginCapture", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const found = captureOperation(input);
            if (!found.ok) return found;
            const operation = found.value;
            const handoff = operation.handoff;
            if (handoff === null)
              return refuse(
                "invalid_handoff",
                "capture was not requested",
                operation,
              );
            if (
              !isDeepStrictEqual(
                operation.sourceBasis,
                input.expectedSourceBasis,
              )
            )
              return refuse(
                "source_basis_mismatch",
                "capture source changed",
                operation,
              );
            if (handoff.stage === "running" && handoff.startedAt === input.at)
              return ok(operation);
            if (
              !validateCaptureTransition(handoff.stage, "running") ||
              handoff.requestedMode === null
            )
              return refuse(
                "illegal_transition",
                "capture cannot begin from this stage or without a disclosed mode",
                operation,
              );
            return writeCapture(
              operation,
              { ...handoff, stage: "running", startedAt: input.at },
              input.at,
            );
          })
          .immediate(),
      );
    },
    async settleCapture(input) {
      return writeQueue.withWriteQueueSync("checkpoint.settleCapture", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const found = captureOperation(input);
            if (!found.ok) return found;
            const operation = found.value;
            const current = operation.handoff;
            if (current === null)
              return refuse(
                "invalid_handoff",
                "capture was not requested",
                operation,
              );
            if (
              input.settlement.kind === "result" &&
              current.finalSourceBasis !== null &&
              isDeepStrictEqual(current, input.settlement.handoff) &&
              isDeepStrictEqual(
                input.expectedSourceBasis,
                current.admissionSourceBasis,
              )
            )
              return ok(operation);
            if (
              !isDeepStrictEqual(
                operation.sourceBasis,
                input.expectedSourceBasis,
              )
            )
              return refuse(
                "source_basis_mismatch",
                "capture source changed",
                operation,
              );
            if (input.settlement.kind === "stop") {
              const intent = input.settlement.intent;
              if (
                current.stage === "settling" &&
                (current.stopIntent === intent ||
                  current.stopIntent === "cancel")
              )
                return ok(operation);
              if (
                current.stage !== input.expectedStage ||
                (current.stage !== "settling" &&
                  !validateCaptureTransition(current.stage, "settling"))
              )
                return refuse(
                  "stale_operation",
                  "capture is no longer awaiting settlement",
                  operation,
                );
              return writeCapture(
                operation,
                {
                  ...current,
                  stage: "settling",
                  startedAt: current.startedAt ?? input.at,
                  stopIntent: intent,
                },
                input.at,
              );
            }
            const handoff = input.settlement.handoff;
            if (handoff.omissionReason === "seed_budget")
              return refuse(
                "invalid_handoff",
                "seed-budget omission requires atomic payload finalization",
                operation,
              );
            const parsed = checkpointHandoffSchema.safeParse(handoff);
            if (
              !parsed.success ||
              !handoff.executionSettled ||
              !handoff.auditDurable ||
              handoff.finalSourceBasis === null ||
              handoff.settledAt !== input.at ||
              handoff.finalizedAt !== null ||
              handoff.executionStopAttestation !== null ||
              (handoff.stage !== "captured" && handoff.stage !== "omitted")
            )
              return refuse(
                "invalid_handoff",
                "capture result requires settled execution, durable audit and a final source",
                operation,
              );
            if (
              current.stage !== input.expectedStage ||
              current.finalSourceBasis !== null ||
              !validateCaptureTransition(current.stage, handoff.stage)
            )
              return refuse(
                "stale_operation",
                "capture was already settled or changed stage",
                operation,
              );
            const pinned = [
              "captureId",
              "requestedMode",
              "policyVersion",
              "backend",
              "modelSelection",
              "admissionSourceBasis",
              "requestedAt",
              "startedAt",
              "stopIntent",
            ] as const;
            if (
              pinned.some(
                (field) => !isDeepStrictEqual(current[field], handoff[field]),
              )
            )
              return refuse(
                "invalid_handoff",
                "capture result changed its admitted identity or stop intent",
                operation,
              );
            if (
              current.stopIntent !== null &&
              handoff.omissionReason !==
                (current.stopIntent === "cancel" ? "cancelled" : "skipped")
            )
              return refuse(
                "invalid_handoff",
                "capture result does not honor its stop intent",
                operation,
              );
            if (
              handoff.finalSourceBasis.capturedThroughSeq <
                operation.sourceBasis.capturedThroughSeq ||
              (handoff.sourceCoverage !== null &&
                (handoff.sourceCoverage.seqStart <=
                  current.admissionSourceBasis.capturedThroughSeq ||
                  handoff.sourceCoverage.seqEnd >
                    handoff.finalSourceBasis.capturedThroughSeq))
            )
              return refuse(
                "source_basis_mismatch",
                "capture coverage is outside the owned final source",
                operation,
              );
            return writeCapture(operation, parsed.data, input.at);
          })
          .immediate(),
      );
    },
    async createFork(input) {
      return writeQueue.withWriteQueueSync("checkpoint.createFork", () =>
        db
          .transaction((): CheckpointResult<CreatedCheckpointFork> => {
            const { key, sourceKey, origin } = input;
            const existing = continuation.find(key);
            if (existing !== null) {
              const operation = findScoped(key, origin.operationId);
              if (
                existing.checkpointFork?.requestHash === origin.requestHash &&
                existing.checkpointFork.sourceOperationId ===
                  input.sourceOperationId &&
                existing.checkpointFork.source.conversationId ===
                  sourceKey.conversationId &&
                operation !== null
              ) {
                logger.info(
                  "checkpoint.fork.reused",
                  operationLogFields(key, operation.id),
                );
                return ok({ conversation: existing, operation, reused: true });
              }
              return refuse(
                "request_id_conflict",
                "the request id already belongs to another fork",
                operation,
              );
            }
            const sourceOperation = findScoped(
              sourceKey,
              input.sourceOperationId,
            );
            const raw: unknown = findPayloadStmt.get({
              ...scopeBind(sourceKey),
              id: input.sourceOperationId,
            });
            if (sourceOperation === null || raw === undefined) {
              return refuse(
                "checkpoint_not_found",
                "no saved checkpoint exists in the source scope",
                null,
              );
            }
            const sourceConversation = continuation.find(sourceKey);
            if (
              sourceConversation === null ||
              sourceConversation.archived ||
              sourceConversation.role !== null ||
              sourceConversation.owner !== null
            ) {
              return refuse(
                "fence_refused",
                "the source must be an ordinary, non-archived, unowned conversation",
                sourceOperation,
              );
            }
            const payload = rowToPayload(raw);
            const expectedEvidenceSource =
              sourceConversation.checkpointFork?.operationId ===
              sourceOperation.id
                ? sourceConversation.checkpointFork.evidenceSource
                : origin.source;
            if (
              origin.submission !== undefined ||
              origin.initialSelection.backend !==
                input.conversation.agentBackend ||
              JSON.stringify(expectedEvidenceSource) !==
                JSON.stringify(origin.evidenceSource)
            ) {
              return refuse(
                "invalid_payload",
                "fork evidence and initial selection must belong to the addressed source and fresh target",
                sourceOperation,
              );
            }
            if (
              key.scope !== sourceKey.scope ||
              key.projectPath !== sourceKey.projectPath ||
              key.sessionName !== sourceKey.sessionName ||
              key.conversationId === sourceKey.conversationId ||
              key.conversationId !== input.conversation.id ||
              origin.operationId !== key.conversationId ||
              origin.sourceOperationId !== sourceOperation.id ||
              origin.source.conversationId !== sourceKey.conversationId ||
              origin.source.scope !== sourceKey.scope ||
              (origin.source.scope === "session" &&
                origin.source.sessionName !== sourceKey.sessionName) ||
              origin.ordinal !== sourceOperation.ordinal ||
              origin.schemaVersion !== payload.schemaVersion ||
              origin.capturedThroughSeq !==
                payload.sourceBasis.capturedThroughSeq ||
              origin.seedSha256 !== payload.seedSha256 ||
              !isValidCheckpointForkPayload(payload)
            ) {
              return refuse(
                "invalid_payload",
                "fork provenance must match the saved checkpoint and its source scope",
                sourceOperation,
              );
            }
            if (
              input.conversation.promptCount !== 0 ||
              input.conversation.backendRef !== null ||
              input.conversation.forkedFrom !== null ||
              input.conversation.transcriptPath !== null ||
              input.conversation.role !== null ||
              input.conversation.owner !== null
            ) {
              return refuse(
                "fence_refused",
                "the fork must start as a fresh ordinary conversation",
                sourceOperation,
              );
            }
            if (findByIdStmt.get(origin.operationId) !== undefined) {
              return refuse(
                "request_id_conflict",
                "the request id already names a checkpoint operation",
                null,
              );
            }
            const conversation = {
              ...input.conversation,
              checkpointFork: origin,
            };
            continuation.insert(key, conversation);
            insertAdmitted(
              {
                key,
                requestId: origin.operationId,
                sourceBasis: payload.sourceBasis,
                priorBackendRef: null,
                requestedAt: conversation.createdAt,
              },
              null,
            );
            insertPayload({ ...payload, id: origin.operationId });
            db.prepare(
              "UPDATE conversation_checkpoint_operations SET phase = 'ready', payload_id = id, generation_pass_count = 0 WHERE id = ?",
            ).run(origin.operationId);
            const operation = reload(origin.operationId);
            logger.info("checkpoint.fork.created", {
              ...operationLogFields(key, operation.id),
              sourceConversationId: sourceKey.conversationId,
              sourceOperationId: sourceOperation.id,
              seedSha256: payload.seedSha256,
            });
            return ok({ conversation, operation, reused: false });
          })
          .immediate(),
      );
    },
    async admitOperation(input) {
      return writeQueue.withWriteQueueSync("checkpoint.admitOperation", () =>
        db
          .transaction((): CheckpointResult<AdmittedCheckpoint> => {
            const blocked = admissionBlock(input.key, input.requestId, null);
            if (blocked !== null) return blocked;
            // After the reuse check, so a retransmitted request keeps its
            // existing operation, and before the insert, so a lost race with
            // deletion refuses rather than persisting an unreachable row.
            const missing = missingTargetRefusal<AdmittedCheckpoint>(input.key);
            if (missing !== null) return missing;
            const invalidHandoff = invalidHandoffAdmission(input);
            if (invalidHandoff !== null) return invalidHandoff;
            const operation = insertAdmitted(input, null);
            logger.info("conversation-checkpoints.admitted", {
              ...operationLogFields(input.key, operation.id),
              ordinal: operation.ordinal,
              capturedThroughSeq: operation.sourceBasis.capturedThroughSeq,
            });
            return ok({ outcome: "admitted", operation });
          })
          .immediate(),
      );
    },

    async admitRecovery(input) {
      return writeQueue.withWriteQueueSync("checkpoint.admitRecovery", () =>
        db
          .transaction((): CheckpointResult<AdmittedCheckpoint> => {
            const target = findScoped(input.key, input.recoversOperationId);
            if (target === null) {
              return refuse(
                "checkpoint_not_found",
                "the addressed recovery operation does not exist in this scope",
                null,
              );
            }
            // The addressed operation is expected to hold the slot; any OTHER
            // active operation means a recovery already won this race.
            const blocked = admissionBlock(
              input.key,
              input.requestId,
              target.id,
            );
            if (blocked !== null) return blocked;
            if (
              target.phase !== "needs_reconciliation" ||
              target.supersededByOperationId !== null
            ) {
              return refuse(
                "recovery_target_mismatch",
                `operation ${target.id} is ${target.phase} and does not require recovery`,
                target,
              );
            }

            if (target.handoff !== null && !target.handoff.executionSettled)
              return refuse(
                "invalid_handoff",
                "capture execution must be settled or acknowledged before recovery",
                target,
              );

            const missing = missingTargetRefusal<AdmittedCheckpoint>(input.key);
            if (missing !== null) return missing;

            const invalidHandoff = invalidHandoffAdmission(input);
            if (invalidHandoff !== null) return invalidHandoff;

            // Release the gate before inserting: the partial unique index
            // permits one active operation, so the superseding link has to land
            // first.
            setSupersededByStmt.run({
              id: target.id,
              superseded_by: input.requestId,
              updated_at: input.requestedAt,
            });
            const operation = insertAdmitted(input, target.id);
            logger.info("conversation-checkpoints.recovery_admitted", {
              ...operationLogFields(input.key, operation.id),
              ordinal: operation.ordinal,
              recoversOperationId: target.id,
            });
            return ok({ outcome: "admitted", operation });
          })
          .immediate(),
      );
    },

    async freezePayload(input) {
      return writeQueue.withWriteQueueSync("checkpoint.freezePayload", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const operation = findScoped(input.key, input.operationId);
            if (operation === null) {
              return refuse(
                "checkpoint_not_found",
                "no such checkpoint operation in this scope",
                null,
              );
            }
            if (
              operation.payloadId !== null &&
              operation.supersededByOperationId === null
            ) {
              const saved = findPayloadStmt.get({
                ...scopeBind(input.key),
                id: operation.id,
              });
              const decision =
                operation.handoff?.stage === "included"
                  ? "included"
                  : operation.handoff?.omissionReason === "seed_budget"
                    ? "seed_budget"
                    : undefined;
              if (
                saved !== undefined &&
                isDeepStrictEqual(rowToPayload(saved), input.payload) &&
                input.handoffDecision === decision
              )
                return ok(operation);
            }
            const transition = validateCheckpointTransition({
              from: operation.phase,
              to: "retiring",
            });
            if (!transition.legal) {
              return refuse("illegal_transition", transition.reason, operation);
            }
            if (input.payload.id !== operation.id) {
              return refuse(
                "invalid_payload",
                "the payload id does not name this operation",
                operation,
              );
            }
            if (
              input.payload.sourceBasis.capturedThroughSeq !==
                operation.sourceBasis.capturedThroughSeq ||
              input.payload.sourceBasis.sourceHash !==
                operation.sourceBasis.sourceHash
            ) {
              return refuse(
                "source_basis_mismatch",
                "the payload was built over a different captured source",
                operation,
              );
            }
            const parsed = checkpointPayloadSchema.safeParse(input.payload);
            if (!parsed.success || !checkpointSeedBytesAgree(input.payload)) {
              return refuse(
                "invalid_payload",
                "the payload failed validation or its declared byte total does not match its seed",
                operation,
              );
            }
            const capture = operation.handoff;
            let frozenHandoff = capture;
            if (capture !== null) {
              if (
                !capture.executionSettled ||
                !capture.auditDurable ||
                capture.finalSourceBasis === null ||
                (capture.stage !== "captured" && capture.stage !== "omitted")
              )
                return refuse(
                  "invalid_handoff",
                  "capture must settle before payload freeze",
                  operation,
                );
              if (capture.stopIntent === "cancel")
                return refuse(
                  "invalid_handoff",
                  "checkpoint cancellation prevents payload freeze",
                  operation,
                );
              if (capture.stage === "captured") {
                if (input.handoffDecision === undefined)
                  return refuse(
                    "invalid_handoff",
                    "captured output requires an explicit final inclusion decision",
                    operation,
                  );
                frozenHandoff = checkpointHandoffSchema.parse({
                  ...capture,
                  ...discardHandoffCandidate(capture),
                  stage:
                    input.handoffDecision === "included"
                      ? "included"
                      : "omitted",
                  omissionReason:
                    input.handoffDecision === "included" ? null : "seed_budget",
                  finalizedAt: input.at,
                });
              } else {
                if (input.handoffDecision !== undefined)
                  return refuse(
                    "invalid_handoff",
                    "an omitted capture cannot be included or reclassified",
                    operation,
                  );
                frozenHandoff = checkpointHandoffSchema.parse({
                  ...capture,
                  ...discardHandoffCandidate(capture),
                  finalizedAt: input.at,
                });
              }
            } else if (input.handoffDecision !== undefined)
              return refuse(
                "invalid_handoff",
                "capture was not requested",
                operation,
              );
            const workingState = input.payload.sections.workingState;
            const hasHandoff =
              typeof workingState === "object" &&
              workingState !== null &&
              "agentHandoff" in workingState &&
              workingState.agentHandoff != null;
            if (hasHandoff !== (frozenHandoff?.stage === "included"))
              return refuse(
                "invalid_handoff",
                "payload handoff presence disagrees with its inclusion outcome",
                operation,
              );
            const fenced = input.fence?.(continuation.find(input.key)) ?? null;
            if (fenced !== null) {
              return refuse("fence_refused", fenced.message, operation);
            }

            const payload = parsed.data;
            insertPayload(payload);
            freezeOperationStmt.run({
              id: operation.id,
              handoff_json:
                frozenHandoff === null ? null : JSON.stringify(frozenHandoff),
              generation_pass_count: payload.generationPassCount,
              usage_input_tokens: input.usage?.inputTokens ?? null,
              usage_cached_input_tokens: input.usage?.cachedInputTokens ?? null,
              usage_output_tokens: input.usage?.outputTokens ?? null,
              usage_cost_usd: input.usage?.costUsd ?? null,
              usage_duration_ms: input.usage?.durationMs ?? null,
              updated_at: input.at,
            });
            logger.info("conversation-checkpoints.payload_frozen", {
              ...operationLogFields(input.key, operation.id),
              seedBytes: payload.sectionBytes.total,
              seedSha256: payload.seedSha256,
              generationPassCount: payload.generationPassCount,
            });
            return ok(reload(operation.id));
          })
          .immediate(),
      );
    },

    async commitReady(input) {
      return writeQueue.withWriteQueueSync("checkpoint.commitReady", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const operation = findScoped(input.key, input.operationId);
            if (operation === null) {
              return refuse(
                "checkpoint_not_found",
                "no such checkpoint operation in this scope",
                null,
              );
            }
            const transition = validateCheckpointTransition({
              from: operation.phase,
              to: "ready",
            });
            // Readiness is reachable from `retiring`, and from a reconciliation
            // that interrupted exactly that retirement: `checkpoint reconcile`
            // retries the deterministic close and persistence work, and
            // repairing it means finishing the same clear-and-commit here. A
            // reconciliation that interrupted anything else did not leave a
            // retirement unfinished, so it has no repair to complete.
            const repairsRetirement =
              operation.phase === "needs_reconciliation" &&
              operation.lastStablePhase === "retiring";
            if (
              !transition.legal ||
              (operation.phase !== "retiring" && !repairsRetirement)
            ) {
              return refuse(
                "illegal_transition",
                `checkpoint readiness requires a retiring or retirement-blocked operation; ${operation.id} is ${operation.phase}`,
                operation,
              );
            }
            const superseded =
              supersededRefusal<CheckpointOperation>(operation);
            if (superseded !== null) return superseded;
            // Clear first, and refuse before any checkpoint write if the
            // conversation is not there: a `ready` operation whose target still
            // names a live backend session describes a retirement that did not
            // happen, and the next ordinary turn would resume the very runtime
            // this checkpoint replaces. Both writes share this transaction, so
            // there is no window in which one holds without the other. The
            // clear is idempotent — an already-null column still matches its
            // row — so a replay after an interrupted retirement completes.
            if (!continuation.clearBackendRef(input.key)) {
              return refuse(
                "target_conversation_missing",
                "the conversation this operation retires does not exist in this scope",
                operation,
              );
            }
            setPhaseStmt.run({
              id: operation.id,
              phase: "ready",
              expected_phase: operation.phase,
              last_stable_phase: nextLastStablePhase(operation, "ready"),
              updated_at: input.at,
            });
            logger.info("conversation-checkpoints.ready", {
              ...operationLogFields(input.key, operation.id),
            });
            return ok(reload(operation.id));
          })
          .immediate(),
      );
    },

    async beginDelivery(input) {
      return writeQueue.withWriteQueueSync("checkpoint.beginDelivery", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const operation = findScoped(input.key, input.operationId);
            if (operation === null) {
              return refuse(
                "checkpoint_not_found",
                "no such checkpoint operation in this scope",
                null,
              );
            }
            const transition = validateCheckpointTransition({
              from: operation.phase,
              to: "delivering",
            });
            if (!transition.legal) {
              return refuse("illegal_transition", transition.reason, operation);
            }
            if (operation.payloadId === null) {
              return refuse(
                "invalid_payload",
                "the operation has no frozen payload to deliver",
                operation,
              );
            }
            beginDeliveryStmt.run({
              id: operation.id,
              expected_phase: operation.phase,
              attempt_id: input.binding.attemptId,
              input_fingerprint: input.binding.inputFingerprint,
              submitted_input_fingerprint:
                input.binding.submittedInputFingerprint,
              queued_attempt_id: input.binding.queuedAttemptId,
              queued_message_id: input.binding.queuedMessageId,
              updated_at: input.at,
            });
            logger.info("conversation-checkpoints.delivery_bound", {
              ...operationLogFields(input.key, operation.id),
              attemptId: input.binding.attemptId,
            });
            return ok(reload(operation.id));
          })
          .immediate(),
      );
    },

    async recordAcceptance(input) {
      return writeQueue.withWriteQueueSync("checkpoint.recordAcceptance", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const operation = findScoped(input.key, input.operationId);
            if (operation === null) {
              return refuse(
                "checkpoint_not_found",
                "no such checkpoint operation in this scope",
                null,
              );
            }

            const superseded =
              supersededRefusal<CheckpointOperation>(operation);
            if (superseded !== null) return superseded;

            // Acceptance is recorded once. An operation that already carries it
            // and has since left `applied` lost its accepted continuation, and
            // R8 requires a fresh recovery checkpoint covering the history
            // since — replaying the old evidence here would silently reopen the
            // recovery gate and hand back continuity that no longer exists.
            if (
              operation.acceptance !== null &&
              operation.phase !== "applied"
            ) {
              return refuse(
                "stale_operation",
                `acceptance is already recorded; the operation is ${operation.phase} and needs a fresh recovery checkpoint`,
                operation,
              );
            }

            const evidenceMatches =
              operation.delivery?.attemptId === input.acceptance.attemptId;
            if (operation.phase === "applied") {
              // A retried receipt write is idempotent only when it repeats the
              // SAME evidence; different evidence would silently rewrite which
              // attempt this seed was accepted by.
              const identical =
                operation.acceptance !== null &&
                operation.acceptance.attemptId === input.acceptance.attemptId &&
                operation.acceptance.seedHash === input.acceptance.seedHash &&
                operation.acceptance.acceptedAt ===
                  input.acceptance.acceptedAt &&
                operation.protectedReferences.acceptedBackendRef ===
                  input.acceptedBackendRef;
              return identical
                ? ok(operation)
                : refuse(
                    "attempt_mismatch",
                    "this operation is already applied under different acceptance evidence",
                    operation,
                  );
            }

            const transition = validateCheckpointTransition({
              from: operation.phase,
              to: "applied",
            });
            if (!transition.legal) {
              return refuse("illegal_transition", transition.reason, operation);
            }
            if (!evidenceMatches) {
              return refuse(
                "attempt_mismatch",
                "acceptance evidence names a different attempt than the bound delivery",
                operation,
              );
            }

            const payloadRaw: unknown = findPayloadReceiptStmt.get(
              operation.id,
            );
            if (payloadRaw === undefined) {
              return refuse(
                "invalid_payload",
                "the operation has no frozen payload to accept",
                operation,
              );
            }
            if (
              rowToPayloadReceipt(payloadRaw).seedSha256 !==
              input.acceptance.seedHash
            ) {
              return refuse(
                "attempt_mismatch",
                "acceptance evidence names a different seed than the frozen payload",
                operation,
              );
            }

            const accepted = recordAcceptanceStmt.run({
              id: operation.id,
              expected_phase: operation.phase,
              attempt_id: input.acceptance.attemptId,
              seed_hash: input.acceptance.seedHash,
              accepted_at: input.acceptance.acceptedAt,
              accepted_backend_ref: input.acceptedBackendRef,
            });
            if (accepted.changes !== 1) {
              return refuse(
                "stale_operation",
                "the operation changed beneath this acceptance write",
                operation,
              );
            }
            logger.info("conversation-checkpoints.applied", {
              ...operationLogFields(input.key, operation.id),
              attemptId: input.acceptance.attemptId,
              seedHash: input.acceptance.seedHash,
            });
            return ok(reload(operation.id));
          })
          .immediate(),
      );
    },

    async recordOutcome(input) {
      return writeQueue.withWriteQueueSync("checkpoint.recordOutcome", () =>
        db
          .transaction((): CheckpointResult<CheckpointOperation> => {
            const operation = findScoped(input.key, input.operationId);
            if (operation === null) {
              return refuse(
                "checkpoint_not_found",
                "no such checkpoint operation in this scope",
                null,
              );
            }
            if (operation.phase !== input.expectedPhase) {
              return refuse(
                "stale_operation",
                `expected phase ${input.expectedPhase}, but the operation is ${operation.phase}`,
                operation,
              );
            }
            const superseded =
              supersededRefusal<CheckpointOperation>(operation);
            if (superseded !== null) return superseded;

            if (input.captureObservation !== undefined) {
              const handoff = operation.handoff;
              if (
                input.captureCleanupObserved !== undefined ||
                input.captureExecutionStopAttestation !== undefined ||
                operation.phase !== "building" ||
                input.phase !== "needs_reconciliation" ||
                input.failure?.code !== "capture_cleanup_unverified" ||
                operation.payloadId !== null ||
                handoff === null ||
                handoff.captureId !== input.captureObservation.captureId ||
                handoff.executionSettled ||
                (handoff.stage !== "running" && handoff.stage !== "settling")
              )
                return refuse(
                  "invalid_handoff",
                  "capture observations require the matching unsettled capture cleanup hold",
                  operation,
                );
            }

            if (input.captureCleanupObserved !== undefined) {
              const handoff = operation.handoff;
              if (
                input.captureExecutionStopAttestation !== undefined ||
                operation.phase !== "needs_reconciliation" ||
                input.phase !== "needs_reconciliation" ||
                operation.lastStablePhase !== "building" ||
                operation.payloadId !== null ||
                handoff === null ||
                handoff.captureId !== input.captureCleanupObserved.captureId ||
                handoff.stage !== "omitted" ||
                handoff.executionStopAttestation !== null ||
                (handoff.omissionReason !== "interrupted" &&
                  handoff.omissionReason !== "cleanup_unverified")
              )
                return refuse(
                  "invalid_handoff",
                  "observed cleanup applies only to the matching capture cleanup hold",
                  operation,
                );
              if (
                handoff.executionSettled &&
                handoff.auditDurable &&
                handoff.continuationDisposition === "clear" &&
                handoff.candidate === null &&
                handoff.settledAt !== null
              )
                return ok(operation);
              const settled = checkpointHandoffSchema.parse({
                ...handoff,
                executionSettled: true,
                auditDurable: true,
                ...discardHandoffCandidate(handoff),
                continuationDisposition: "clear",
                settledAt: handoff.settledAt ?? input.at,
              });
              db.prepare(
                "UPDATE conversation_checkpoint_operations SET handoff_json = ?, updated_at = ? WHERE id = ? AND phase = 'needs_reconciliation'",
              ).run(JSON.stringify(settled), input.at, operation.id);
              logger.info("checkpoint.capture.cleanup_observed", {
                ...operationLogFields(input.key, operation.id),
                captureId: handoff.captureId,
              });
              return ok(reload(operation.id));
            }

            if (input.captureExecutionStopAttestation !== undefined) {
              const handoff = operation.handoff;
              const attestation =
                checkpointExecutionStopAttestationSchema.safeParse(
                  input.captureExecutionStopAttestation,
                );
              if (
                !attestation.success ||
                operation.phase !== "needs_reconciliation" ||
                input.phase !== "needs_reconciliation" ||
                operation.lastStablePhase !== "building" ||
                operation.payloadId !== null ||
                handoff === null ||
                handoff.stage !== "omitted" ||
                (handoff.omissionReason !== "interrupted" &&
                  handoff.omissionReason !== "cleanup_unverified")
              )
                return refuse(
                  "invalid_handoff",
                  "execution acknowledgement applies only to a capture cleanup hold",
                  operation,
                );
              if (handoff.executionStopAttestation !== null) {
                if (
                  handoff.executionStopAttestation.source ===
                  attestation.data.source
                )
                  return ok(operation);
                return refuse(
                  "stale_operation",
                  "execution acknowledgement is already durable",
                  operation,
                );
              }
              if (handoff.executionSettled || attestation.data.at !== input.at)
                return refuse(
                  "invalid_handoff",
                  "execution acknowledgement does not match unsettled capture",
                  operation,
                );
              const acknowledged = checkpointHandoffSchema.parse({
                ...handoff,
                executionSettled: true,
                executionStopAttestation: attestation.data,
                continuationDisposition: "clear",
                omissionReason: "interrupted",
                finalizedAt: input.at,
              });
              db.prepare(
                "UPDATE conversation_checkpoint_operations SET handoff_json = ?, updated_at = ? WHERE id = ? AND phase = 'needs_reconciliation'",
              ).run(JSON.stringify(acknowledged), input.at, operation.id);
              logger.info("checkpoint.capture.execution_stop_attested", {
                ...operationLogFields(input.key, operation.id),
                captureId: handoff.captureId,
                source: attestation.data.source,
              });
              return ok(reload(operation.id));
            }
            const settledContinuationLost =
              operation.handoff !== null &&
              (operation.handoff.stage === "captured" ||
                operation.handoff.stage === "omitted") &&
              operation.handoff.executionSettled &&
              operation.handoff.auditDurable &&
              operation.handoff.continuationDisposition === "clear" &&
              operation.protectedReferences.priorBackendRef !== null &&
              (input.failure?.code === "capture_continuation_lost" ||
                input.failure?.code === "cancelled" ||
                input.failure?.code === "interrupted");
            if (
              operation.phase === "building" &&
              input.phase === "needs_reconciliation" &&
              !settledContinuationLost &&
              (operation.handoff === null ||
                operation.handoff.stage === "pending" ||
                operation.handoff.executionSettled ||
                (input.failure?.code !== "capture_interrupted" &&
                  input.failure?.code !== "capture_cleanup_unverified"))
            )
              return refuse(
                "illegal_transition",
                "building reconciliation requires unverified capture execution or settled loss of prior continuity",
                operation,
              );

            // An outcome reports work that finished; it carries no payload, no
            // reference clear, no attempt binding and no acceptance receipt. An
            // edge whose meaning IS one of those belongs to the method that
            // supplies it, however legal the edge is for the lifecycle.
            const edge = validateCheckpointOutcomeEdge({
              from: operation.phase,
              to: input.phase,
            });
            if (!edge.owned) {
              return refuse("illegal_transition", edge.reason, operation);
            }
            const transition = validateCheckpointTransition({
              from: operation.phase,
              to: input.phase,
            });
            if (!transition.legal) {
              return refuse("illegal_transition", transition.reason, operation);
            }

            // Leaving `needs_reconciliation` for `ready` says the seed may be
            // delivered again, so it needs the evidence for the block it
            // claims to repair.
            if (operation.phase === "needs_reconciliation") {
              if (
                operation.acceptance !== null ||
                operation.lastStablePhase === "applied"
              ) {
                // R8/D5: a lost applied continuation keeps its accepted
                // provenance and needs a fresh recovery checkpoint covering the
                // history since. Handing this seed back would let a delivery
                // bind it again and omit every turn the accepted runtime took.
                return refuse(
                  "stale_operation",
                  "this operation was applied and needs a fresh recovery checkpoint, not its old seed returned to ready",
                  operation,
                );
              }
              // Only a block that landed after retirement completed is
              // repaired by declaring the seed ready again; those two phases
              // are also the ones that carry a frozen payload to be ready with.
              if (
                operation.lastStablePhase !== "ready" &&
                operation.lastStablePhase !== "delivering"
              ) {
                return refuse(
                  "illegal_transition",
                  "readiness follows this reconciliation only once retirement completed; an interrupted retirement is repaired through commitReady, which clears the retired reference",
                  operation,
                );
              }
            }

            // Phase is a slot a later attempt re-enters, so an outcome about a
            // delivery has to name that delivery — both while it is delivering
            // and while its reconciliation holds it. Without this, attempt A's
            // late outcome lands on attempt B's work.
            const ownsBlockedDelivery =
              operation.phase === "delivering" ||
              (operation.phase === "needs_reconciliation" &&
                operation.lastStablePhase === "delivering");
            if (ownsBlockedDelivery) {
              if (input.attemptId === undefined) {
                return refuse(
                  "attempt_mismatch",
                  "an outcome for a delivery must name the attempt bound to it",
                  operation,
                );
              }
              if (operation.delivery?.attemptId !== input.attemptId) {
                return refuse(
                  "attempt_mismatch",
                  "the outcome names a different attempt than the bound delivery",
                  operation,
                );
              }
            } else if (
              input.attemptId !== undefined &&
              operation.delivery !== null &&
              operation.delivery.attemptId !== input.attemptId
            ) {
              // A phase that does not own a delivery still must not accept an
              // outcome from an attempt this operation never bound.
              return refuse(
                "attempt_mismatch",
                "the outcome names an attempt this operation never bound",
                operation,
              );
            }

            let handoff = operation.handoff;
            if (
              handoff !== null &&
              operation.phase === "building" &&
              input.phase === "needs_reconciliation"
            ) {
              handoff = checkpointHandoffSchema.parse({
                ...handoff,
                ...(input.captureObservation
                  ? {
                      modeEstablished: input.captureObservation.modeEstablished,
                      submitted: input.captureObservation.submitted,
                      correlatedCompletion:
                        input.captureObservation.correlatedCompletion,
                      activity: input.captureObservation.activity,
                      usage: input.captureObservation.usage,
                      continuationDisposition:
                        input.captureObservation.continuationDisposition,
                    }
                  : {}),
                stage: "omitted",
                omissionReason: settledContinuationLost
                  ? (handoff.omissionReason ??
                    (input.failure?.code === "interrupted" ||
                    input.failure?.code === "cancelled"
                      ? input.failure.code
                      : "checkpoint_failed"))
                  : input.failure?.code === "capture_interrupted"
                    ? "interrupted"
                    : "cleanup_unverified",
                ...(settledContinuationLost
                  ? discardHandoffCandidate(handoff)
                  : {}),
                finalizedAt: input.at,
              });
            }
            if (
              handoff !== null &&
              (input.phase === "failed" || input.phase === "cancelled")
            ) {
              if (!handoff.executionSettled && handoff.stage !== "pending")
                return refuse(
                  "invalid_handoff",
                  "unsettled capture must retain reconciliation ownership",
                  operation,
                );
              if (handoff.stage === "captured" || handoff.stage === "pending") {
                const reason =
                  input.phase === "cancelled"
                    ? "cancelled"
                    : input.failure?.code === "interrupted"
                      ? "interrupted"
                      : "checkpoint_failed";
                handoff = checkpointHandoffSchema.parse({
                  ...handoff,
                  stage: "omitted",
                  omissionReason: reason,
                  ...discardHandoffCandidate(handoff),
                  finalizedAt: input.at,
                });
              }
            }
            const written = recordOutcomeStmt.run({
              id: operation.id,
              handoff_json: handoff === null ? null : JSON.stringify(handoff),
              expected_phase: input.expectedPhase,
              // Bound only where there is a delivery to correlate against, so
              // this CAS backstop states exactly the rule the guard above
              // enforces: an operation that never bound an attempt is not
              // attempt-scoped, and a caller that passes one anyway must not be
              // refused for a binding that does not exist.
              expected_attempt_id:
                operation.delivery === null ? null : (input.attemptId ?? null),
              phase: input.phase,
              last_stable_phase: nextLastStablePhase(operation, input.phase),
              failure_code: input.failure?.code ?? null,
              failure_message: input.failure?.message ?? null,
              generation_pass_count: input.generationPassCount ?? null,
              usage_input_tokens: input.usage?.inputTokens ?? null,
              usage_cached_input_tokens: input.usage?.cachedInputTokens ?? null,
              usage_output_tokens: input.usage?.outputTokens ?? null,
              usage_cost_usd: input.usage?.costUsd ?? null,
              usage_duration_ms: input.usage?.durationMs ?? null,
              updated_at: input.at,
            });
            if (written.changes !== 1) {
              return refuse(
                "stale_operation",
                "the operation changed beneath this outcome write",
                operation,
              );
            }

            // A recovery build that ends without producing a checkpoint hands
            // the conversation back to the operation it superseded, rather than
            // releasing the queue into uncertain continuity.
            if (
              operation.recoversOperationId !== null &&
              (input.phase === "failed" || input.phase === "cancelled")
            ) {
              setSupersededByStmt.run({
                id: operation.recoversOperationId,
                superseded_by: null,
                updated_at: input.at,
              });
              logger.info("conversation-checkpoints.recovery_gate_restored", {
                ...operationLogFields(input.key, operation.id),
                restoredOperationId: operation.recoversOperationId,
              });
            }

            logger.info("conversation-checkpoints.outcome_recorded", {
              ...operationLogFields(input.key, operation.id),
              fromPhase: operation.phase,
              toPhase: input.phase,
              ...(input.failure === undefined
                ? {}
                : { errorCode: input.failure.code }),
            });
            return ok(reload(operation.id));
          })
          .immediate(),
      );
    },

    async getStateForAdmission(key) {
      const active = findActive(key);
      const acceptedRaw: unknown = findLatestAcceptedStmt.get(scopeBind(key));
      if (acceptedRaw === undefined) {
        return { active, latestAccepted: null };
      }
      const accepted = rowToOperation(acceptedRaw);
      if (
        accepted.acceptance === null ||
        accepted.protectedReferences.acceptedBackendRef === null
      ) {
        return { active, latestAccepted: null };
      }
      return {
        active,
        latestAccepted: {
          operationId: accepted.id,
          ordinal: accepted.ordinal,
          currentPhase: accepted.phase,
          acceptance: accepted.acceptance,
          acceptedBackendRef: accepted.protectedReferences.acceptedBackendRef,
        },
      };
    },

    async getOperation(key, operationId) {
      return findScoped(key, operationId);
    },

    async getReceipt(key, operationId) {
      const operation = findScoped(key, operationId);
      if (operation === null) return null;
      const payloadRaw: unknown = findPayloadReceiptStmt.get(operation.id);
      return checkpointReceipt(
        operation,
        payloadRaw === undefined ? null : rowToPayloadReceipt(payloadRaw),
        continuation.find(key)?.checkpointFork,
      );
    },

    async getPayload(key, operationId) {
      const raw: unknown = findPayloadStmt.get({
        ...scopeBind(key),
        id: operationId,
      });
      return raw === undefined ? null : rowToPayload(raw);
    },

    async listReceipts(key, options) {
      const limit = Math.min(
        Math.max(options?.limit ?? DEFAULT_CHECKPOINT_LIST_LIMIT, 1),
        MAX_CHECKPOINT_LIST_LIMIT,
      );
      const rows = listOperationsStmt.all({
        ...scopeBind(key),
        before: options?.before ?? Number.MAX_SAFE_INTEGER,
        // One extra row answers "is there another page" without a second count.
        limit: limit + 1,
      }) as unknown[];
      const page = rows.slice(0, limit).map(rowToOperation);
      const receipts = page.map((operation) => {
        const payloadRaw: unknown = findPayloadReceiptStmt.get(operation.id);
        return checkpointReceipt(
          operation,
          payloadRaw === undefined ? null : rowToPayloadReceipt(payloadRaw),
          continuation.find(key)?.checkpointFork,
        );
      });
      const last = page.at(-1);
      return {
        receipts,
        nextBefore:
          rows.length > limit && last !== undefined ? last.ordinal : null,
      };
    },
  };
}
