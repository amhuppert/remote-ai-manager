import {
  graphPlanReviewSchema,
  type GraphPlanReview,
} from "@/lib/workflows/plan-review/schemas";
import type { PlanReviewLookup } from "@/lib/workflows/plan-review/service";

/**
 * The lookup for a suite that is not exercising review status: every revision
 * reads back unreviewed, which is the state that changes no behavior anywhere.
 * Handed to route handlers so no test reaches the live database to answer a
 * question it does not ask.
 */
export const unreviewedPlanReviewLookup: PlanReviewLookup = {
  findLatestTerminalReview: () => null,
};

/**
 * Test-only maximal fixture for the terminal plan-review record (#69 change 5).
 *
 * Maximal in the round-trip sense: every persisted key path carries a present,
 * non-default value. That forces `verdict: "changes_requested"`, because it is
 * the only verdict whose `findings` artifact is non-null — an approved fixture
 * would leave the column empty and the durability contract would prove nothing
 * about it.
 */
export function buildMaximalGraphPlanReview(
  overrides: Partial<GraphPlanReview> = {},
): GraphPlanReview {
  return graphPlanReviewSchema.parse({
    id: "review-7c1f0b3e-2a44-4e0d-9d51-8b6c2f0a1e73",
    definitionHash: `sha256:${"3f".repeat(32)}`,
    reviewerConversationId: "conv-8a2d41f6-91b0-4c33-b6e2-5d0f7a934c18",
    verdict: "changes_requested",
    findings:
      "Context `review-record-core` carries two unrelated outcomes; split the persistence work out before execution.",
    reviewedAt: "2026-08-18T14:23:07.512Z",
    ...overrides,
  });
}
