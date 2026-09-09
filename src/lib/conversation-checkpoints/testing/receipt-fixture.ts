/**
 * A valid `CheckpointReceipt` for tests and stories.
 *
 * Built through the domain schema rather than as a loose literal so a fixture
 * cannot drift from the projection the server actually sends: a field added to
 * the receipt fails here before it fails a component.
 */

import { checkpointReceiptSchema, type CheckpointReceipt } from "../receipt";
import type { CheckpointPhase } from "../schemas";

export interface CheckpointReceiptOverrides {
  operationId?: string;
  scope?: "session" | "project";
  conversationId?: string;
  ordinal?: number;
  phase?: CheckpointPhase;
  lastStablePhase?: CheckpointPhase | null;
  capturedThroughSeq?: number;
  /** Set to null for an operation that froze no payload (a failed build). */
  frozen?: boolean;
  omissions?: { category: string; detail: string }[];
  failure?: { code: string; message: string } | null;
  delivery?: CheckpointReceipt["delivery"];
  acceptance?: CheckpointReceipt["acceptance"];
  hasAcceptedContinuation?: boolean;
  recoversOperationId?: string | null;
  supersededByOperationId?: string | null;
  /** Freshness stamp; the cache fold orders competing writes by it. */
  updatedAt?: string;
}

export function checkpointReceiptFixture(
  overrides: CheckpointReceiptOverrides = {},
): CheckpointReceipt {
  const operationId = overrides.operationId ?? "op-1";
  const frozen = overrides.frozen ?? true;
  // The projection derives `hasAcceptedContinuation` from the accepted
  // backend reference it records together with the acceptance, so an accepted
  // operation always carries its delivery binding and its acceptance too. A
  // fixture that set the flag alone would describe a receipt no server can
  // send, and a surface reading the other two fields would render nonsense.
  const accepted = overrides.hasAcceptedContinuation ?? false;
  const delivery =
    overrides.delivery ??
    (accepted
      ? {
          attemptId: `${operationId}-attempt`,
          inputFingerprint: "fp-in",
          submittedInputFingerprint: "fp-sub",
          queuedAttemptId: null,
          queuedMessageId: null,
        }
      : null);
  const acceptance =
    overrides.acceptance ??
    (accepted
      ? {
          attemptId: delivery?.attemptId ?? `${operationId}-attempt`,
          seedHash: "seed-hash",
          acceptedAt: "2026-09-01T00:05:00.000Z",
        }
      : null);
  return checkpointReceiptSchema.parse({
    operationId,
    mechanism: "cc_checkpoint",
    scope: overrides.scope ?? "session",
    conversationId: overrides.conversationId ?? "conv-1",
    ordinal: overrides.ordinal ?? 1,
    phase: overrides.phase ?? "ready",
    lastStablePhase: overrides.lastStablePhase ?? null,
    boundary: {
      capturedThroughSeq: overrides.capturedThroughSeq ?? 148,
      sourceHash: "source-hash",
    },
    checkpoint: frozen
      ? {
          checkpointId: operationId,
          schemaVersion: 1,
          seedSha256: "seed-hash",
          sectionBytes: {
            total: 18234,
            workingState: 12000,
            recentDialogue: 5000,
            recoveryFraming: 1234,
          },
          omissions: overrides.omissions ?? [],
          versions: {
            generatorVersion: "g1",
            builderVersion: "b1",
            normalizerVersion: "n1",
          },
          artifactProvenance: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        }
      : null,
    delivery,
    acceptance,
    hasAcceptedContinuation: accepted,
    failure: overrides.failure ?? null,
    recoversOperationId: overrides.recoversOperationId ?? null,
    supersededByOperationId: overrides.supersededByOperationId ?? null,
    generationPassCount: 2,
    compactionUsage: {
      inputTokens: 1200,
      cachedInputTokens: null,
      outputTokens: 340,
      costUsd: null,
      durationMs: 4200,
    },
    seedTokenEstimate: null,
    contextOccupancy: null,
    requestedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-01T00:01:00.000Z",
  });
}
