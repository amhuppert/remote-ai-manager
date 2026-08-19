import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

import { graphPlanReviewSchema, type GraphPlanReview } from "./schemas";

// ============================================================
// Plan review record and lookup (#69 change 5)
//
// The read side of an advisory mechanism: a revision nobody reviewed answers
// `null`, and `null` is an ordinary answer here, not a failure. Consumers ask
// this before create/replace to say what is known about the submitted bytes —
// they never require it to say anything.
//
// So the lookup fails OPEN. A corrupt row, a missing table, any store failure
// answers "unreviewed" and logs, because the alternative is an advisory record
// that can refuse a create — a new way for an execution to fail, which is the
// one thing this program is not allowed to add.
// ============================================================

const logger = createLogger("workflows.plan-review");

/**
 * The persistence seam. Method syntax so the real state-store repository
 * satisfies it structurally: the workflows domain states what it needs and the
 * dependency edge points inward, rather than importing a repository type.
 */
export interface PlanReviewStore {
  record(review: GraphPlanReview): void;
  listByDefinitionHash(definitionHash: string): GraphPlanReview[];
}

/**
 * The read half, for consumers that consult a verdict but never record one —
 * create/replace's advisory line, and anything downstream that must not be able
 * to write through a dependency it was handed for reading.
 */
export type PlanReviewLookup = Pick<
  PlanReviewService,
  "findLatestTerminalReview"
>;

export interface PlanReviewService {
  /**
   * Persist one concluded review. An identical replay converges; a reused id
   * carrying different content leaves the stored verdict standing, so each
   * concluded review needs its own id.
   */
  recordPlanReview(review: GraphPlanReview): void;
  /**
   * The most recent terminal review of that EXACT revision, or null when the
   * revision carries none — and also null, with a warn log, when the store
   * cannot answer at all.
   */
  findLatestTerminalReview(definitionHash: string): GraphPlanReview | null;
}

/**
 * Compare by instant rather than by string. `reviewedAt` values are ISO
 * timestamps of varying precision, and text order inverts across that
 * boundary: `…T12:00:00Z` sorts after `…T12:00:00.500Z` because 'Z' > '.',
 * which would name the earlier review the latest one.
 */
function instantOf(review: GraphPlanReview): number {
  return Date.parse(review.reviewedAt);
}

/**
 * `log` is injectable because the warn on a failed lookup is the ONLY trace a
 * fail-open path leaves: the caller is handed the same `null` an unreviewed
 * revision produces, so without the log a broken store is indistinguishable
 * from an unreviewed plan — and a behavior with no observable effect cannot be
 * held in place by a test.
 */
export function createPlanReviewService(
  reviews: PlanReviewStore,
  log: Logger = logger,
): PlanReviewService {
  return {
    recordPlanReview(review) {
      // Parse at the boundary: a verdict whose findings artifact is missing is
      // the exact shape this record exists to make unrepresentable, and it must
      // not reach durable state through a caller that skipped the schema.
      reviews.record(graphPlanReviewSchema.parse(review));
    },
    findLatestTerminalReview(definitionHash) {
      let recorded: GraphPlanReview[];
      try {
        recorded = reviews.listByDefinitionHash(definitionHash);
      } catch (err) {
        log.warn("workflows.plan-review.lookup_failed", {
          definitionHash,
          error: getErrorMessage(err),
        });
        return null;
      }
      let latest: GraphPlanReview | null = null;
      for (const review of recorded) {
        // `>=` lets a later entry win an exact tie, so the store's own ordering
        // settles two reviews stamped the same instant.
        if (latest === null || instantOf(review) >= instantOf(latest)) {
          latest = review;
        }
      }
      return latest;
    },
  };
}
