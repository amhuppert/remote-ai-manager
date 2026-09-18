import { describe, expect, it } from "vitest";
import { transcriptMessageOriginSchema } from "@/lib/conversations/schemas";
import { CHECKPOINT_CAPTURE_LIMITS } from "./budget";

import {
  checkpointHandoffSchema,
  checkpointHandoffClaimSchema,
  checkpointHandoffCandidateSchema,
  checkpointPhaseSchema,
  type CheckpointPhase,
} from "./schemas";
import {
  validateCheckpointOutcomeEdge,
  validateCheckpointTransition,
} from "./transitions";

const ALL_PHASES = checkpointPhaseSchema.options;

/**
 * The transition authority stated as data, independent of the implementation:
 * each entry is the complete set of phases reachable from one phase. Every
 * pair not listed here must be refused, so the table doubles as the negative
 * case and a new edge cannot be added without appearing here first.
 */
const EXPECTED_LEGAL: Readonly<Record<CheckpointPhase, CheckpointPhase[]>> = {
  // A build can freeze, fail, or be cancelled before anything is retired.
  building: ["retiring", "failed", "cancelled", "needs_reconciliation"],
  // Retirement either completes or becomes owned repair work.
  retiring: ["ready", "needs_reconciliation"],
  // A ready seed is consumed by the next admitted ordinary turn.
  ready: ["delivering", "needs_reconciliation"],
  // Acceptance, a definite pre-acceptance admission failure, or uncertainty.
  delivering: ["applied", "ready", "needs_reconciliation"],
  // An applied continuation that later becomes unusable needs recovery.
  applied: ["needs_reconciliation"],
  // Repair proves retirement finished, or repairs acceptance evidence.
  needs_reconciliation: ["ready", "applied"],
  failed: [],
  cancelled: [],
};

describe("validateCheckpointTransition", () => {
  it("accepts exactly the phases the lifecycle reaches from each phase", () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const verdict = validateCheckpointTransition({ from, to });
        expect(
          verdict.legal,
          `${from} -> ${to} should be ${
            EXPECTED_LEGAL[from].includes(to) ? "legal" : "illegal"
          }`,
        ).toBe(EXPECTED_LEGAL[from].includes(to));
      }
    }
  });

  it("refuses a transition from a phase to itself", () => {
    for (const phase of ALL_PHASES) {
      expect(
        validateCheckpointTransition({ from: phase, to: phase }).legal,
      ).toBe(false);
    }
  });

  it("names the refused edge in the reason so a refusal receipt can report it", () => {
    const verdict = validateCheckpointTransition({
      from: "ready",
      to: "applied",
    });
    expect(verdict.legal).toBe(false);
    if (verdict.legal) throw new Error("expected an illegal transition");
    expect(verdict.reason).toContain("ready");
    expect(verdict.reason).toContain("applied");
  });

  it("never lets a terminal phase move again", () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      for (const to of ALL_PHASES) {
        expect(validateCheckpointTransition({ from: terminal, to }).legal).toBe(
          false,
        );
      }
    }
  });
});

/**
 * The edges a generic outcome may NOT walk, and the method that owns each. A
 * generic outcome carries no payload, no reference clear, no attempt binding
 * and no acceptance evidence, so these edges would move an operation to a phase
 * whose defining fact never happened.
 */
const EXPECTED_OWNERS: Readonly<
  Partial<Record<CheckpointPhase, Partial<Record<CheckpointPhase, string>>>>
> = {
  building: { retiring: "freezePayload" },
  retiring: { ready: "commitReady" },
  ready: { delivering: "beginDelivery" },
  delivering: { applied: "recordAcceptance" },
  needs_reconciliation: { applied: "recordAcceptance" },
};

describe("validateCheckpointOutcomeEdge", () => {
  it("refuses every legal edge whose meaning is evidence another method supplies", () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const owner = EXPECTED_OWNERS[from]?.[to];
        const verdict = validateCheckpointOutcomeEdge({ from, to });
        expect(verdict.owned, `${from} -> ${to}`).toBe(owner === undefined);
        if (!verdict.owned) expect(verdict.owner).toBe(owner);
      }
    }
  });

  it("leaves the outcome-owned edges of the lifecycle available", () => {
    const outcomeEdges: [CheckpointPhase, CheckpointPhase][] = [
      ["building", "failed"],
      ["building", "cancelled"],
      ["retiring", "needs_reconciliation"],
      ["ready", "needs_reconciliation"],
      ["delivering", "ready"],
      ["delivering", "needs_reconciliation"],
      ["applied", "needs_reconciliation"],
      ["needs_reconciliation", "ready"],
    ];
    for (const [from, to] of outcomeEdges) {
      expect(
        validateCheckpointOutcomeEdge({ from, to }).owned,
        `${from} -> ${to}`,
      ).toBe(true);
      expect(validateCheckpointTransition({ from, to }).legal).toBe(true);
    }
  });

  it("names the owning method in the reason so a refusal receipt can report it", () => {
    const verdict = validateCheckpointOutcomeEdge({
      from: "retiring",
      to: "ready",
    });
    expect(verdict.owned).toBe(false);
    if (verdict.owned) throw new Error("expected an unowned edge");
    expect(verdict.reason).toContain("commitReady");
  });
});

