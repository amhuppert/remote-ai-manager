export interface RestartEvidence {
  observedProcessCount: number;
  remainingProcessCount: number;
  originalCaptureId: string;
  observedCaptureIds: readonly string[];
  queueId: string;
  queuedAfterRestart: readonly string[];
  queuedAfterAttestation: readonly string[];
  archivePrefixHash: string;
  reloadedArchivePrefixHash: string;
  attestationSource: string | null;
  attestedPhase: string;
  recoveryPhase: string;
  recoveryHadHandoff: boolean;
  acceptedQueueId: string | null;
}
export function assessRestartEvidence(input: RestartEvidence): string[] {
  const failures: string[] = [];
  if (input.observedProcessCount < 1 || input.remainingProcessCount !== 0)
    failures.push("owned process cleanup not observed");
  if (
    input.observedCaptureIds.length !== 1 ||
    input.observedCaptureIds[0] !== input.originalCaptureId
  )
    failures.push("capture replay observed");
  if (!input.queuedAfterRestart.includes(input.queueId))
    failures.push("restart released or lost queued input");
  if (!input.queuedAfterAttestation.includes(input.queueId))
    failures.push("attestation released or lost queued input");
  if (input.archivePrefixHash !== input.reloadedArchivePrefixHash)
    failures.push("recorded archive prefix changed");
  if (
    input.attestationSource !== "api" ||
    input.attestedPhase !== "needs_reconciliation"
  )
    failures.push("stopped-execution testimony did not preserve recovery hold");
  if (input.recoveryHadHandoff)
    failures.push("recovery unexpectedly requested capture");
  if (
    input.recoveryPhase !== "applied" ||
    input.acceptedQueueId !== input.queueId
  )
    failures.push("recovery acceptance does not match retained queue");
  return failures;
}
