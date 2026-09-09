/**
 * Checkpoint persistence vocabulary: the durable operation, the immutable
 * payload, and the scoped identity both are addressed by.
 *
 * A checkpoint operation is the authority for a conversation's checkpoint
 * phase. The actor carries only a small `{operationId, phase}` projection, so
 * every shape here is derived from Zod and read back through the repository
 * rather than reconstructed from a machine snapshot.
 *
 * Scope is storage-keyed (`projectPath` plus a session name that is NULL at
 * project scope) rather than the public `ConversationTarget`: the repository is
 * the storage boundary, and keeping the project sentinel out of the column
 * means no log site or projection has a sentinel-valued session name in scope
 * to leak.
 */

import { z } from "zod";

import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

/** Payload envelope version. Bump when the persisted payload shape changes. */
export const CHECKPOINT_PAYLOAD_SCHEMA_VERSION = 1;

/** The mechanism every checkpoint receipt reports. */
export const CHECKPOINT_MECHANISM = "cc_checkpoint" as const;

export const checkpointScopeSchema = z.enum(["session", "project"]);
export type CheckpointScope = z.infer<typeof checkpointScopeSchema>;

/**
 * The storage identity of one conversation. `sessionName` is `null` at project
 * scope — the discriminated public target is converted to this at the call
 * site, and never the other way round.
 */
export const checkpointScopeKeySchema = z
  .object({
    scope: checkpointScopeSchema,
    projectPath: z.string().min(1),
    sessionName: z.string().min(1).nullable(),
    conversationId: z.string().min(1),
  })
  .strict()
  .refine(
    (key) =>
      key.scope === "session"
        ? key.sessionName !== null
        : key.sessionName === null,
    {
      message:
        "a session-scoped checkpoint carries its session name; a project-scoped one has none",
      path: ["sessionName"],
    },
  );
export type CheckpointScopeKey = z.infer<typeof checkpointScopeKeySchema>;

export const checkpointPhaseSchema = z.enum([
  "building",
  "retiring",
  "ready",
  "delivering",
  "applied",
  "failed",
  "cancelled",
  "needs_reconciliation",
]);
export type CheckpointPhase = z.infer<typeof checkpointPhaseSchema>;

/**
 * Phases that hold the conversation's checkpoint slot. At most one operation
 * per conversation may occupy one of these while it is not superseded — the
 * partial unique index in the DDL is the enforcement, this list is its
 * readable name.
 */
export const ACTIVE_CHECKPOINT_PHASES: readonly CheckpointPhase[] = [
  "building",
  "retiring",
  "ready",
  "delivering",
  "needs_reconciliation",
];

export function isActiveCheckpointPhase(phase: CheckpointPhase): boolean {
  return ACTIVE_CHECKPOINT_PHASES.includes(phase);
}

/**
 * Refusal codes the storage layer itself can produce. Lifecycle refusals that
 * depend on conversation state (`conversation_busy`, `conversation_owned`, …)
 * belong to the admission gate above this layer, not here.
 */
export const checkpointStorageRefusalCodeSchema = z.enum([
  /** A different operation already holds this conversation's checkpoint slot. */
  "checkpoint_pending",
  /** The request UUID exists but addresses a different conversation. */
  "request_id_conflict",
  /** The addressed operation does not exist in the caller's scope. */
  "checkpoint_not_found",
  /** The offered payload is not a valid payload for this operation. */
  "invalid_payload",
  /** The operation moved on before this write; the caller holds stale evidence. */
  "stale_operation",
  /** The transition is not legal from the operation's current phase. */
  "illegal_transition",
  /** The captured source no longer matches the payload being frozen. */
  "source_basis_mismatch",
  /** The caller's freeze fence refused inside the write's critical section. */
  "fence_refused",
  /** Delivery/acceptance evidence does not correlate with the operation. */
  "attempt_mismatch",
  /** Recovery addressed an operation that is not recovery-required. */
  "recovery_target_mismatch",
  /** The conversation this operation retires no longer exists in its scope. */
  "target_conversation_missing",
]);
export type CheckpointStorageRefusalCode = z.infer<
  typeof checkpointStorageRefusalCodeSchema
>;

