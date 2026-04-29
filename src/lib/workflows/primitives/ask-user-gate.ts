/**
 * Ask-user gate for the workflow primitive layer.
 *
 * Surfaces a backend's native mid-turn ask-user interruption as a shared
 * `GateResult` pause so workflows treat user-question pauses with the same
 * vocabulary as every other checkpoint. Per the gate-vocabulary invariant,
 * an ask-user gate is always `pauseKind: "mid_turn"` — an in-flight backend
 * turn is held while the answer is collected.
 *
 * Two helpers are exposed:
 *  - `pauseForAskUser(...)` constructs a paused gate result directly when a
 *    feature wants to manufacture the pause itself (for example, a deferred
 *    answer flow that surfaces the questions through a different channel).
 *  - `askUserGateFromPause(result)` projects an `AgentCall` paused outcome
 *    that originated from a mid-turn ask-user signal into the shared gate
 *    vocabulary. Returns `null` for any other AgentCall outcome shape so
 *    workflow callers can opt into the gate translation explicitly.
 */

import type { AskQuestionItem } from "@/lib/schemas";
import type { AgentCallResult } from "./agent-call-vocabulary";
import { gatePauseMidTurn, type GatePauseResult } from "./gate-vocabulary";

export interface PauseForAskUserInput {
  resumeToken: string;
  questions: readonly AskQuestionItem[];
}

export function pauseForAskUser(input: PauseForAskUserInput): GatePauseResult {
  return gatePauseMidTurn({
    kind: "ask_user",
    resumeToken: input.resumeToken,
    details: { questions: input.questions },
  });
}

export function askUserGateFromPause(
  result: AgentCallResult,
): GatePauseResult | null {
  if (result.outcome.kind !== "paused") return null;
  if (result.outcome.pauseKind !== "mid_turn") return null;
  return gatePauseMidTurn({
    kind: "ask_user",
    resumeToken: result.outcome.resumeToken,
    ...(result.outcome.details !== undefined
      ? { details: result.outcome.details }
      : {}),
  });
}
