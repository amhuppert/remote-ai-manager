import { describe, expect, it } from "vitest";
import {
  assessRestartEvidence,
  type RestartEvidence,
} from "./restart-evidence";
const observed: RestartEvidence = {
  observedProcessCount: 3,
  remainingProcessCount: 0,
  originalCaptureId: "capture-1",
  observedCaptureIds: ["capture-1"],
  queueId: "q1",
  queuedAfterRestart: ["q1"],
  queuedAfterAttestation: ["q1"],
  archivePrefixHash: "same",
  reloadedArchivePrefixHash: "same",
  attestationSource: "api",
  attestedPhase: "needs_reconciliation",
  recoveryPhase: "applied",
  recoveryHadHandoff: false,
  acceptedQueueId: "q1",
};
describe("restart probe evidence", () => {
  it("requires observed cleanup, retained queue/history and separately admitted baseline recovery", () => {
    expect(assessRestartEvidence(observed)).toEqual([]);
    expect(
      assessRestartEvidence({
        ...observed,
        observedProcessCount: 0,
        remainingProcessCount: 1,
        queuedAfterAttestation: [],
        archivePrefixHash: "altered",
        recoveryHadHandoff: true,
      }),
    ).toEqual([
      "owned process cleanup not observed",
      "attestation released or lost queued input",
      "recorded archive prefix changed",
      "recovery unexpectedly requested capture",
    ]);
  });
  it("never passes capture replay or mismatched queued acceptance", () => {
    expect(
      assessRestartEvidence({
        ...observed,
        observedCaptureIds: ["capture-1", "replayed"],
        acceptedQueueId: "other",
      }),
    ).toEqual([
      "capture replay observed",
      "recovery acceptance does not match retained queue",
    ]);
  });
});