export const checkpointStorageRefusalSchema = z
  .object({
    code: checkpointStorageRefusalCodeSchema,
    /** Operator-facing reason; never carries seed, source, or provider text. */
    reason: z.string().min(1),
    /** The operation the refusal is about, when one exists. */
    operationId: z.string().min(1).nullable(),
    /** That operation's actual phase, when one exists. */
    phase: checkpointPhaseSchema.nullable(),
  })
  .strict();
export type CheckpointStorageRefusal = z.infer<
  typeof checkpointStorageRefusalSchema
>;

/**
 * Where generation read from. `capturedThroughSeq` is the raw JSONL line
 * boundary; `sourceHash` covers the normalized/redacted input actually supplied
 * to generation, so a later build over the same boundary with different
 * redaction is a different basis.
 */
export const checkpointSourceBasisSchema = z
  .object({
    capturedThroughSeq: z.number().int().nonnegative(),
    sourceHash: z.string().min(1),
  })
  .strict();
export type CheckpointSourceBasis = z.infer<typeof checkpointSourceBasisSchema>;

/**
 * Measured cost of the operation's own model work — its compaction passes, and
 * nothing else. Every field is nullable because a backend that does not report
 * a counter leaves it unavailable — never zero.
 *
 * `cachedInputTokens` is carried separately rather than folded into
 * `inputTokens` because the backends report them separately: summing them would
 * state a fresh-input count the provider never charged, and dropping the cached
 * one would state a total the provider never billed.
 */
export const checkpointUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type CheckpointUsage = z.infer<typeof checkpointUsageSchema>;

export const EMPTY_CHECKPOINT_USAGE: CheckpointUsage = {
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  costUsd: null,
  durationMs: null,
};

/**
 * A token count nobody measured, and the estimator that produced it.
 *
 * The label is required by the shape, so an estimate cannot reach a receipt
 * without naming what produced it — the only way to keep it from being read as
 * a measurement. CC ships no seed tokenizer, so nothing constructs this today;
 * the slot exists so the receipt can say "not estimated" out loud rather than
 * leaving a reader to infer tokens from the exact byte counts beside it.
 */
export const checkpointTokenEstimateSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    /** The estimator, e.g. a tokenizer name and version. Never "approximate". */
    estimator: z.string().min(1),
  })
  .strict();
export type CheckpointTokenEstimate = z.infer<
  typeof checkpointTokenEstimateSchema
>;

/**
 * Context-window occupancy of the checkpointed conversation, as a backend
 * reported it.
 *
 * Null on every checkpoint CC produces today, and that is the honest value: the
 * only usage counters an operation observes come from its own ephemeral
 * compaction lane, which describes that lane's window and not the conversation
 * being retired. Publishing those numbers under this name would be the
 * manufactured occupancy claim design §9 forbids, so the projection reports
 * unavailable instead, and `reportedBy` makes a future value name its source.
 */
export const checkpointContextOccupancySchema = z
  .object({
    usedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
    /** The backend that reported both numbers. */
    reportedBy: z.string().min(1),
  })
  .strict();
export type CheckpointContextOccupancy = z.infer<
  typeof checkpointContextOccupancySchema
>;

/**
 * The provider references CC holds for one operation. Kept in its own shape so
 * that carrying them is always a deliberate act: no receipt, list projection,
 * or log field composes this type.
 */
export const checkpointProtectedReferencesSchema = z
  .object({
    /** The runtime reference retired by this checkpoint. */
    priorBackendRef: z.string().min(1).nullable(),
    /** The fresh reference that accepted the seed. */
    acceptedBackendRef: z.string().min(1).nullable(),
  })
  .strict();
export type CheckpointProtectedReferences = z.infer<
  typeof checkpointProtectedReferencesSchema
>;

/**
 * What binds one delivery attempt to this seed. Persisted before the provider
 * call so a crash cannot leave an attempt that might have been sent
 * indistinguishable from one that never was.
 */
