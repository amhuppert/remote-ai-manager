import { LINT_MESSAGE_PREFIX } from "@/lib/workflows/plan-lints";
import type { WorkflowPlanIssue } from "@/lib/workflows/plan-validation";

/**
 * The warnings a catalog plan is held to: everything except the semantic
 * authoring lints (#69 change 6).
 *
 * A pattern plan must carry no STRUCTURAL warning — an unrouted guard enum
 * value in a shipped template is a defect nobody should copy. The semantic
 * lints are prose judgments with a known false-positive class: a catalog
 * criterion that names its inventory in the same sentence ("names every reader
 * — context-read-runtime, context-read-tests, context-read-docs") still trips
 * the open-quantifier lint. They are advisory by design, and the catalog's
 * wording answers to the pattern it teaches rather than to a heuristic.
 *
 * The prefix is imported rather than spelled here: it is the lint module's
 * published contract, so the two cannot drift into a filter that silently
 * swallows a structural warning or fails a catalog plan over an advisory one.
 *
 * Test-support only; not imported by production code.
 */
export function structuralWarningsOf(
  warnings: readonly WorkflowPlanIssue[],
): WorkflowPlanIssue[] {
  return warnings.filter(
    (warning) => !warning.message.startsWith(LINT_MESSAGE_PREFIX),
  );
}
