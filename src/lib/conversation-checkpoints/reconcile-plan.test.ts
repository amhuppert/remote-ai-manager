import { describe, expect, it } from "vitest";

import { pendingCheckpointCapture } from "@/lib/conversation-checkpoints/checkpoint-capture";

import { planCheckpointReconcile } from "./reconcile-plan";
import type { CheckpointHandoff, CheckpointOperation } from "./schemas";

function operation(
  overrides: Partial<CheckpointOperation> = {},
): CheckpointOperation {
  return {
    id: "op-1",
    scope: "session",
    projectPath: "/projects/alpha",
    sessionName: "csm-alpha",
    conversationId: "conv-1",
    ordinal: 1,
    phase: "needs_reconciliation",
    handoff: null,
    lastStablePhase: "retiring",
    sourceBasis: { capturedThroughSeq: 12, sourceHash: "sha256:source" },
    protectedReferences: { priorBackendRef: "prior", acceptedBackendRef: null },
    payloadId: null,
    delivery: null,
    acceptance: null,
    failure: null,
    recoversOperationId: null,
    supersededByOperationId: null,
    generationPassCount: null,
    usage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
    },
    requestedAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

function interruptedCapture(
  overrides: Partial<CheckpointHandoff> = {},
): CheckpointHandoff {
  return {
    ...pendingCheckpointCapture({
      requestId: "op-1",
      request: { mode: null },
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: {} },
      sourceBasis: { capturedThroughSeq: 12, sourceHash: "sha256:source" },
      at: "2026-10-03T00:00:00.000Z",
    }),
    stage: "omitted",
    omissionReason: "interrupted",
    ...overrides,
  };
}

const facts = { queueReviewRequired: false, captureExecutionStopped: false };

describe("planCheckpointReconcile", () => {
  it("finishes a retirement whose close or commit failed, held or still recorded as retiring", () => {
    expect(planCheckpointReconcile(operation(), facts)).toEqual({
      kind: "finish_retirement",
    });
    expect(
      planCheckpointReconcile(
        operation({ phase: "retiring", lastStablePhase: null }),
        facts,
      ),
    ).toEqual({
      kind: "finish_retirement",
    });
  });

  it("settles a build no process owns by the restart rules", () => {
    expect(
      planCheckpointReconcile(
        operation({ phase: "building", lastStablePhase: null }),
        facts,
      ),
    ).toEqual({
      kind: "apply_restart_rules",
    });
  });

  it("declares ready a held readiness whose only debt was its receipts", () => {
    expect(
      planCheckpointReconcile(operation({ lastStablePhase: "ready" }), facts),
    ).toEqual({ kind: "declare_ready" });
  });

  it("blocks an unresolved delivery behind the queue review first, then behind an explicit recovery", () => {
    const delivered = operation({ lastStablePhase: "delivering" });
    expect(
      planCheckpointReconcile(delivered, {
        ...facts,
        queueReviewRequired: true,
      }),
    ).toMatchObject({
      kind: "blocked",
      code: "queue_review_required",
    });
    expect(planCheckpointReconcile(delivered, facts)).toMatchObject({
      kind: "blocked",
      code: "recovery_required",
      reason: expect.stringContaining("--recover"),
    });
  });

  it("blocks a lost applied continuation behind an explicit recovery", () => {
    expect(
      planCheckpointReconcile(operation({ lastStablePhase: "applied" }), facts),
    ).toMatchObject({
      kind: "blocked",
      code: "recovery_required",
    });
  });

  it("observes the cleanup of an interrupted capture, and then asks for a recovery", () => {
    const held = operation({
      lastStablePhase: "building",
      handoff: interruptedCapture(),
    });
    expect(planCheckpointReconcile(held, facts)).toEqual({
      kind: "observe_capture_cleanup",
    });
    const observed = operation({
      lastStablePhase: "building",
      handoff: interruptedCapture({ executionSettled: true }),
    });
    expect(
      planCheckpointReconcile(observed, {
        ...facts,
        captureExecutionStopped: true,
      }),
    ).toMatchObject({
      kind: "blocked",
      code: "recovery_required",
    });
  });

  it("leaves a delivery in flight to its turn and a settled operation as it is", () => {
    expect(
      planCheckpointReconcile(
        operation({ phase: "delivering", lastStablePhase: null }),
        facts,
      ),
    ).toMatchObject({
      kind: "refused",
      code: "conversation_busy",
    });
    for (const phase of ["ready", "applied", "failed", "cancelled"] as const) {
      expect(
        planCheckpointReconcile(
          operation({ phase, lastStablePhase: null }),
          facts,
        ),
      ).toEqual({ kind: "unchanged" });
    }
  });

  it("refuses a superseded operation and an acknowledgement that names no capture", () => {
    expect(
      planCheckpointReconcile(
        operation({ supersededByOperationId: "op-2" }),
        facts,
      ),
    ).toMatchObject({
      kind: "refused",
      code: "stale_operation",
    });
    expect(
      planCheckpointReconcile(operation(), {
        ...facts,
        captureExecutionStopped: true,
      }),
    ).toMatchObject({
      kind: "refused",
      code: "invalid_handoff",
    });
  });
});
