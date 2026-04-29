/**
 * Human-approval gate for the workflow primitive layer.
 *
 * Surfaces an explicit between-step approval as a shared `GateResult`. Per
 * the gate-vocabulary invariant, a human-approval gate pause is always
 * `pauseKind: "post_turn"` — the previous step finished and the workflow is
 * blocked until a human releases the next step.
 *
 * The three helpers correspond to the three lifecycle states for an approval:
 *  - `pauseForHumanApproval(...)` parks the workflow and returns the resume
 *    token a UI/CLI uses to attach an inspection hold.
 *  - `approveHumanApprovalGate(...)` releases the hold with `pass`.
 *  - `rejectHumanApprovalGate(reason)` halts the workflow with `fail` and
 *    the rejection reason verbatim.
 */

import {
  gateFail,
  gatePass,
  gatePausePostTurn,
  type GateFailResult,
  type GatePassResult,
  type GatePauseResult,
} from "./gate-vocabulary";

export interface PauseForHumanApprovalInput {
  resumeToken: string;
  details?: Record<string, unknown>;
}

export function pauseForHumanApproval(
  input: PauseForHumanApprovalInput,
): GatePauseResult {
  return gatePausePostTurn({
    kind: "human_approval",
    resumeToken: input.resumeToken,
    ...(input.details !== undefined ? { details: input.details } : {}),
  });
}

export function approveHumanApprovalGate(
  details?: Record<string, unknown>,
): GatePassResult {
  return gatePass({
    kind: "human_approval",
    ...(details !== undefined ? { details } : {}),
  });
}

export function rejectHumanApprovalGate(
  reason: string,
  details?: Record<string, unknown>,
): GateFailResult {
  return gateFail({
    kind: "human_approval",
    reason,
    ...(details !== undefined ? { details } : {}),
  });
}
