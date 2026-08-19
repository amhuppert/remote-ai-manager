import { createGraphPlanReviewsRepo } from "@/lib/state-store/graph-plan-reviews-repo";
import { getStateDb } from "@/lib/state-store/store";

import { createPlanReviewService, type PlanReviewService } from "./service";

let cached: PlanReviewService | null = null;

/**
 * The one production plan-review service, shared by the review routes and by
 * the create/replace advisory. Built lazily because `getStateDb()` opens the
 * live database, and a module-load call would run during the Next.js build,
 * before migrations.
 */
export function defaultPlanReviewService(): PlanReviewService {
  cached ??= createPlanReviewService(createGraphPlanReviewsRepo(getStateDb()));
  return cached;
}
