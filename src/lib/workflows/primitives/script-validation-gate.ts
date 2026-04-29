/**
 * Script-validation gate for the workflow primitive layer.
 *
 * Projects a script-validator outcome (pass / validation failure / infra
 * error) onto the shared `GateResult` vocabulary so workflows that run an
 * external validation command (lint, typecheck, build, tests) consume the
 * same envelope as every other gate.
 *
 * Two failure classes are surfaced via `details.failureClass` so an owning
 * workflow can decide whether to retry or halt:
 *  - `validation_failed` — the script ran and reported failures. Workflows
 *    typically reopen tasks for the implementer to fix and re-run.
 *  - `infrastructure` — the script could not run (missing command, spawn
 *    error, etc). Workflows typically halt or surface to a human; retrying
 *    is unlikely to help without a configuration change.
 */

import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

export type ScriptValidationOutcome =
  | { kind: "pass" }
  | {
      kind: "fail";
      summary: string;
      logFilePath: string;
      logRelativePath: string;
      timedOut: boolean;
    }
  | {
      kind: "infra_error";
      reason: "missing_pre_merge_command" | "exception";
      message: string;
    };

export type ScriptValidationGateResult = GatePassResult | GateFailResult;

export function scriptValidationGateFromOutcome(
  outcome: ScriptValidationOutcome,
): ScriptValidationGateResult {
  if (outcome.kind === "pass") {
    return gatePass({ kind: "script_validation" });
  }

  if (outcome.kind === "fail") {
    return gateFail({
      kind: "script_validation",
      reason: outcome.summary,
      details: {
        failureClass: "validation_failed",
        logFilePath: outcome.logFilePath,
        logRelativePath: outcome.logRelativePath,
        timedOut: outcome.timedOut,
      },
    });
  }

  return gateFail({
    kind: "script_validation",
    reason: outcome.message,
    details: {
      failureClass: "infrastructure",
      infraReason: outcome.reason,
    },
  });
}
