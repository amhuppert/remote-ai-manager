import type { ManagedDefinitionPreflightSummary } from "@/lib/workflow-graph/managed-definition-preflight";

/**
 * Both sides of what a delivery-plan draft owes, rendered identically wherever
 * it is reported (#80 design 3.3). `spec plan open`, `spec plan status`,
 * `workflow validate --definition` and `spec plan propose` all print these
 * three lines from the one server-computed summary, so a reader cannot learn a
 * different amount of coverage depending on which verb they happened to run.
 *
 * Deficit-only reporting is what these replace: a receipt that said only how
 * many dispositions were unresolved never said how many were settled, so an
 * author had no way to tell an almost-done plan from an untouched one.
 */
export function deliveryPlanLedgerLines(
  summary: ManagedDefinitionPreflightSummary,
): string[] {
  const dispositions =
    summary.dispositions.length === 0
      ? "none"
      : summary.dispositions
          .map(({ kind, count }) => `${kind} ${count}`)
          .join(", ");
  return [
    `Criteria mapping: ${summary.claimed} of ${summary.selected} selected criteria mapped, ${summary.unclaimed} unmapped`,
    `dispositions: ${dispositions}`,
    summary.charter.state === "authored"
      ? `charter: authored, ${summary.charter.invariantCount} invariants, ${summary.charter.sourceCount} sources`
      : "charter: seed stub",
  ];
}
