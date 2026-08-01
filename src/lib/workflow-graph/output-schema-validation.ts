import type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";
// The dependency-free subset module, NOT the gate that re-exports it: this file
// is reached from `validation.ts`, which a `"use client"` builder component
// imports. Going through the gate would drag the Node-backed logger into the
// browser bundle — a failure only `bun run build` catches.
import { validateOutputSchemaDeclaration } from "@/lib/workflows/primitives/output-schema-subset";

/**
 * The shape both tiers share: an authored context definition and a resolved
 * context both carry `id` plus the optional authored `outputSchema` document, so
 * one validator serves the authored accept paths (validate/create/replace,
 * saved-tier edits) and the live tier (working-definition edits, seed-time
 * re-validation) without a second traversal.
 */
interface OutputSchemaBearingContext {
  readonly id: string;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

/**
 * Accept-time SHAPE validation for declared per-context output schemas. Collects
 * every violation (does not short-circuit) in declaration order, returning
 * graph-validation-shaped errors so it composes with `validateWorkflowDefinition`
 * at the same choke point every definition mutation rides.
 *
 * The supported-keyword subset and its guidance messages come from
 * `validateOutputSchemaDeclaration` in the structured-output gate module — the
 * same export the schema editor's client-side lint reads — so a refusal here and
 * an error in the editor can never describe different rules (D2).
 *
 * Each error carries the context id AND a definition-relative `field` locator
 * (`executionContexts[<index>].outputSchema.<schema path>`) naming the exact
 * offending keyword, which the CLI/route locator machinery renders directly.
 */
export function validateContextOutputSchemas(
  contexts: readonly OutputSchemaBearingContext[],
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];

  contexts.forEach((context, index) => {
    if (context.outputSchema === undefined) return;
    const base = `executionContexts[${index}].outputSchema`;
    for (const issue of validateOutputSchemaDeclaration(context.outputSchema)) {
      errors.push({
        code: "unsupported-output-schema",
        message: `Context "${context.id}" outputSchema: ${issue.message}`,
        contextId: context.id,
        // The walker roots its paths at `$`; swapping that root for the
        // definition-relative prefix yields one locator naming both the context
        // and the schema path.
        field: `${base}${issue.path.slice("$".length)}`,
      });
    }
  });

  return errors;
}
