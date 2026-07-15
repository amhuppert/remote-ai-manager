import type { z } from "zod";

import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";

import { buildLaunchInputSchema } from "./parameter-validation";

/**
 * Start-time launch-input validation outcome. Mirrors the local discriminated
 * union idiom used by `approval-gate.ts` rather than any shared `Result` type.
 * Consumed by the shared start path (task 5.1), which logs the rejection code.
 */
export type LaunchInputError =
  | { kind: "missing_required"; name: string }
  | { kind: "invalid_value"; name: string; message: string }
  | { kind: "unknown_parameter"; name: string };

export type LaunchInputResult =
  | { ok: true; boundInputs: Record<string, string> }
  | { ok: false; error: LaunchInputError };

// Map the first Zod issue to a discriminated `LaunchInputError`. The mapping is
// deterministic by issue precedence (Zod reports issues in a stable order, and
// `buildLaunchInputSchema` produces one issue per offending field/key):
//
// - `unrecognized_keys` (from `.strict()`) → `unknown_parameter`, naming the
//   first offending key (R3.5).
// - `invalid_type` with the value at that path ABSENT (`undefined`) → a required
//   parameter that has no default was omitted → `missing_required` (R3.2/R3.3).
//   This is the carry-forward distinction from task 2.3: a required-no-default
//   omission must NOT surface as `invalid_value`. We inspect the supplied input
//   (not the issue message) so the classification is robust to message wording.
// - any other field-level issue (enum value outside options, length bound) →
//   `invalid_value` carrying the Zod message and the parameter at `issue.path[0]`
//   (R3.3).
function mapIssue(
  issue: z.core.$ZodIssue,
  supplied: Record<string, unknown>,
): LaunchInputError {
  if (issue.code === "unrecognized_keys") {
    const name = issue.keys[0];
    // `unrecognized_keys` always carries at least one key.
    return { kind: "unknown_parameter", name: name ?? "" };
  }

  const name = typeof issue.path[0] === "string" ? issue.path[0] : "";

  if (issue.code === "invalid_type" && supplied[name] === undefined) {
    return { kind: "missing_required", name };
  }

  return { kind: "invalid_value", name, message: issue.message };
}

/**
 * Validate a launch payload against a definition's declared parameters and
 * normalize it into bound inputs. Pure: no logging, no seeding, no side effects
 * (R3.2/R3.3 — nothing is seeded on rejection because nothing is seeded at all).
 *
 * On success every declared value is present (supplied or default, R3.4) and all
 * values are strings; an optional-no-default parameter that was not supplied is
 * absent from `boundInputs` (its key is genuinely missing at runtime even though
 * the parsed static type claims otherwise, so we build from `Object.entries`
 * rather than indexing by name). No redaction or secret-content inspection is
 * applied (R3.7).
 */
export function validateLaunchInputs(input: {
  parameters: ParameterDeclaration[];
  supplied: Record<string, unknown> | undefined;
}): LaunchInputResult {
  const supplied = input.supplied ?? {};
  const schema = buildLaunchInputSchema(input.parameters);
  const parsed = schema.safeParse(supplied);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue === undefined) {
      // A failed parse always carries at least one issue; treat an empty set as
      // an internal invariant violation rather than a silent success.
      throw new Error("Launch input validation failed with no issue");
    }
    return { ok: false, error: mapIssue(issue, supplied) };
  }

  const boundInputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    boundInputs[name] = value;
  }

  return { ok: true, boundInputs };
}
