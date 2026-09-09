import { z } from "zod";

import {
  CHECKPOINT_MECHANISM,
  checkpointAcceptanceSchema,
  checkpointArtifactProvenanceSchema,
  checkpointContextOccupancySchema,
  checkpointDeliveryBindingSchema,
  checkpointFailureSchema,
  checkpointGeneratorVersionsSchema,
  checkpointOmissionSchema,
  checkpointPhaseSchema,
  checkpointScopeSchema,
  checkpointSectionBytesSchema,
  checkpointSourceBasisSchema,
  checkpointTokenEstimateSchema,
  checkpointUsageSchema,
  type CheckpointOperation,
} from "./schemas";

export const checkpointPayloadReceiptSchema = z.object({
  checkpointId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  seedSha256: z.string().min(1),
  sectionBytes: checkpointSectionBytesSchema,
  omissions: z.array(checkpointOmissionSchema),
  versions: checkpointGeneratorVersionsSchema,
  artifactProvenance: checkpointArtifactProvenanceSchema.nullable(),
  createdAt: z.string().min(1),
});
export type CheckpointPayloadReceipt = z.infer<
  typeof checkpointPayloadReceiptSchema
>;

export const checkpointReceiptSchema = z.object({
  operationId: z.string().min(1),
  mechanism: z.literal("cc_checkpoint"),
  scope: checkpointScopeSchema,
  conversationId: z.string().min(1),
  ordinal: z.number().int().positive(),
  phase: checkpointPhaseSchema,
  lastStablePhase: checkpointPhaseSchema.nullable(),
  boundary: checkpointSourceBasisSchema,
  checkpoint: checkpointPayloadReceiptSchema.nullable(),
  delivery: checkpointDeliveryBindingSchema.nullable(),
  acceptance: checkpointAcceptanceSchema.nullable(),
  hasAcceptedContinuation: z.boolean(),
  failure: checkpointFailureSchema.nullable(),
  recoversOperationId: z.string().min(1).nullable(),
  supersededByOperationId: z.string().min(1).nullable(),
  /**
   * Model calls this checkpoint made: envelope folds, repairs, and the final
   * working-state pass. Null until generation reports. It counts compaction
   * work, never the conversation's ordinary turns.
   */
  generationPassCount: z.number().int().nonnegative().nullable(),
  /**
   * Measured cost of those compaction passes and nothing else. Named for what
   * it measures so no reader can take it for the conversation's turn usage or
   * its cumulative totals, neither of which a checkpoint receipt reports.
   */
  compactionUsage: checkpointUsageSchema,
  /** A labeled token estimate of the frozen seed, or null when none exists. */
  seedTokenEstimate: checkpointTokenEstimateSchema.nullable(),
  /** Backend-reported context occupancy, or null when it is not available. */
  contextOccupancy: checkpointContextOccupancySchema.nullable(),
  requestedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type CheckpointReceipt = z.infer<typeof checkpointReceiptSchema>;

/**
 * Project one operation into its public receipt.
 *
 * This is the only construction of a `CheckpointReceipt`, and it takes the
 * protected references OUT rather than choosing not to put them in: the
 * operation is destructured field by field, so a reference added to the
 * operation later cannot ride into a receipt by being spread. What a caller
 * learns about continuity is `hasAcceptedContinuation` plus the seed hash —
 * enough to tell an applied checkpoint from a ready one, and never enough to
 * resume a provider session.
 *
 * The filesystem project path is left out for the same reason: a receipt
 * crosses to SSE clients and log-adjacent surfaces, and the addressed
 * conversation is already named by the target the caller used to ask.
 *
 * Every number here is measured or explicitly unavailable. Byte counts are the
 * exact frozen lengths; token and occupancy figures are null because nothing
 * measured them; usage covers the operation's own compaction passes and is
 * named `compactionUsage` so it cannot be read as turn or cumulative usage. No
 * savings percentage, cache-preservation claim, or derived occupancy is
 * computed from them.
 */
export function checkpointReceipt(
  operation: CheckpointOperation,
  payload: CheckpointPayloadReceipt | null,
): CheckpointReceipt {
  return {
    operationId: operation.id,
    mechanism: CHECKPOINT_MECHANISM,
    scope: operation.scope,
    conversationId: operation.conversationId,
    ordinal: operation.ordinal,
    phase: operation.phase,
    lastStablePhase: operation.lastStablePhase,
    boundary: operation.sourceBasis,
    checkpoint: payload,
    delivery: operation.delivery,
    acceptance: operation.acceptance,
    hasAcceptedContinuation:
      operation.protectedReferences.acceptedBackendRef !== null,
    failure: operation.failure,
    recoversOperationId: operation.recoversOperationId,
    supersededByOperationId: operation.supersededByOperationId,
    generationPassCount: operation.generationPassCount,
    compactionUsage: operation.usage,
    // Both null by construction, and deliberately present rather than omitted:
    // the exact `sectionBytes` beside them is the only size CC can state, and a
    // reader who found no token or occupancy field at all would be left to
    // derive one. Nothing measures either today — CC ships no seed tokenizer,
    // and the only window counters an operation sees belong to its ephemeral
    // compaction lane rather than to the conversation being retired.
    seedTokenEstimate: null,
    contextOccupancy: null,
    requestedAt: operation.requestedAt,
    updatedAt: operation.updatedAt,
  };
}

/**
 * Whether an incoming receipt may overwrite the one already cached.
 *
 * Three writers race for the same row — a mutation response, the SSE frame it
 * caused, and an outstanding GET — and any of them can carry the OLDER truth:
 * a `building` admission reply, or a list read started before the event,
 * landing after the `ready` that followed. Arrival order therefore cannot
 * decide the winner; the receipt's own `updatedAt` does. An equal stamp still
 * writes, so a re-published identical receipt stays idempotent rather than
 * being dropped.
 */
export function receiptSupersedes(
  incoming: CheckpointReceipt,
  cached: CheckpointReceipt,
): boolean {
  return incoming.updatedAt >= cached.updatedAt;
}
