import type { WorkflowSemanticDefinition } from "@/lib/workflows/schemas";

import { mapScannedFields } from "./parameter-validation";

// The ONLY token grammar substitution recognizes — identical to the accept-time
// lint's `{{inputs.<name>}}` grammar (name class `[A-Za-z0-9_-]+`, no internal
// whitespace). `g` so a single `String.prototype.replace` pass replaces every
// occurrence in a field.
const TOKEN_RE = /\{\{inputs\.([A-Za-z0-9_-]+)\}\}/g;

/**
 * Pure deterministic substitution over the closed scanned-field surface (content
 * fields + every agent-rendered charter text field) — read from the shared
 * `mapScannedFields` traversal, never enumerated locally — turning a raw
 * definition + validated bound inputs into a concrete definition. IDs, task
 * order, edges, charter structural fields, and all command/config fields are
 * copied through untouched (guaranteed by `mapScannedFields`).
 *
 * SINGLE SIMULTANEOUS PASS, VERBATIM (R4.7, R5.5): each field is rewritten by ONE
 * `String.prototype.replace(TOKEN_RE, ...)`. `.replace` does not re-scan the text
 * it inserts, so a bound value that itself contains a literal `{{...}}` — even a
 * literal `{{inputs.<name>}}` — is inserted as-is and is NEVER re-substituted or
 * re-scanned. There is intentionally no loop-until-stable and no second pass.
 *
 * RESIDUAL-PLACEHOLDER CHECK (R4.7): correctness requires asserting every TEMPLATE
 * placeholder was replaced WITHOUT false-positiving on a `{{...}}` that came from
 * a bound VALUE. So the output is NOT re-scanned for `{{inputs.}}` (that would
 * wrongly flag a value-injected literal token, violating R5.5). Instead, the
 * single replace pass itself detects any referenced `<name>` with no binding and,
 * if any template reference was unbound, throws — failing closed. Accept-time lint
 * normally prevents an unbound reference reaching here, but the function must not
 * silently emit a residual `{{inputs.<name>}}`.
 */
export function substituteContent(
  definition: WorkflowSemanticDefinition,
  boundInputs: Record<string, string>,
): WorkflowSemanticDefinition {
  const unboundReferences = new Set<string>();

  const result = mapScannedFields(definition, (value) =>
    value.replace(TOKEN_RE, (match, name: string) => {
      if (!(name in boundInputs)) {
        unboundReferences.add(name);
        // Leave the token intact; the throw below aborts before it escapes.
        return match;
      }
      // Insert the bound value verbatim — `.replace` does not re-scan it.
      return boundInputs[name] ?? "";
    }),
  );

  if (unboundReferences.size > 0) {
    const names = [...unboundReferences].sort().join(", ");
    throw new Error(
      `Substitution failed: template references unbound parameter(s) ${names}; every referenced parameter must have a bound input value`,
    );
  }

  return result;
}
