import { describe, expect, it } from "vitest";

import { checkpointReceipt, checkpointReceiptSchema } from "./receipt";
import type { CheckpointPayloadReceipt } from "./receipt";
import {
  CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
  type CheckpointOperation,
} from "./schemas";

const PRIOR_REF = "prior-provider-session-9d3f";
const ACCEPTED_REF = "fresh-provider-session-71ac";

function buildOperation(
  overrides: Partial<CheckpointOperation> = {},
): CheckpointOperation {
  return {
    id: "op-1",
    scope: "session",
    projectPath: "/projects/alpha",
    sessionName: "csm-alpha",
    conversationId: "conv-1",
    ordinal: 3,
    phase: "applied",
    lastStablePhase: "delivering",
    sourceBasis: { capturedThroughSeq: 412, sourceHash: "sha256:source" },
    protectedReferences: {
      priorBackendRef: PRIOR_REF,
      acceptedBackendRef: ACCEPTED_REF,
    },
    payloadId: "op-1",
    delivery: {
      attemptId: "attempt-7",
      inputFingerprint: "sha256:input",
      submittedInputFingerprint: "sha256:input",
      queuedAttemptId: "queued-attempt-2",
      queuedMessageId: "queued-message-2",
    },
    acceptance: {
      attemptId: "attempt-7",
      seedHash: "sha256:seed",
      acceptedAt: "2026-09-07T12:00:00.000Z",
    },
    failure: null,
    recoversOperationId: "op-0",
    supersededByOperationId: null,
    generationPassCount: 2,
    usage: {
      inputTokens: 4096,
      cachedInputTokens: 30_000,
      outputTokens: 512,
      costUsd: 0.42,
      durationMs: 8100,
    },
    requestedAt: "2026-09-07T11:58:00.000Z",
    updatedAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

function buildPayloadReceipt(): CheckpointPayloadReceipt {
  return {
    checkpointId: "op-1",
    schemaVersion: CHECKPOINT_PAYLOAD_SCHEMA_VERSION,
    seedSha256: "sha256:seed",
    sectionBytes: {
      total: 30000,
      workingState: 18000,
      recentDialogue: 9000,
      recoveryFraming: 3000,
    },
    omissions: [{ category: "evidence_map_entries", detail: "3 dropped" }],
    versions: {
      generatorVersion: "gen-2",
      builderVersion: "builder-1",
      normalizerVersion: "norm-4",
    },
    artifactProvenance: {
      artifactId: "artifact-9",
      artifactSourceHash: "sha256:source",
    },
    createdAt: "2026-09-07T11:59:00.000Z",
  };
}

describe("checkpointReceipt", () => {
  it("projects identity, boundary, payload metadata and nullable usage", () => {
    const receipt = checkpointReceipt(buildOperation(), buildPayloadReceipt());

    expect(checkpointReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt).toMatchObject({
      operationId: "op-1",
      mechanism: "cc_checkpoint",
      scope: "session",
      conversationId: "conv-1",
      ordinal: 3,
      phase: "applied",
      lastStablePhase: "delivering",
      boundary: { capturedThroughSeq: 412, sourceHash: "sha256:source" },
      hasAcceptedContinuation: true,
      recoversOperationId: "op-0",
      generationPassCount: 2,
    });
    expect(receipt.checkpoint?.sectionBytes.total).toBe(30000);
    expect(receipt.acceptance?.seedHash).toBe("sha256:seed");
  });

  it("never exposes a protected provider reference anywhere in the receipt", () => {
    const serialized = JSON.stringify(
      checkpointReceipt(buildOperation(), buildPayloadReceipt()),
    );

    expect(serialized).not.toContain(PRIOR_REF);
    expect(serialized).not.toContain(ACCEPTED_REF);
    expect(serialized).not.toContain("priorBackendRef");
    expect(serialized).not.toContain("acceptedBackendRef");
  });

  it("reports an accepted continuation as a boolean, not as its reference", () => {
    const withoutAcceptance = checkpointReceipt(
      buildOperation({
        phase: "ready",
        acceptance: null,
        protectedReferences: {
          priorBackendRef: PRIOR_REF,
          acceptedBackendRef: null,
        },
      }),
      buildPayloadReceipt(),
    );

    expect(withoutAcceptance.hasAcceptedContinuation).toBe(false);
    expect(withoutAcceptance.acceptance).toBeNull();
  });

  it("omits the filesystem project path so a receipt carries no local identity", () => {
    const receipt = checkpointReceipt(buildOperation(), buildPayloadReceipt());

    expect(JSON.stringify(receipt)).not.toContain("/projects/alpha");
  });

  it("reports an unfrozen operation with a null checkpoint rather than zeroes", () => {
    const receipt = checkpointReceipt(
      buildOperation({
        phase: "building",
        payloadId: null,
        acceptance: null,
        delivery: null,
        generationPassCount: null,
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          costUsd: null,
          durationMs: null,
        },
      }),
      null,
    );

    expect(receipt.checkpoint).toBeNull();
    expect(receipt.generationPassCount).toBeNull();
    expect(receipt.compactionUsage.costUsd).toBeNull();
    expect(checkpointReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("reports cached input beside fresh input rather than summed into it", () => {
    const receipt = checkpointReceipt(buildOperation(), buildPayloadReceipt());

    expect(receipt.compactionUsage).toEqual({
      inputTokens: 4096,
      cachedInputTokens: 30_000,
      outputTokens: 512,
      costUsd: 0.42,
      durationMs: 8100,
    });
  });

  it("reports the seed size as exact bytes with no token estimate or occupancy", () => {
    const receipt = checkpointReceipt(buildOperation(), buildPayloadReceipt());

    expect(receipt.checkpoint?.sectionBytes).toEqual({
      total: 30000,
      workingState: 18000,
      recentDialogue: 9000,
      recoveryFraming: 3000,
    });
    expect(receipt.seedTokenEstimate).toBeNull();
    expect(receipt.contextOccupancy).toBeNull();
  });

  it("states no savings, occupancy percentage or cumulative total anywhere", () => {
    const receipt = checkpointReceipt(buildOperation(), buildPayloadReceipt());

    // The categories design §9 forbids conflating: nothing on a receipt claims
    // a saving, a share of a window, or the conversation's running totals.
    for (const forbidden of [
      "saved",
      "savings",
      "percent",
      "occupancy",
      "cumulative",
      "total_tokens",
      "totalTokens",
      "cachePreserved",
    ]) {
      expect(Object.keys(receipt)).not.toContain(forbidden);
    }
    expect(Object.keys(receipt.compactionUsage).sort()).toEqual([
      "cachedInputTokens",
      "costUsd",
      "durationMs",
      "inputTokens",
      "outputTokens",
    ]);
  });

  it("refuses a token estimate that does not name its estimator", () => {
    const unlabeled = {
      ...checkpointReceipt(buildOperation(), buildPayloadReceipt()),
      seedTokenEstimate: { tokens: 8192 },
    };

    const parsed = checkpointReceiptSchema.safeParse(unlabeled);
    expect(parsed.success).toBe(false);
    expect(
      parsed.success
        ? []
        : parsed.error.issues.map((issue) => issue.path.join(".")),
    ).toContain("seedTokenEstimate.estimator");
  });
});
