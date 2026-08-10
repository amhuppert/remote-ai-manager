import { z } from "zod";

import {
  criterionDeliveryClassSchema,
  criterionFreshnessSchema,
  type CriterionFreshness,
  type DeliveryDeltaCriterion,
} from "./delivery-delta";
import {
  deliveryPlanDispositionSchema,
  deliveryPlanReaffirmationSchema,
  type DeliveryPlanDisposition,
  type DeliveryPlanReaffirmation,
} from "./delivery-plan";
import { reaffirmationCoversBasis } from "./delivery-plan-lint";
import { actorProvenanceSchema, type ActorProvenance } from "./schemas";
import {
  deliveryPlanViewSchema,
  type DeliveryPlanView,
} from "./delivery-plan-views";

/**
 * The Studio review read-model for a `DeliveryPlanAttempt`: the plan view every
 * other surface reads, plus the one thing a reviewer cannot review without and
 * a CLI receipt has no business carrying — the pinned revision's criteria in
 * full, each resolved to its disposition, its owning context, and the read-time
 * delivery classification the dispositions table advises from.
 *
 * It extends the plan view rather than replacing it so the review surface and
 * `cctl spec plan status` can never disagree about the attempt's state
 * (`single-lint-projection`): the extra fields are resolutions of state the
 * plan view already carries, never a second computation of it.
 */

/**
 * One pinned criterion as a reviewer sees it. `disposition` is nullable because
 * the total-disposition law is what propose enforces, not what a draft
 * satisfies — an undisposed criterion is a row a reviewer must see, not a row
 * the projection may drop.
 */
export const deliveryPlanReviewCriterionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    text: z.string(),
    disposition: deliveryPlanDispositionSchema.nullable(),
    /**
     * The disposition as it reads right now. It differs from the authored one
     * in exactly one case: a `reaffirmed` criterion whose staleness basis has
     * moved since the act reads as `pending_reaffirmation` again, because the
     * human judged content nobody is now looking at. Computed at read time
     * from the immutable basis hashes, never stored.
     */
    effectiveDisposition: deliveryPlanDispositionSchema.nullable(),
    deliveredByExecutionId: z.string().min(1).nullable(),
    reaffirmation: deliveryPlanReaffirmationSchema.nullable(),
    note: z.string().nullable(),
    /** The delivery delta's read-time class; never persisted. */
    deliveryClass: criterionDeliveryClassSchema,
    /** Null when there is no earlier delivery to grade the criterion against. */
    freshness: criterionFreshnessSchema.nullable(),
    /**
     * The context that owns the criterion, resolved here because one-context
     * ownership is the rule the plan is held to — a table re-deriving it per
     * row would be a second opinion about the same law.
     */
    owningContextId: z.string().min(1).nullable(),
  })
  .strict();
export type DeliveryPlanReviewCriterion = z.infer<
  typeof deliveryPlanReviewCriterionSchema
>;

/**
 * A context-anchored review note. `orphaned` is a read-time projection over
 * the current document rather than a stored flag: the comment is durable, the
 * context lives in a document a later edit rewrites, and which of the two moved
 * is a question answered when someone asks (`computed-projections`).
 */
export const deliveryPlanReviewCommentSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    body: z.string().min(1),
    author: actorProvenanceSchema,
    createdAt: z.string().min(1),
    orphaned: z.boolean(),
  })
  .strict();
export type DeliveryPlanReviewComment = z.infer<
  typeof deliveryPlanReviewCommentSchema
>;

export const deliveryPlanReviewViewSchema = deliveryPlanViewSchema
  .extend({
    criteria: z.array(deliveryPlanReviewCriterionSchema),
    comments: z.array(deliveryPlanReviewCommentSchema),
  })
  .strict();
export type DeliveryPlanReviewView = z.infer<
  typeof deliveryPlanReviewViewSchema
>;

/** A pinned criterion's authored text, read off the revision the attempt pinned. */
export interface DeliveryPlanReviewPinnedCriterion {
  readonly criterionElementId: string;
  readonly handle: string;
  readonly text: string;
}

/** A stored comment, before the projection decides whether its anchor still exists. */
export interface DeliveryPlanReviewStoredComment {
  readonly id: string;
  readonly contextId: string;
  readonly body: string;
  readonly author: ActorProvenance;
  readonly createdAt: string;
}

export interface DeliveryPlanReviewInput {
  readonly plan: DeliveryPlanView;
  readonly pinnedCriteria: readonly DeliveryPlanReviewPinnedCriterion[];
  readonly deltaCriteria: readonly DeliveryDeltaCriterion[];
  readonly comments: readonly DeliveryPlanReviewStoredComment[];
}

/**
 * A `reaffirmed` criterion whose basis moved after the act reads as pending
 * again — the same judgment plan lint refuses on, asked through the same
 * predicate so a table and a propose refusal cannot disagree.
 */
function effectiveDisposition(
  disposition: DeliveryPlanDisposition | null,
  reaffirmation: DeliveryPlanReaffirmation | null,
  freshness: CriterionFreshness | null,
): DeliveryPlanDisposition | null {
  if (disposition !== "reaffirmed" || reaffirmation === null) {
    return disposition;
  }
  return reaffirmationCoversBasis(reaffirmation, freshness)
    ? "reaffirmed"
    : "pending_reaffirmation";
}

/**
 * Resolve the review read-model. The pinned criteria drive the row order and
 * the row set: the revision decides which criteria exist, while the plan
 * decides what it says about them.
 */
export function deliveryPlanReviewView(
  input: DeliveryPlanReviewInput,
): DeliveryPlanReviewView {
  const dispositions = new Map(
    input.plan.document.dispositions.map((entry) => [
      entry.criterionElementId,
      entry,
    ]),
  );
  const delta = new Map(
    input.deltaCriteria.map((entry) => [entry.criterionElementId, entry]),
  );
  const owners = new Map<string, string>();
  for (const context of input.plan.document.contexts) {
    for (const criterionElementId of context.criterionElementIds) {
      // First claim wins. A criterion two contexts claim is a plan lint
      // refusal, not something this projection should silently arbitrate.
      if (!owners.has(criterionElementId)) {
        owners.set(criterionElementId, context.contextId);
      }
    }
  }

  const contextIds = new Set(
    input.plan.document.contexts.map((context) => context.contextId),
  );

  return {
    ...input.plan,
    criteria: input.pinnedCriteria.map((criterion) => {
      const disposition = dispositions.get(criterion.criterionElementId);
      const classified = delta.get(criterion.criterionElementId);
      return {
        criterionElementId: criterion.criterionElementId,
        handle: criterion.handle,
        text: criterion.text,
        disposition: disposition?.disposition ?? null,
        effectiveDisposition: effectiveDisposition(
          disposition?.disposition ?? null,
          disposition?.reaffirmation ?? null,
          classified?.freshness ?? null,
        ),
        deliveredByExecutionId: disposition?.deliveredByExecutionId ?? null,
        reaffirmation: disposition?.reaffirmation ?? null,
        note: disposition?.note ?? null,
        // A pinned criterion the delta never graded has no earlier delivery to
        // compare against, which is what `never_delivered` states.
        deliveryClass: classified?.class ?? "never_delivered",
        freshness: classified?.freshness ?? null,
        owningContextId: owners.get(criterion.criterionElementId) ?? null,
      };
    }),
    comments: input.comments.map((comment) => ({
      ...comment,
      orphaned: !contextIds.has(comment.contextId),
    })),
  };
}
