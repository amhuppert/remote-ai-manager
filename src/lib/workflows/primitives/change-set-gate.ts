/**
 * Change-set gate for the workflow primitive layer.
 *
 * Decides whether the lane's recent execution produced (or avoided producing)
 * a change in the session worktree, and surfaces the decision through the
 * shared `GateResult` vocabulary. The two expectations cover the canonical
 * cases:
 *
 *  - `required` — the lane was supposed to make a change. An empty change set
 *    fails the gate with a "no-op" reason so the owning workflow can iterate
 *    or abort.
 *  - `forbidden` — the lane was supposed to be read-only. A non-empty change
 *    set fails the gate so the workflow can flag accidental writes.
 *
 * The gate is intentionally tiny: detecting whether the worktree changed is
 * the caller's responsibility (e.g. via `hasUncommittedChanges` on a git
 * helper). This module simply normalizes the resulting boolean against the
 * declared expectation.
 */

import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

type ChangeSetExpectation = "required" | "forbidden";

export interface RunChangeSetGateInput {
  hasChanges: boolean;
  expectation: ChangeSetExpectation;
}

export type ChangeSetGateResult = GatePassResult | GateFailResult;

export function runChangeSetGate(
  input: RunChangeSetGateInput,
): ChangeSetGateResult {
  const { hasChanges, expectation } = input;

  if (expectation === "required" && !hasChanges) {
    return gateFail({
      kind: "change_set",
      reason:
        "no changes detected; the lane was expected to modify the worktree",
      details: { expectation, hasChanges },
    });
  }

  if (expectation === "forbidden" && hasChanges) {
    return gateFail({
      kind: "change_set",
      reason:
        "unexpected changes detected; the lane was expected to be read-only",
      details: { expectation, hasChanges },
    });
  }

  return gatePass({
    kind: "change_set",
    details: { expectation, hasChanges },
  });
}
