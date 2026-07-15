/**
 * Debug workflow lifecycle commands.
 *
 * The debug workflow is attached to the conversation actor through the
 * `DEBUG_COMMAND` machine event: API routes call `DebugAdapter` methods,
 * the adapter maps them onto commands, and the conversation machine applies
 * them with this pure reducer. Phase legality is a legality table over
 * `(phase, lastTurnFailed)` — e.g. `mark_reproduced` only in
 * `awaiting_reproduction`; an illegal command returns `null`, the machine's
 * transition guard refuses it, and the adapter reports `false` (routes 409).
 */

import type { RuntimeDebugModeState } from "@/lib/debug-log/schemas";

export type DebugCommand =
  | { kind: "enter"; logFilePath: string; debugSessionId: string }
  | { kind: "exit" }
  | { kind: "set_recording"; recording: boolean }
  | { kind: "mark_reproduced" }
  | { kind: "mark_fix_verified" }
  | { kind: "mark_fix_failed" }
  | { kind: "revert_to_awaiting_reproduction" }
  | { kind: "revert_to_awaiting_verification" }
  /**
   * Re-runs the preserved failed turn. Handled structurally by the machine
   * (it must re-enter the turn spine), never by this reducer.
   */
  | { kind: "retry_turn" }
  /**
   * Async cleanup-verification outcome, sent back by the debug adapter.
   * `attempt` is the `cleanupVerificationAttempt` stamped when that
   * verification started; the reducer accepts the result only when it still
   * matches, so a superseded attempt's late result is ignored.
   */
  | { kind: "cleanup_verified"; debugSessionId: string; attempt: number }
  | {
      kind: "cleanup_verification_failed";
      debugSessionId: string;
      message: string;
      attempt: number;
    };

/** Context mutation + side-effect selection produced by a legal command. */
export interface DebugCommandEffect {
  debugMode: RuntimeDebugModeState | null;
  /** Set for `cleanup_verified`: the preserved cleanup turn is released. */
  clearActiveTurn?: boolean;
  /** Set for `cleanup_verification_failed`: the remediation prompt. */
  lastError?: string;
  broadcastConversationStatus?: boolean;
  broadcastDebugModeStatus?: boolean;
}

/**
 * Apply a debug lifecycle command to the current debug-mode context.
 * Returns `null` when the command is not legal in the current state
 * (wrong phase, debug inactive, or a failed-turn state that only accepts
 * retry/exit/prompt), in which case the caller must ignore the event.
 */
export function applyDebugCommand(
  current: RuntimeDebugModeState | null,
  command: DebugCommand,
  nowIso: string,
): DebugCommandEffect | null {
  if (command.kind === "enter") {
    if (current?.active) return null;
    return {
      debugMode: {
        active: true,
        recording: true,
        logFilePath: command.logFilePath,
        enteredAt: nowIso,
        hypotheses: [],
        reproductionSteps: [],
        fixSummary: null,
        verificationSteps: [],
        instructionsDelivered: false,
        phase: "hypothesizing",
        lastTurnFailed: false,
        debugSessionId: command.debugSessionId,
      },
      broadcastDebugModeStatus: true,
    };
  }

  if (!current?.active) return null;

  switch (command.kind) {
    case "exit":
      return { debugMode: null, broadcastDebugModeStatus: true };

    case "set_recording":
      return {
        debugMode: { ...current, recording: command.recording },
        broadcastDebugModeStatus: true,
      };

    case "mark_reproduced":
      if (current.lastTurnFailed || current.phase !== "awaiting_reproduction") {
        return null;
      }
      return { debugMode: { ...current, phase: "analyzing_evidence" } };

    case "mark_fix_verified":
      if (current.lastTurnFailed || current.phase !== "awaiting_verification") {
        return null;
      }
      return { debugMode: { ...current, phase: "cleanup_instrumentation" } };

    case "mark_fix_failed":
      // The user refuted the claimed fix: loop back to hypothesizing.
      // fixSummary is preserved for the re-hypothesize prompt (it references
      // the prior attempt); verificationSteps pertained to the failed fix.
      if (current.lastTurnFailed || current.phase !== "awaiting_verification") {
        return null;
      }
      return {
        debugMode: {
          ...current,
          phase: "hypothesizing",
          verificationSteps: [],
        },
      };

    case "revert_to_awaiting_reproduction":
      if (current.lastTurnFailed || current.phase !== "analyzing_evidence") {
        return null;
      }
      return { debugMode: { ...current, phase: "awaiting_reproduction" } };

    case "revert_to_awaiting_verification":
      // Strategy B client rollback: legal from cleanup_instrumentation
      // (undoes mark_fix_verified) and from hypothesizing (undoes
      // mark_fix_failed after a failed prompt send).
      if (
        current.lastTurnFailed ||
        (current.phase !== "cleanup_instrumentation" &&
          current.phase !== "hypothesizing")
      ) {
        return null;
      }
      return { debugMode: { ...current, phase: "awaiting_verification" } };

    case "cleanup_verified":
      if (current.phase !== "cleanup_instrumentation") return null;
      if (command.debugSessionId !== current.debugSessionId) return null;
      if (command.attempt !== (current.cleanupVerificationAttempt ?? 0)) {
        return null;
      }
      return {
        debugMode: null,
        clearActiveTurn: true,
        broadcastConversationStatus: true,
        broadcastDebugModeStatus: true,
      };

    case "cleanup_verification_failed":
      if (current.phase !== "cleanup_instrumentation") return null;
      if (command.debugSessionId !== current.debugSessionId) return null;
      if (command.attempt !== (current.cleanupVerificationAttempt ?? 0)) {
        return null;
      }
      return {
        debugMode: { ...current, lastTurnFailed: true },
        lastError: command.message,
        broadcastConversationStatus: true,
      };

    case "retry_turn":
      return null;
  }
}

/**
 * Clears the failed-turn flag when a turn claim replaces the failed turn:
 * the error presentation must not survive the claim.
 */
export function clearDebugTurnFailure(
  current: RuntimeDebugModeState | null,
): RuntimeDebugModeState | null {
  if (!current?.active || !current.lastTurnFailed) return current;
  return { ...current, lastTurnFailed: false };
}
