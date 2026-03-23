"use client";

import {
  useDebugModeToggleMutation,
  useDebugPhaseMutation,
} from "@/lib/mutations";
import type { ConversationState } from "@/types";

interface DebugActionCardProps {
  projectName: string;
  sessionName: string;
  conversation: ConversationState;
  /** Called to send a predefined prompt to the agent */
  onSendPrompt: (text: string) => void;
  /** Whether the conversation is currently busy (running) */
  isBusy: boolean;
}

const MARK_REPRODUCED_PROMPT = `The bug has been reproduced. The debug logs have been collected.
Read the debug log file and analyze the runtime evidence to identify the root cause.
Based on your analysis, determine which hypotheses are supported or refuted by the logs, then implement the minimal fix justified by the evidence.

IMPORTANT: Do NOT remove any debug instrumentation. Keep all logging in place — instrumentation will only be cleaned up after the fix is verified via "Mark Fix".
After implementing the fix, return structured verification steps.`;

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
    onSendPrompt(MARK_REPRODUCED_PROMPT);
  };

  const handleMarkFix = async () => {
    await phaseMutation.mutateAsync("mark_fix_verified");
    onSendPrompt(MARK_FIX_PROMPT);
  };

  const handleExit = () => {
    toggleMutation.mutate("exit");
  };

  // Phase-aware button visibility
  const showMarkReproduced =
    phase === "awaiting_reproduction" || phase === "awaiting_verification";
  const showMarkFix = phase === "awaiting_verification";

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
          {showMarkReproduced && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => void handleMarkReproduced()}
              disabled={isBusy || anyPending}
            >
              Mark Reproduced
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