describe("handoff claims", () => {
  const claim = { kind: "belief", text: "é".repeat(1000), sourceRefs: [] };
  const candidate = {
    plan: [],
    hypotheses: [],
    failedApproaches: [],
    blockers: [],
    nextStep: [],
  };

  it("accepts explicit empty categories and exactly 2000 UTF-8 bytes", () => {
    expect(checkpointHandoffCandidateSchema.safeParse(candidate).success).toBe(
      true,
    );
    expect(checkpointHandoffClaimSchema.safeParse(claim).success).toBe(true);
  });

  it("rejects a claim one UTF-8 byte over the limit", () => {
    const parsed = checkpointHandoffClaimSchema.safeParse({
      ...claim,
      text: claim.text + "x",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["text"]);
  });

  it("requires original references for reported observations", () => {
    const parsed = checkpointHandoffClaimSchema.safeParse({
      ...claim,
      kind: "reported_observation",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0]?.path).toEqual(["sourceRefs"]);
  });

  it("limits every category to eight claims and every claim to four references", () => {
    for (const key of Object.keys(candidate)) {
      expect(
        checkpointHandoffCandidateSchema.safeParse({
          ...candidate,
          [key]: Array(8).fill(claim),
        }).success,
      ).toBe(true);
      expect(
        checkpointHandoffCandidateSchema.safeParse({
          ...candidate,
          [key]: Array(9).fill(claim),
        }).success,
      ).toBe(false);
    }
    const ref = { messageIndex: 0, seqStart: 1, seqEnd: 2 };
    expect(
      checkpointHandoffClaimSchema.safeParse({
        ...claim,
        sourceRefs: Array(4).fill(ref),
      }).success,
    ).toBe(true);
    expect(
      checkpointHandoffClaimSchema.safeParse({
        ...claim,
        sourceRefs: Array(5).fill(ref),
      }).success,
    ).toBe(false);
    expect(
      checkpointHandoffClaimSchema.safeParse({ ...claim, text: "" }).success,
    ).toBe(false);
    expect(
      checkpointHandoffClaimSchema.safeParse({
        ...claim,
        sourceRefs: [{ ...ref, seqEnd: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("durable handoff validity", () => {
  const pending = {
    captureId: "op:capture",
    requestedMode: "instruction-only",
    policyVersion: "1",
    backend: "codex",
    modelSelection: { modelId: "gpt-6-astra", parameters: {} },
    admissionSourceBasis: { capturedThroughSeq: 3, sourceHash: "original" },
    stage: "pending",
    requestedAt: "now",
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
  it.each([false, true])(
    "requires a durable start and bound mode for submitted omissions (completion=%s)",
    (correlatedCompletion) => {
      const omitted = {
        ...pending,
        stage: "omitted",
        omissionReason: "capture_failed",
        submitted: true,
        correlatedCompletion,
        startedAt: "start",
        settledAt: "end",
        executionSettled: true,
        auditDurable: true,
        finalSourceBasis: pending.admissionSourceBasis,
      };
      expect(checkpointHandoffSchema.safeParse(omitted).success).toBe(true);
      for (const field of ["startedAt", "requestedMode"] as const) {
        const result = checkpointHandoffSchema.safeParse({
          ...omitted,
          [field]: null,
        });
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: [field] }),
            ]),
          );
      }
    },
  );
  it("accepts an unsubmitted pending intent", () => {
    expect(checkpointHandoffSchema.safeParse(pending).success).toBe(true);
  });
  it.each([
    { stage: "captured" },
    { stage: "included" },
    { stage: "omitted" },
    { omissionReason: "seed_budget" },
    { stage: "running" },
    { submitted: true },
    { finalSourceBasis: pending.admissionSourceBasis },
  ])("rejects impossible capture metadata %j", (change) => {
    expect(
      checkpointHandoffSchema.safeParse({ ...pending, ...change }).success,
    ).toBe(false);
  });
});

describe("capture provenance and policy", () => {
  it("keeps capture origins distinct while preserving ordinary origins", () => {
    for (const part of ["control", "output", "activity", "settlement"]) {
      const origin = {
        source: "checkpoint_capture",
        checkpointCapture: { operationId: "op", captureId: "op:capture", part },
      };
      expect(transcriptMessageOriginSchema.parse(origin)).toEqual(origin);
    }
    expect(transcriptMessageOriginSchema.parse({ source: "user" })).toEqual({
      source: "user",
    });
    expect(
      transcriptMessageOriginSchema.safeParse({ source: "checkpoint_capture" })
        .success,
    ).toBe(false);
    expect(
      transcriptMessageOriginSchema.safeParse({
        source: "user",
        checkpointCapture: {
          operationId: "op",
          captureId: "cap",
          part: "output",
        },
      }).success,
    ).toBe(false);
  });
  it("publishes finite input, output, execution and shared settlement bounds", () => {
    expect(CHECKPOINT_CAPTURE_LIMITS).toEqual({
      maxSubmissions: 1,
      executionMs: 60000,
      settlementMs: 5000,
      inputBytes: 8192,
      outputBytes: 6144,
      nativeInspectionBytes: 8388608,
      nativeInspectionMs: 2000,
    });
    expect(Object.isFrozen(CHECKPOINT_CAPTURE_LIMITS)).toBe(true);
  });
});
