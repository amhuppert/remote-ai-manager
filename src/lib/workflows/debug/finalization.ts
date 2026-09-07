/**
 * Debug turn finalization policy.
 *
 * When a conversation turn finalizes while debug mode is active, the debug
 * workflow — not the conversation machine — decides what the turn outcome
 * means: advance the phase, settle a follow-up, hand the structured cleanup
 * report to async verification, or park in the failed-turn state so the user
 * can retry. The conversation machine consumes the decision through a single
 * `finalizingTurn` branch and maps `kind` onto its side-effect actions.
 */

import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";
import {
  debugEvidenceAnalysisSchema,
  debugHypothesisOutputZodSchema,
} from "@/lib/workflows/debug/schemas";

/** The slice of a turn result the finalization policy consumes. */
export interface DebugTurnOutcome {
  structuredOutput?: unknown;
  error: string | null;
}

export type DebugFinalization =
  /** Phase-advancing turn succeeded: notify the user (push + unread). */
  | { kind: "advance"; debugMode: RuntimeDebugModeState }
  /** Follow-up turn in a waiting phase settled; same phase, no notification. */
  | { kind: "followup_settled"; debugMode: RuntimeDebugModeState }
  /**
   * Cleanup turn produced a structured report: the caller must start async
   * cleanup verification and preserve `activeTurn` so a failed verification
   * can retry the same cleanup prompt.
   */
  | { kind: "verify_cleanup"; debugMode: RuntimeDebugModeState }
  /**
   * Phase-advancing turn failed (no valid structured output / SDK error).
   * Phase and `activeTurn` are preserved for retry; `lastTurnFailed` marks
   * the failed-turn state so restore-after-restart keeps the error UX.
   */
  | {
      kind: "turn_failed";
      debugMode: RuntimeDebugModeState;
      lastError: string;
    };

/**
 * Phase advancement gate: both backends surface a missing/invalid structured
 * response as `structuredOutput == null`. Codex never sets `error` for
 * schema-divergent replies, so the structuredOutput half is the single
 * load-bearing condition; the error half is belt-and-suspenders for SDK-level
 * failures. See .kiro/research/codex-output-format-parity.md.
 */
function producedStructuredOutput(result: DebugTurnOutcome | null): boolean {
  return result?.error == null && result?.structuredOutput != null;
}

export function resolveDebugFinalization(input: {
  debugMode: RuntimeDebugModeState;
  lastResult: DebugTurnOutcome | null;
  lastError: string | null;
}): DebugFinalization {
  const { debugMode, lastResult, lastError } = input;

  const failed = (): DebugFinalization => ({
    kind: "turn_failed",
    debugMode: { ...debugMode, lastTurnFailed: true },
    lastError:
      lastError ??
      lastResult?.error ??
      "Turn did not produce a valid structured response",
  });

  switch (debugMode.phase) {
    case "hypothesizing": {
      if (!producedStructuredOutput(lastResult)) return failed();
      const parsed = debugHypothesisOutputZodSchema.safeParse(
        lastResult?.structuredOutput,
      );
      const payload = parsed.success ? parsed.data : undefined;
      return {
        kind: "advance",
        debugMode: {
          ...debugMode,
          phase: "awaiting_reproduction",
          instructionsDelivered: true,
          hypotheses: payload?.hypotheses ?? debugMode.hypotheses,
          reproductionSteps:
            payload?.reproductionSteps ?? debugMode.reproductionSteps,
        },
      };
    }

    case "analyzing_evidence": {
      if (!producedStructuredOutput(lastResult)) return failed();
      const parsed = debugEvidenceAnalysisSchema.safeParse(
        lastResult?.structuredOutput,
      );
      if (!parsed.success) return failed();
      if (parsed.data.outcome === "fix_applied") {
        return {
          kind: "advance",
          debugMode: {
            ...debugMode,
            phase: "awaiting_verification",
            fixSummary: parsed.data.fixSummary ?? debugMode.fixSummary,
            verificationSteps:
              parsed.data.verificationSteps ?? debugMode.verificationSteps,
          },
        };
      }
      // more_instrumentation: fresh hypothesis set; returning to
      // evidence-gathering invalidates any prior fix attempt, so stale fix
      // data must not leak into the next awaitingVerification cycle.
      return {
        kind: "advance",
        debugMode: {
          ...debugMode,
          phase: "awaiting_reproduction",
          hypotheses: parsed.data.hypotheses ?? debugMode.hypotheses,
          reproductionSteps:
            parsed.data.reproductionSteps ?? debugMode.reproductionSteps,
          fixSummary: null,
          verificationSteps: [],
        },
      };
    }

    case "cleanup_instrumentation": {
      if (!producedStructuredOutput(lastResult)) return failed();
      // Each cleanup turn owns one verification attempt: bumping the counter
      // here invalidates any still-pending verification from a superseded
      // cleanup turn (the reducer rejects its stale result command).
      return {
        kind: "verify_cleanup",
        debugMode: {
          ...debugMode,
          cleanupVerificationAttempt:
            (debugMode.cleanupVerificationAttempt ?? 0) + 1,
        },
      };
    }

    // Waiting phases never produce structuredOutput (no schema), so they are
    // not gated: any follow-up settles back to the same phase.
    case "awaiting_reproduction":
    case "awaiting_verification":
      return { kind: "followup_settled", debugMode };
  }
}
