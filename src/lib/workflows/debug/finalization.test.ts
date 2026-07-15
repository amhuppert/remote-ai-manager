import { describe, it, expect } from "vitest";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import { resolveDebugFinalization } from "./finalization";

function debugState(
  overrides: Partial<RuntimeDebugModeState> = {},
): RuntimeDebugModeState {
  return {
    active: true,
    recording: true,
    logFilePath: "/tmp/.debug/logs.jsonl",
    enteredAt: "2025-12-31T00:00:00.000Z",
    hypotheses: [{ id: "H0", description: "Old", instrumentationPlan: "Log" }],
    reproductionSteps: ["Old step"],
    fixSummary: "Old fix",
    verificationSteps: ["Old verify"],
    instructionsDelivered: false,
    phase: "hypothesizing",
    lastTurnFailed: false,
    debugSessionId: "debug-session-current",
    ...overrides,
  };
}

const HYPOTHESIS_PAYLOAD = {
  hypotheses: [
    { id: "H1", description: "A", instrumentationPlan: "Log" },
    { id: "H2", description: "B", instrumentationPlan: "Log" },
    { id: "H3", description: "C", instrumentationPlan: "Log" },
  ],
  reproductionSteps: ["Step 1", "Step 2"],
};

const FIX_APPLIED_PAYLOAD = {
  outcome: "fix_applied",
  supportedHypotheses: ["H1"],
  refutedHypotheses: [],
  inconclusiveHypotheses: ["H2"],
  evidenceSummary: "H1 confirmed.",
  fixSummary: "Applied minimal fix.",
  verificationSteps: ["Run failing test"],
};

const MORE_INSTRUMENTATION_PAYLOAD = {
  outcome: "more_instrumentation",
  supportedHypotheses: [],
  refutedHypotheses: ["H1"],
  inconclusiveHypotheses: ["H2"],
  evidenceSummary: "Inconclusive.",
  hypotheses: [{ id: "H4", description: "D", instrumentationPlan: "Trace" }],
  reproductionSteps: ["Step A"],
};

function success(structuredOutput: unknown) {
  return { structuredOutput, error: null };
}

