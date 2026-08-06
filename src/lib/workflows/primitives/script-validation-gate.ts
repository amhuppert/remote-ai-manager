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
      timedOut: boolean;
      /**
       * Present when the runner persisted the failing output as a log
       * artifact (the graph script validator). The merge/commit fix loop
       * surfaces the output through its thrown loop error instead and omits
       * these fields.
       */
      logFilePath?: string;
      logRelativePath?: string;
    }
  | {
      kind: "infra_error";
      reason: "exception";
      message: string;
    }
  | {
      kind: "infra_error";
      reason: "unknown_command";
      commandName: string;
      message: string;
    };

export type ScriptValidationGateResult = GatePassResult | GateFailResult;

export function scriptValidationGateFromOutcome(
  outcome: Exclude<ScriptValidationOutcome, { kind: "pass" }>,
): GateFailResult;
export function scriptValidationGateFromOutcome(
  outcome: ScriptValidationOutcome,
): ScriptValidationGateResult;
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
        timedOut: outcome.timedOut,
        ...(outcome.logFilePath !== undefined
          ? { logFilePath: outcome.logFilePath }
          : {}),
        ...(outcome.logRelativePath !== undefined
          ? { logRelativePath: outcome.logRelativePath }
          : {}),
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
