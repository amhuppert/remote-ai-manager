import { CHECKPOINT_CAPTURE_POLICY_VERSION } from "@/lib/conversation-checkpoints/budget";
import type {
  CheckpointHandoff,
  CheckpointHandoffRequest,
  CheckpointSourceBasis,
} from "@/lib/conversation-checkpoints/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

/** Admission binds the caller's disclosure before any provider work. */
export function pendingCheckpointCapture(input: {
  requestId: string;
  request: CheckpointHandoffRequest;
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
  sourceBasis: CheckpointSourceBasis;
  at: string;
}): CheckpointHandoff {
  return {
    captureId: `${input.requestId}:capture`,
    requestedMode: input.request.mode,
    policyVersion: CHECKPOINT_CAPTURE_POLICY_VERSION,
    backend: input.backend,
    modelSelection: structuredClone(input.modelSelection),
    admissionSourceBasis: input.sourceBasis,
    stage: "pending",
    requestedAt: input.at,
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
  };
}

export function omittedCaptureResult(
  reason: import("@/lib/agent-backends/schemas").CaptureOmissionReason,
  backendRef: import("@/lib/shared/schemas").AgentSessionRef | null,
): import("@/lib/agent-backends/schemas").CaptureHandoffResult {
  return {
    modeEstablished: false,
    submitted: false,
    correlatedCompletion: false,
    candidateText: null,
    omissionReason: reason,
    executionSettled: true,
    cleanupFailure: null,
    continuation: {
      disposition: backendRef === null ? "clear" : "retain",
      backendRef,
      nextRuntime: backendRef === null ? "unavailable" : "current",
    },
    activity: {
      transport: "complete",
      native: "unavailable",
      prohibited: "not_observed",
      inspectedBytes: null,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      costBasis: null,
      executionMs: null,
      settlementMs: null,
    },
  };
}
