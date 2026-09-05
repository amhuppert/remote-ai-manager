import type { PlanReviewAdvisory } from "@/lib/workflows/plan-review/status-schemas";

/** One advisory line beside a save. Never an error, never an exit code. */
export function planReviewAdvisoryLine(advisory: PlanReviewAdvisory): string {
  return advisory.state === "unreviewed"
    ? "plan review: none recorded for this revision (advisory)\n"
    : `plan review: ${advisory.state} by ${advisory.reviewerConversationId} at ${advisory.reviewedAt}\n`;
}