describe("resolveDebugFinalization", () => {
  it("hypothesizing + valid payload advances to awaiting_reproduction with parsed hypotheses", () => {
    const result = resolveDebugFinalization({
      debugMode: debugState({ phase: "hypothesizing" }),
      lastResult: success(HYPOTHESIS_PAYLOAD),
      lastError: null,
    });
    expect(result.kind).toBe("advance");
    expect(result.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      instructionsDelivered: true,
      reproductionSteps: ["Step 1", "Step 2"],
    });
    expect(result.debugMode!.hypotheses.map((h) => h.id)).toEqual([
      "H1",
      "H2",
      "H3",
    ]);
  });

  it("hypothesizing + payload failing the hypothesis schema still advances, keeping prior hypotheses", () => {
    // The advancement gate is structuredOutput presence; the payload parse
    // only enriches context. (Pinned legacy behavior.)
    const result = resolveDebugFinalization({
      debugMode: debugState({ phase: "hypothesizing" }),
      lastResult: success({ hypotheses: [], reproductionSteps: [] }),
      lastError: null,
    });
    expect(result.kind).toBe("advance");
    expect(result.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      hypotheses: [
        { id: "H0", description: "Old", instrumentationPlan: "Log" },
      ],
      reproductionSteps: ["Old step"],
    });
  });

  it("analyzing_evidence + fix_applied advances to awaiting_verification with fix details", () => {
    const result = resolveDebugFinalization({
      debugMode: debugState({ phase: "analyzing_evidence" }),
      lastResult: success(FIX_APPLIED_PAYLOAD),
      lastError: null,
    });
    expect(result.kind).toBe("advance");
    expect(result.debugMode).toMatchObject({
      phase: "awaiting_verification",
      fixSummary: "Applied minimal fix.",
      verificationSteps: ["Run failing test"],
    });
  });

  it("analyzing_evidence + more_instrumentation loops to awaiting_reproduction and clears prior fix data", () => {
    const result = resolveDebugFinalization({
      debugMode: debugState({ phase: "analyzing_evidence" }),
      lastResult: success(MORE_INSTRUMENTATION_PAYLOAD),
      lastError: null,
    });
    expect(result.kind).toBe("advance");
    expect(result.debugMode).toMatchObject({
      phase: "awaiting_reproduction",
      fixSummary: null,
      verificationSteps: [],
      reproductionSteps: ["Step A"],
    });
    expect(result.debugMode!.hypotheses.map((h) => h.id)).toEqual(["H4"]);
  });

  it("analyzing_evidence + structured output that fails the evidence schema is a failed turn", () => {
    const result = resolveDebugFinalization({
      debugMode: debugState({ phase: "analyzing_evidence" }),
      lastResult: success({ outcome: "unknown" }),
      lastError: null,
    });
    expect(result.kind).toBe("turn_failed");
    if (result.kind !== "turn_failed") return;
    expect(result.debugMode.lastTurnFailed).toBe(true);
    expect(result.debugMode.phase).toBe("analyzing_evidence");
    expect(result.lastError).toBe(
      "Turn did not produce a valid structured response",
    );
  });

  it("cleanup_instrumentation + structured report requests verification stamped with the next attempt", () => {
    const debugMode = debugState({ phase: "cleanup_instrumentation" });
    const result = resolveDebugFinalization({
      debugMode,
      lastResult: success({ removedInstrumentation: true }),
      lastError: null,
    });
    expect(result.kind).toBe("verify_cleanup");
    expect(result.debugMode).toEqual({
      ...debugMode,
      cleanupVerificationAttempt: 1,
    });
  });

  it("each cleanup turn bumps the verification attempt, invalidating a superseded pending verification", () => {
    const result = resolveDebugFinalization({
      debugMode: debugState({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 3,
      }),
      lastResult: success({ removedInstrumentation: true }),
      lastError: null,
    });
    expect(result.kind).toBe("verify_cleanup");
    expect(result.debugMode.cleanupVerificationAttempt).toBe(4);
  });

  describe("failed phase-advancing turns", () => {
    it("null structuredOutput (Codex parity: no error set) is a failed turn", () => {
      const result = resolveDebugFinalization({
        debugMode: debugState({ phase: "hypothesizing" }),
        lastResult: { structuredOutput: undefined, error: null },
        lastError: null,
      });
      expect(result.kind).toBe("turn_failed");
    });

    it("prefers the machine lastError, then the result error, then the fallback message", () => {
      const withLastError = resolveDebugFinalization({
        debugMode: debugState({ phase: "cleanup_instrumentation" }),
        lastResult: { structuredOutput: undefined, error: "sdk boom" },
        lastError: "invoke failed",
      });
      expect(withLastError.kind).toBe("turn_failed");
      if (withLastError.kind === "turn_failed") {
        expect(withLastError.lastError).toBe("invoke failed");
      }

      const withResultError = resolveDebugFinalization({
        debugMode: debugState({ phase: "hypothesizing" }),
        lastResult: { structuredOutput: {}, error: "sdk boom" },
        lastError: null,
      });
      expect(withResultError.kind).toBe("turn_failed");
      if (withResultError.kind === "turn_failed") {
        expect(withResultError.lastError).toBe("sdk boom");
      }
    });
  });

  it("waiting phases settle follow-ups back to the same phase regardless of structured output", () => {
    for (const phase of [
      "awaiting_reproduction",
      "awaiting_verification",
    ] as const) {
      const debugMode = debugState({ phase });
      for (const lastResult of [
        success({}),
        { structuredOutput: undefined, error: null },
        null,
      ]) {
        const result = resolveDebugFinalization({
          debugMode,
          lastResult,
          lastError: null,
        });
        expect(result.kind).toBe("followup_settled");
        expect(result.debugMode).toBe(debugMode);
      }
    }
  });
});
