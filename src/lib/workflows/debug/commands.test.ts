import { describe, it, expect } from "vitest";
import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import { applyDebugCommand, clearDebugTurnFailure } from "./commands";

const NOW = "2026-01-01T00:00:00.000Z";

function debugState(
  overrides: Partial<RuntimeDebugModeState> = {},
): RuntimeDebugModeState {
  return {
    active: true,
    recording: true,
    logFilePath: "/tmp/.debug/logs.jsonl",
    enteredAt: "2025-12-31T00:00:00.000Z",
    hypotheses: [{ id: "H1", description: "A", instrumentationPlan: "Log" }],
    reproductionSteps: ["Step 1"],
    fixSummary: "A fix",
    verificationSteps: ["Verify it"],
    instructionsDelivered: true,
    phase: "hypothesizing",
    lastTurnFailed: false,
    debugSessionId: "debug-session-current",
    ...overrides,
  };
}

describe("applyDebugCommand", () => {
  describe("enter", () => {
    it("initializes a fresh debug state at hypothesizing and broadcasts", () => {
      const effect = applyDebugCommand(
        null,
        {
          kind: "enter",
          logFilePath: "/tmp/x.jsonl",
          debugSessionId: "debug-session-new",
        },
        NOW,
      );
      expect(effect).not.toBeNull();
      expect(effect!.debugMode).toEqual({
        active: true,
        recording: true,
        logFilePath: "/tmp/x.jsonl",
        enteredAt: NOW,
        hypotheses: [],
        reproductionSteps: [],
        fixSummary: null,
        verificationSteps: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
        lastTurnFailed: false,
        debugSessionId: "debug-session-new",
      });
      expect(effect!.broadcastDebugModeStatus).toBe(true);
    });

    it("is illegal while debug mode is already active", () => {
      expect(
        applyDebugCommand(
          debugState(),
          {
            kind: "enter",
            logFilePath: "/tmp/y.jsonl",
            debugSessionId: "debug-session-other",
          },
          NOW,
        ),
      ).toBeNull();
    });
  });

  it("every non-enter command is illegal when debug mode is inactive", () => {
    for (const command of [
      { kind: "exit" },
      { kind: "set_recording", recording: false },
      { kind: "mark_reproduced" },
      { kind: "mark_fix_verified" },
      { kind: "mark_fix_failed" },
      { kind: "revert_to_awaiting_reproduction" },
      { kind: "revert_to_awaiting_verification" },
      { kind: "retry_turn" },
      {
        kind: "cleanup_verified",
        debugSessionId: "debug-session-current",
        attempt: 0,
      },
      {
        kind: "cleanup_verification_failed",
        debugSessionId: "debug-session-current",
        message: "m",
        attempt: 0,
      },
    ] as const) {
      expect(applyDebugCommand(null, command, NOW)).toBeNull();
    }
  });

  it("exit clears debug state and broadcasts", () => {
    const effect = applyDebugCommand(debugState(), { kind: "exit" }, NOW);
    expect(effect).toEqual({
      debugMode: null,
      broadcastDebugModeStatus: true,
    });
  });

  it("set_recording toggles the flag in any phase, including the failed-turn state", () => {
    const effect = applyDebugCommand(
      debugState({ lastTurnFailed: true }),
      { kind: "set_recording", recording: false },
      NOW,
    );
    expect(effect!.debugMode).toMatchObject({
      recording: false,
      lastTurnFailed: true,
    });
    expect(effect!.broadcastDebugModeStatus).toBe(true);
  });

  describe("phase legality table", () => {
    it("mark_reproduced: awaiting_reproduction → analyzing_evidence, illegal elsewhere", () => {
      const legal = applyDebugCommand(
        debugState({ phase: "awaiting_reproduction" }),
        { kind: "mark_reproduced" },
        NOW,
      );
      expect(legal!.debugMode!.phase).toBe("analyzing_evidence");

      for (const phase of [
        "hypothesizing",
        "analyzing_evidence",
        "awaiting_verification",
        "cleanup_instrumentation",
      ] as const) {
        expect(
          applyDebugCommand(
            debugState({ phase }),
            { kind: "mark_reproduced" },
            NOW,
          ),
        ).toBeNull();
      }
    });

    it("mark_fix_verified: awaiting_verification → cleanup_instrumentation", () => {
      const legal = applyDebugCommand(
        debugState({ phase: "awaiting_verification" }),
        { kind: "mark_fix_verified" },
        NOW,
      );
      expect(legal!.debugMode!.phase).toBe("cleanup_instrumentation");
      expect(
        applyDebugCommand(
          debugState({ phase: "hypothesizing" }),
          { kind: "mark_fix_verified" },
          NOW,
        ),
      ).toBeNull();
    });

    it("mark_fix_failed: awaiting_verification → hypothesizing, preserving fixSummary and clearing verificationSteps", () => {
      const effect = applyDebugCommand(
        debugState({ phase: "awaiting_verification" }),
        { kind: "mark_fix_failed" },
        NOW,
      );
      expect(effect!.debugMode).toMatchObject({
        phase: "hypothesizing",
        fixSummary: "A fix",
        verificationSteps: [],
      });
    });

    it("revert_to_awaiting_reproduction: analyzing_evidence only", () => {
      const legal = applyDebugCommand(
        debugState({ phase: "analyzing_evidence" }),
        { kind: "revert_to_awaiting_reproduction" },
        NOW,
      );
      expect(legal!.debugMode!.phase).toBe("awaiting_reproduction");
      expect(
        applyDebugCommand(
          debugState({ phase: "awaiting_verification" }),
          { kind: "revert_to_awaiting_reproduction" },
          NOW,
        ),
      ).toBeNull();
    });

    it("revert_to_awaiting_verification: legal from cleanup_instrumentation and hypothesizing", () => {
      for (const phase of [
        "cleanup_instrumentation",
        "hypothesizing",
      ] as const) {
        const effect = applyDebugCommand(
          debugState({ phase }),
          { kind: "revert_to_awaiting_verification" },
          NOW,
        );
        expect(effect!.debugMode!.phase).toBe("awaiting_verification");
      }
      expect(
        applyDebugCommand(
          debugState({ phase: "analyzing_evidence" }),
          { kind: "revert_to_awaiting_verification" },
          NOW,
        ),
      ).toBeNull();
    });

    it("phase-advancing commands are illegal in the failed-turn state", () => {
      const failedState = debugState({
        phase: "awaiting_verification",
        lastTurnFailed: true,
      });
      expect(
        applyDebugCommand(failedState, { kind: "mark_fix_verified" }, NOW),
      ).toBeNull();
      expect(
        applyDebugCommand(failedState, { kind: "mark_fix_failed" }, NOW),
      ).toBeNull();
    });
  });

  describe("cleanup verification outcomes", () => {
    it("cleanup_verified exits debug mode, releases the preserved turn, and broadcasts both statuses", () => {
      const effect = applyDebugCommand(
        debugState({
          phase: "cleanup_instrumentation",
          cleanupVerificationAttempt: 1,
        }),
        {
          kind: "cleanup_verified",
          debugSessionId: "debug-session-current",
          attempt: 1,
        },
        NOW,
      );
      expect(effect).toEqual({
        debugMode: null,
        clearActiveTurn: true,
        broadcastConversationStatus: true,
        broadcastDebugModeStatus: true,
      });
    });

    it("cleanup_verification_failed parks in the failed-turn state with the remediation message", () => {
      const effect = applyDebugCommand(
        debugState({
          phase: "cleanup_instrumentation",
          cleanupVerificationAttempt: 1,
        }),
        {
          kind: "cleanup_verification_failed",
          debugSessionId: "debug-session-current",
          message: "Probe P1 still present",
          attempt: 1,
        },
        NOW,
      );
      expect(effect!.debugMode).toMatchObject({
        phase: "cleanup_instrumentation",
        lastTurnFailed: true,
      });
      expect(effect!.lastError).toBe("Probe P1 still present");
      expect(effect!.broadcastConversationStatus).toBe(true);
    });

    it("stale verification outcomes are ignored once the phase moved on (e.g. user exited and re-entered)", () => {
      expect(
        applyDebugCommand(
          debugState({ phase: "hypothesizing" }),
          {
            kind: "cleanup_verified",
            debugSessionId: "debug-session-current",
            attempt: 0,
          },
          NOW,
        ),
      ).toBeNull();
    });

    it("verification outcomes from a superseded attempt are ignored even in the same phase", () => {
      const current = debugState({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 2,
      });
      expect(
        applyDebugCommand(
          current,
          {
            kind: "cleanup_verified",
            debugSessionId: "debug-session-current",
            attempt: 1,
          },
          NOW,
        ),
      ).toBeNull();
      expect(
        applyDebugCommand(
          current,
          {
            kind: "cleanup_verification_failed",
            debugSessionId: "debug-session-current",
            message: "stale",
            attempt: 1,
          },
          NOW,
        ),
      ).toBeNull();
    });

    it("rejects a prior debug session's result even when both sessions are on attempt 1", () => {
      const current = debugState({
        phase: "cleanup_instrumentation",
        cleanupVerificationAttempt: 1,
        debugSessionId: "debug-session-new",
      });
      expect(
        applyDebugCommand(
          current,
          {
            kind: "cleanup_verified",
            debugSessionId: "debug-session-prior",
            attempt: 1,
          },
          NOW,
        ),
      ).toBeNull();
      expect(
        applyDebugCommand(
          current,
          {
            kind: "cleanup_verification_failed",
            debugSessionId: "debug-session-prior",
            message: "stale failure",
            attempt: 1,
          },
          NOW,
        ),
      ).toBeNull();
    });
  });

  it("retry_turn is never reducer-legal (machine-owned)", () => {
    expect(
      applyDebugCommand(
        debugState({ lastTurnFailed: true }),
        { kind: "retry_turn" },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("clearDebugTurnFailure", () => {
  it("clears the failed flag when set", () => {
    expect(
      clearDebugTurnFailure(debugState({ lastTurnFailed: true })),
    ).toMatchObject({ lastTurnFailed: false });
  });

  it("returns the same reference when nothing to clear", () => {
    const state = debugState();
    expect(clearDebugTurnFailure(state)).toBe(state);
    expect(clearDebugTurnFailure(null)).toBeNull();
  });
});