export const checkpointDeliveryBindingSchema = z
  .object({
    attemptId: z.string().min(1),
    /** Fingerprint of the exact assembled input the provider was sent. */
    inputFingerprint: z.string().min(1),
    /**
     * Fingerprint of the input as submitted — prompt text, images and
     * feedback — the one form a queued batch can be reassembled into when a
     * missing queue receipt is repaired from this delivery's acceptance.
     */
    submittedInputFingerprint: z.string().min(1),
    /** Set when the ordinary turn was supplied by a queued message. */
    queuedAttemptId: z.string().min(1).nullable(),
    queuedMessageId: z.string().min(1).nullable(),
  })
  .strict();
export type CheckpointDeliveryBinding = z.infer<
  typeof checkpointDeliveryBindingSchema
>;

/**
 * Acceptance evidence, retained for the life of the operation. Selected by its
 * recorded acceptance rather than by current phase: an operation that later
 * needs recovery keeps the proof that this seed was once applied.
 */
export const checkpointAcceptanceSchema = z
  .object({
    attemptId: z.string().min(1),
    seedHash: z.string().min(1),
    acceptedAt: z.string().min(1),
  })
  .strict();
export type CheckpointAcceptance = z.infer<typeof checkpointAcceptanceSchema>;

export const checkpointFailureSchema = z
  .object({
    code: z.string().min(1),
    /** Operator-facing message; never seed, source, or provider text. */
    message: z.string().min(1),
  })
  .strict();
export type CheckpointFailure = z.infer<typeof checkpointFailureSchema>;

/**
 * One checkpoint operation as the repository stores it. The row is mutable only
 * through the validated transitions in `transitions.ts`; nothing here is written
 * by an actor snapshot.
 */
export const checkpointOperationSchema = registerTrustedSchema(
  z
    .object({
      /** UUID: the caller's request ID, the operation ID, and the payload ID. */
      id: z.string().min(1),
      scope: checkpointScopeSchema,
      projectPath: z.string().min(1),
      sessionName: z.string().min(1).nullable(),
      conversationId: z.string().min(1),
      /** Monotonically increasing within one conversation, starting at 1. */
      ordinal: z.number().int().positive(),
      phase: checkpointPhaseSchema,
      /** The phase held before entering `needs_reconciliation`. */
      lastStablePhase: checkpointPhaseSchema.nullable(),
      sourceBasis: checkpointSourceBasisSchema,
      protectedReferences: checkpointProtectedReferencesSchema,
      /** Set once the immutable payload is durable; equal to `id`. */
      payloadId: z.string().min(1).nullable(),
      delivery: checkpointDeliveryBindingSchema.nullable(),
      acceptance: checkpointAcceptanceSchema.nullable(),
      failure: checkpointFailureSchema.nullable(),
      /** The recovery-required operation this one supersedes. */
      recoversOperationId: z.string().min(1).nullable(),
      /** The recovery operation currently superseding this one, if any. */
      supersededByOperationId: z.string().min(1).nullable(),
      /** Successful, fold, and repair passes; null until generation reports. */
      generationPassCount: z.number().int().nonnegative().nullable(),
      usage: checkpointUsageSchema,
      requestedAt: z.string().min(1),
      updatedAt: z.string().min(1),
    })
    .strict(),
  "conversation-checkpoint-operation",
);
export type CheckpointOperation = z.infer<typeof checkpointOperationSchema>;

/**
 * What the conversation actor carries about a checkpoint.
 *
 * Two fields, `.strict()`, and no builder that takes anything else: the actor's
 * machine snapshot is durable state a restart may reload, and the repository —
 * not a snapshot — is the authority for checkpoint phase. Keeping the seed and
 * the provider references structurally out of this shape is what makes
 * "hydration reads the authority" enforceable rather than advisory.
 */
export const checkpointActorProjectionSchema = z
  .object({
    operationId: z.string().min(1),
    phase: checkpointPhaseSchema,
  })
  .strict();
export type CheckpointActorProjection = z.infer<
  typeof checkpointActorProjectionSchema
>;

export function checkpointActorProjection(
  operation: CheckpointOperation | null,
): CheckpointActorProjection | null {
  if (operation === null) return null;
  return { operationId: operation.id, phase: operation.phase };
}

/**
 * Byte counts for the rendered seed, by section. Exact measurements of the
 * frozen string — never an estimate, and never recomputed after the freeze.
 */
