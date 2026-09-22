/**
 * Shared structured-output validation gate for the AgentCall primitive.
 *
 * Runs after dispatch on both backends — even when a backend (e.g. Codex)
 * natively enforces the schema during generation — so the workflow layer
 * always sees a single normalized validation outcome regardless of where
 * enforcement happens.
 *
 * The validator is injected: production wires in a Zod- or AJV-backed
 * validator, tests inject a stub. The gate never throws — a thrown
 * validator turns into a `fail` outcome with a normalized reason.
 *
 * Output is a shared `GateResult` from the gate vocabulary so workflow
 * authors can treat structured-output validation identically to other
 * gate kinds (script validation, change-set, convergence, etc.).
 *
 * The subset the default validator implements — and the authoring-time
 * descriptor and walker that describe it — live in `output-schema-subset.ts`,
 * which stays dependency-free so the schema editor's client-side lint can
 * import the same source this gate runs on. They are re-exported here because
 * this is the module server callers already reach for.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  gateFail,
  gatePass,
  type GateFailResult,
  type GatePassResult,
} from "./gate-vocabulary";

// The gate is the server-side entry to the browser-safe subset module; the
// declaration validator stays reachable here for server callers (D2, R1.3).
/** @public */
export {
  validateJsonSchemaSubset,
  validateOutputSchemaDeclaration,
} from "./output-schema-subset";

const logger = createLogger("workflows.primitives.structured-output-gate");

export interface StructuredOutputValidator {
  (
    schema: Record<string, unknown>,
    value: unknown,
  ): { valid: boolean; errors?: string[] };
}

export type StructuredOutputGateResult = GatePassResult | GateFailResult;

export function runStructuredOutputGate(
  schema: Record<string, unknown>,
  value: unknown,
  validator: StructuredOutputValidator,
): StructuredOutputGateResult {
  let outcome: { valid: boolean; errors?: string[] };
  try {
    outcome = validator(schema, value);
  } catch (err) {
    const message = getErrorMessage(err);
    logger.warn("structured_output_gate.validator_threw", { message });
    return gateFail({
      kind: "structured_output",
      reason: `structured-output validator threw: ${message}`,
      details: { errors: [] },
    });
  }
  if (outcome.valid) {
    return gatePass({ kind: "structured_output" });
  }
  const errors = outcome.errors ?? [];
  const reason =
    errors.length > 0
      ? `structured output failed validation: ${errors.join("; ")}`
      : "structured output failed validation";
  return gateFail({
    kind: "structured_output",
    reason,
    details: { errors },
  });
}
