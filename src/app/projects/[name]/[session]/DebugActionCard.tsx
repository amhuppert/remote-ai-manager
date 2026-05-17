"use client";

/**
 * Atomic phase + prompt dispatch (Strategy B — client-side rollback wrapper).
 *
 * Two phase-advancing handler families exist:
 *   - Mark Reproduced (from awaiting_reproduction → analyzing_evidence)
 *   - Mark Fixed / Mark Fix Failed (both from awaiting_verification)
 *
 * Each handler advances the conversation's debug phase via `phaseMutation`
 * and then sends a phase-specific prompt via `onSendPrompt`. If the prompt
 * send fails after the phase has advanced, the conversation would otherwise
 * be stranded in a phase that no longer matches what the user has actually
 * requested. To prevent that, the handlers wrap the prompt send in a
 * try/catch and dispatch an inverse phase action
 * (`revert_to_awaiting_reproduction` / `revert_to_awaiting_verification`).
 *
 * `onSendPrompt` must reject when the underlying POST /prompt fails (HTTP
 * non-OK or fetch transport error) — see `useSendPrompt` in
 * `src/hooks/use-send-prompt.ts`.
 */

import { memo } from "react";
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

Read the debug log file using the Read tool to inspect the runtime evidence captured during reproduction. Analyze the evidence against the hypotheses you posed earlier and classify each one as supported, refuted, or inconclusive based strictly on what the logs show.

Then choose ONE of two outcomes based on whether the evidence is sufficient to justify a fix:

(a) If at least one hypothesis is well-supported and the rest are refuted or inconclusive AND the evidence is sufficient to commit to a minimal fix, IMPLEMENT THE MINIMAL FIX IN THIS SAME TURN. Do NOT remove any debug instrumentation — cleanup happens later when the user clicks "Mark Fixed".

(b) If the evidence is inconclusive or insufficient, EXTEND THE HYPOTHESIS SET and add fresh debug instrumentation (with @debug-probe markers, updating .debug/instrumentation.json) in this same turn so the user can re-execute the reproduction.

Return your work as JSON matching the configured schema. Either:
- outcome:"fix_applied" with supportedHypotheses, refutedHypotheses, inconclusiveHypotheses, evidenceSummary, fixSummary, and verificationSteps; OR
- outcome:"more_instrumentation" with supportedHypotheses, refutedHypotheses, inconclusiveHypotheses, evidenceSummary, the extended hypotheses array (each with id, description, instrumentationPlan), and reproductionSteps the user should re-execute.`;

const MARK_FIXED_PROMPT = `The fix has been verified and the bug is resolved.
Remove ALL debug instrumentation you added (logging statements, fetch calls to the debug log API, etc.) and clean up the codebase. Do not leave any debugging code behind.`;

function buildReHypothesizePrompt(fixSummary: string | null): string {
  const recap =
    fixSummary && fixSummary.trim().length > 0
      ? `\n\nThe fix you previously applied was: "${fixSummary.trim()}". Treat that attempt as refuted.`
      : "";
  return `The fix you previously applied did NOT actually resolve the bug.${recap}

Form a fresh set of 3-5 hypotheses (labeled H1, H2, …) about why the bug persists. For each hypothesis, add the minimum @debug-probe instrumentation needed to test it (updating .debug/instrumentation.json with every probe). Provide reproduction steps so the user can re-run the scenario and capture new evidence.

Return your work as JSON matching the hypothesis schema (debugHypothesisOutputSchema): \`hypotheses\` (array of objects with \`id\`, \`description\`, \`instrumentationPlan\`) and \`reproductionSteps\` (string[] of imperative actions, at least 2 entries).`;
}

function DebugActionCard({
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

  const handleMarkFix = async () => {
    await phaseMutation.mutateAsync("mark_fix_verified");
    try {
      await onSendPrompt(MARK_FIXED_PROMPT);
    } catch {
      await phaseMutation.mutateAsync("revert_to_awaiting_verification");
    }
  };

  const handleMarkFixFailed = async () => {
    const prompt = buildReHypothesizePrompt(debugMode.fixSummary ?? null);
    await phaseMutation.mutateAsync("mark_fix_failed");
    try {
      await onSendPrompt(prompt);
    } catch {
      // Inverse rollback: undo the awaiting_verification → hypothesizing
      // advance so the conversation isn't stranded if prompt send fails.
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
  const showMarkFixed = !lastTurnFailed && phase === "awaiting_verification";
  const showMarkFixFailed =
    !lastTurnFailed && phase === "awaiting_verification";

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
          {showMarkFixed && (
            <button
              className="btn btn-sm btn-success"
              onClick={() => void handleMarkFix()}
              disabled={isBusy || anyPending}
            >
              Mark Fixed
            </button>
          )}
          {showMarkFixFailed && (
            <button
              className="btn btn-sm btn-warning"
              onClick={() => void handleMarkFixFailed()}
              disabled={isBusy || anyPending}
            >
              Mark Fix Failed
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(DebugActionCard);
