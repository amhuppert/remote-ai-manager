import { summarizeOutputSchemaShape } from "@/lib/workflow-graph/context-outputs";
import type { GraphWorkflowOutputSchemaShape } from "@/lib/workflow-graph/context-outputs";

/**
 * The one presence line both workflow outline renderers print for a context
 * that declares an `outputSchema` (R7.2): `output schema: object · 4 fields`.
 *
 * The SHAPE is computed by the same pure summarizer the server projection uses
 * (`summarizeOutputSchemaShape`), so the saved outline — which the CLI renders
 * from the definition record itself — and the live outline — where the shape
 * arrives already computed on the row — can never disagree about what "4 fields"
 * counts. Only the wording lives here.
 */

export type OutputSchemaShape = GraphWorkflowOutputSchemaShape;

export { summarizeOutputSchemaShape };

/**
 * `output schema: object · 4 fields`, degrading to whichever half is known. A
 * declaration with neither a string root `type` nor a `properties` map still
 * reports `declared` — the point of the line is that a contract EXISTS, and an
 * empty summary would read as "none".
 */
export function formatOutputSchemaShape(shape: {
  type?: string | null;
  fieldCount?: number | null;
}): string {
  const parts: string[] = [];
  if (typeof shape.type === "string") parts.push(shape.type);
  if (typeof shape.fieldCount === "number") {
    parts.push(`${shape.fieldCount} field${shape.fieldCount === 1 ? "" : "s"}`);
  }
  return `output schema: ${parts.length > 0 ? parts.join(" · ") : "declared"}`;
}