export const checkpointSectionBytesSchema = z
  .object({
    total: z.number().int().nonnegative(),
    workingState: z.number().int().nonnegative(),
    recentDialogue: z.number().int().nonnegative(),
    recoveryFraming: z.number().int().nonnegative(),
  })
  .strict();
export type CheckpointSectionBytes = z.infer<
  typeof checkpointSectionBytesSchema
>;

/**
 * What the builder had to leave out, as categories rather than content. Empty
 * means nothing was dropped, which is a different claim from "not recorded".
 */
export const checkpointOmissionSchema = z
  .object({
    category: z.string().min(1),
    detail: z.string(),
  })
  .strict();
export type CheckpointOmission = z.infer<typeof checkpointOmissionSchema>;

/**
 * Provenance of the reading artifact a build reused, when it reused one. Absent
 * when the checkpoint was generated directly from the captured archive.
 */
export const checkpointArtifactProvenanceSchema = z
  .object({
    artifactId: z.string().min(1),
    artifactSourceHash: z.string().min(1),
  })
  .strict();
export type CheckpointArtifactProvenance = z.infer<
  typeof checkpointArtifactProvenanceSchema
>;

/**
 * The versions that produced this payload. A later build with any different
 * version is a different basis and cannot reuse this envelope.
 */
export const checkpointGeneratorVersionsSchema = z
  .object({
    generatorVersion: z.string().min(1),
    builderVersion: z.string().min(1),
    normalizerVersion: z.string().min(1),
  })
  .strict();
export type CheckpointGeneratorVersions = z.infer<
  typeof checkpointGeneratorVersionsSchema
>;

/**
 * The three rendered sections in their structured form.
 *
 * Typed as JSON rather than as their eventual shapes: the seed builder owns
 * those shapes and validates them before offering a payload for freezing, so
 * restating them here would create a second authority that drifts. `z.json()`
 * is still a real guard — it refuses a value that would not survive the column
 * round trip — while storage's own contract, the envelope of bytes, hash,
 * boundary, provenance, versions, section sizes and omissions, is fully typed
 * above. Readers narrow these with the builder's schemas.
 */
export const checkpointStructuredSectionsSchema = z
  .object({
    workingState: z.json(),
    recentDialogue: z.json(),
    recoveryMap: z.json(),
  })
  .strict();
export type CheckpointStructuredSections = z.infer<
  typeof checkpointStructuredSectionsSchema
>;

/**
 * The immutable checkpoint payload. Inserted exactly once, in the same durable
 * operation that advances `building → retiring`; the DDL carries a BEFORE
 * UPDATE trigger so no code path — here or in a later package — can rewrite a
 * frozen byte.
 */
export const checkpointPayloadSchema = registerTrustedSchema(
  z
    .object({
      /** Equal to the owning operation's id. */
      id: z.string().min(1),
      schemaVersion: z.number().int().positive(),
      sourceBasis: checkpointSourceBasisSchema,
      artifactProvenance: checkpointArtifactProvenanceSchema.nullable(),
      versions: checkpointGeneratorVersionsSchema,
      /** The compaction model that produced the working state. */
      modelSelection: backendModelSelectionSchema,
      sections: checkpointStructuredSectionsSchema,
      /** The exact string injected into the next turn's prompt context. */
      seedText: z.string(),
      seedSha256: z.string().min(1),
      sectionBytes: checkpointSectionBytesSchema,
      omissions: z.array(checkpointOmissionSchema),
      generationPassCount: z.number().int().nonnegative(),
      createdAt: z.string().min(1),
    })
    .strict(),
  "conversation-checkpoint-payload",
);
export type CheckpointPayload = z.infer<typeof checkpointPayloadSchema>;

/**
 * `sectionBytes.total` must be the exact UTF-8 length of the frozen string.
 *
 * Checked by the repository rather than as a schema refinement so that a
 * builder offering an inconsistent payload gets a typed storage refusal it can
 * report, and so the payload schema stays a plain object the durability
 * contract harness can introspect.
 */
export function checkpointSeedBytesAgree(payload: CheckpointPayload): boolean {
  return (
    payload.sectionBytes.total === Buffer.byteLength(payload.seedText, "utf8")
  );
}
