/** Test data shared by the handoff persistence contract and transition tests. */
import { checkpointHandoffSchema, type CheckpointHandoff } from "./schemas";

export function pendingHandoff(
  overrides: Partial<CheckpointHandoff> = {},
): CheckpointHandoff {
  return checkpointHandoffSchema.parse({
    captureId: "operation-maximal:capture",
    requestedMode: "instruction-only",
    policyVersion: "1",
    backend: "codex",
    modelSelection: { modelId: "gpt-6-astra", parameters: { effort: "high" } },
    admissionSourceBasis: {
      capturedThroughSeq: 410,
      sourceHash: "sha256:basis-b",
    },
    stage: "pending",
    requestedAt: "2026-09-07T12:04:00.000Z",
    startedAt: null,
    settledAt: null,
    finalizedAt: null,
    stopIntent: null,
    modeEstablished: false,
    submitted: false,
    correlatedCompletion: false,
    executionSettled: false,
    omissionReason: null,
    contentHash: null,
    acceptedOutputBytes: null,
    sourceCoverage: null,
    activity: null,
    usage: null,
    continuationDisposition: null,
    executionStopAttestation: null,
    candidate: null,
    finalSourceBasis: null,
    auditDurable: false,
    ...overrides,
  });
}

export function capturedHandoff(
  overrides: Partial<CheckpointHandoff> = {},
): CheckpointHandoff {
  const claim = {
    kind: "reported_observation" as const,
    text: "Preserve original checkpoint bytes",
    sourceRefs: [{ messageIndex: 1, seqStart: 2, seqEnd: 3 }],
  };
  return pendingHandoff({
    stage: "captured",
    startedAt: "2026-09-07T12:04:01.000Z",
    settledAt: "2026-09-07T12:04:04.000Z",
    modeEstablished: true,
    submitted: true,
    correlatedCompletion: true,
    executionSettled: true,
    contentHash: "sha256:handoff",
    acceptedOutputBytes: 400,
    sourceCoverage: {
      seqStart: 411,
      seqEnd: 413,
      entryIds: ["capture-control", "capture-output", "capture-settlement"],
    },
    activity: {
      transport: "complete",
      native: "complete",
      prohibited: "not_observed",
      inspectedBytes: 512,
    },
    usage: {
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 30,
      costUsd: 0.2,
      costBasis: "pricing_estimate",
      executionMs: 2000,
      settlementMs: 1000,
    },
    continuationDisposition: "retain",
    auditDurable: true,
    finalSourceBasis: { capturedThroughSeq: 413, sourceHash: "sha256:final" },
    candidate: {
      plan: [claim],
      hypotheses: [claim],
      failedApproaches: [claim],
      blockers: [claim],
      nextStep: [claim],
    },
    ...overrides,
  });
}
