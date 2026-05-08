"use client";

/**
 * Atomic phase + prompt dispatch (Strategy B — client-side rollback wrapper).
 *
 * Mark Reproduced and Mark Fix advance the conversation's debug phase via
 * `phaseMutation` and then send a phase-specific prompt via `onSendPrompt`.
 * If the prompt send fails after the phase has advanced, the conversation
 * would otherwise be stranded in a phase that no longer matches what the
 * user has actually requested. To prevent that, the handlers wrap the
 * prompt send in a try/catch and dispatch an inverse phase action
 * (`revert_to_awaiting_reproduction` / `revert_to_awaiting_verification`)
 * before rethrowing.
 *
 * `onSendPrompt` must reject when the underlying POST /prompt fails (HTTP
 * non-OK or fetch transport error) — see `useSendPrompt` in
 * `src/hooks/use-send-prompt.ts`.
 */

import {
  useDebugModeToggleMutation,
  useDebugPhaseMutation,
} from "@/lib/mutations";
import type { ConversationState } from "@/types";

interface DebugActionCardProps {
  projectName: string;
  sessionName: string;
  conversation: ConversationState;
  /**
   * Called to send a predefined prompt to the agent. Must resolve when the
   * prompt has been accepted by the server and reject if the underlying
   * fetch fails (HTTP non-OK or transport error). Rejection triggers the
   * Strategy B phase rollback above.
   */
  onSendPrompt: (text: string) => Promise<void>;
  /** Whether the conversation is currently busy (running) */
  isBusy: boolean;
}

const MARK_REPRODUCED_PROMPT = `The bug has been reproduced. The debug logs have been collected.

Read the debug log file using the Read tool to inspect the runtime evidence captured during reproduction. Then analyze the evidence against the hypotheses you posed earlier and classify each one as supported, refuted, or inconclusive based strictly on what the logs show. Recommend whether to proceed to a fix or run another instrumentation pass.

Do NOT implement a fix in this turn — applying the fix is a separate user action you will be prompted for next.

Return your analysis as JSON matching the configured schema: supportedHypotheses, refutedHypotheses, inconclusiveHypotheses, recommendedNextStep ("fix" or "more_instrumentation"), and evidenceSummary.`;

const APPLY_FIX_PROMPT = `Implement the minimal fix justified by the prior evidence analysis.

Do NOT remove any debug instrumentation in this turn — cleanup happens later when the user clicks "Mark Fix".

Return your work as JSON matching the configured schema: fixSummary and verificationSteps.`;

const MARK_FIX_PROMPT = `The fix has been verified and the bug is resolved.
Remove ALL debug instrumentation you added (logging statements, fetch calls to the debug log API, etc.) and clean up the codebase. Do not leave any debugging code behind.`;

export default function DebugActionCard({
  projectName,
  sessionName,
  conversation,
  onSendPrompt,
  isBusy,
}: DebugActionCardProps): React.JSX.Element | null {
  const toggleMutation = useDebugModeToggleMutation(
    projectName,
    sessionName,
    conversation.id,
  );

  const phaseMutation = useDebugPhaseMutation(
    projectName,
    sessionName,
    conversation.id,
  );

  const debugMode = conversation.debugMode;

  // Only show when debug mode is active AND agent is awaiting (finished responding)
  if (!debugMode?.active) return null;
  if (conversation.status !== "awaiting") return null;

  const phase = debugMode.phase;
  const anyPending = toggleMutation.isPending || phaseMutation.isPending;

  const handleMarkReproduced = async () => {
    await phaseMutation.mutateAsync("mark_reproduced");
    try {
      await onSendPrompt(MARK_REPRODUCED_PROMPT);
    } catch {
      // `useSendPrompt` already surfaced the failure to the user via
      // `failPrompt`. Our job here is just to undo the phase advance so
      // the conversation isn't stranded one step ahead of reality.
      await phaseMutation.mutateAsync("revert_to_awaiting_reproduction");
    }
  };

  const handleApplyFix = async () => {
    // Apply Fix does NOT advance the phase — `finalizingTurn` does that on
    // a successful turn. So there's nothing to roll back if the prompt
    // send fails; `useSendPrompt` already surfaces the error to the user.
    try {
      await onSendPrompt(APPLY_FIX_PROMPT);
    } catch {
      /* surfaced by useSendPrompt */
    }
  };

  const handleMarkFix = async () => {
    await phaseMutation.mutateAsync("mark_fix_verified");
    try {
      await onSendPrompt(MARK_FIX_PROMPT);
    } catch {
      await phaseMutation.mutateAsync("revert_to_awaiting_verification");
    }
  };

  const handleExit = () => {
    toggleMutation.mutate("exit");
  };

  // When the last debug turn failed the conversation is parked in `debug.error`.
  // The only valid action there is RETRY_DEBUG_TURN — phase advancement buttons
  // would dispatch invalid events, so they're hidden until retry succeeds.
  const lastTurnFailed = debugMode.lastTurnFailed === true;
  const showMarkReproduced =
    !lastTurnFailed && phase === "awaiting_reproduction";
  const showApplyFix = !lastTurnFailed && phase === "fixing";
  const showMarkFix = !lastTurnFailed && phase === "awaiting_verification";

  const handleRetry = () => {
    phaseMutation.mutate("retry_turn");
  };

  return (
    <div className="debug-action-card">
      <div className="debug-action-card__actions">
        <button
          className="btn btn-sm btn-ghost"
          onClick={handleExit}
          disabled={anyPending}
        >
          Exit Debug
        </button>
        <div className="debug-action-card__primary">
          {lastTurnFailed && (
            <button
              className="btn btn-sm btn-warning"
              onClick={handleRetry}
              disabled={isBusy || anyPending}
            >
              Retry
            </button>
          )}
          {showMarkReproduced && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => void handleMarkReproduced()}
              disabled={isBusy || anyPending}
            >
              Mark Reproduced
            </button>
          )}
          {showApplyFix && (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void handleApplyFix()}
              disabled={isBusy || anyPending}
            >
              Apply Fix
            </button>
          )}
          {showMarkFix && (
            <button
              className="btn btn-sm btn-success"
              onClick={() => void handleMarkFix()}
              disabled={isBusy || anyPending}
            >
              Mark Fix
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
