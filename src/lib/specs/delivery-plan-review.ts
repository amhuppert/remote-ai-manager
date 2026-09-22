import { z } from "zod";

import { elementHandleInSnapshot } from "./revision-handles";
import { deliveryPlanCriterionDispositionSchema } from "./delivery-plan";
import type { ActorProvenance, SpecRevisionSnapshot } from "./schemas";
import {
  deliveryPlanViewSchema,
  type DeliveryPlanView,
} from "./delivery-plan-views";

export const deliveryPlanReviewCriterionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    text: z.string(),
    disposition: deliveryPlanCriterionDispositionSchema.nullable(),
    deliveredByExecutionId: z.string().min(1).nullable(),
    accountabilitySourceIds: z.array(z.string().min(1)),
  })
  .strict();

export const deliveryPlanReviewCommentSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    body: z.string().min(1),
    author: z
      .object({ kind: z.enum(["human", "agent", "system"]) })
      .passthrough(),
    createdAt: z.string().min(1),
    orphaned: z.boolean(),
  })
  .strict();

export const deliveryPlanReviewViewSchema = deliveryPlanViewSchema
  .extend({
    criteria: z.array(deliveryPlanReviewCriterionSchema),
    comments: z.array(deliveryPlanReviewCommentSchema),
  })
  .strict();
export type DeliveryPlanReviewView = z.infer<
  typeof deliveryPlanReviewViewSchema
>;

export interface DeliveryPlanReviewStoredComment {
  id: string;
  contextId: string;
  body: string;
  author: ActorProvenance;
  createdAt: string;
}

export function deliveryPlanReviewView(input: {
  plan: DeliveryPlanView;
  pinned: SpecRevisionSnapshot;
  comments: readonly DeliveryPlanReviewStoredComment[];
}): DeliveryPlanReviewView {
  const dispositions = new Map(
    input.plan.document.binding.dispositions.map((entry) => [
      entry.criterionElementId,
      entry,
    ]),
  );
  const owners = new Map<string, string[]>();
  for (const claim of input.plan.claims) {
    for (const criterionElementId of claim.criterionElementIds) {
      owners.set(criterionElementId, [
        ...(owners.get(criterionElementId) ?? []),
        claim.contextId,
      ]);
    }
  }
  const sourceIds = new Set(input.plan.claims.map((claim) => claim.contextId));
  return {
    ...input.plan,
    criteria: input.pinned.elements.flatMap(({ element, version }) =>
      version.payload.kind !== "criterion"
        ? []
        : [
            {
              criterionElementId: element.id,
              handle:
                elementHandleInSnapshot(input.pinned, element.id) ?? element.id,
              text: version.payload.text,
              disposition: dispositions.get(element.id)?.disposition ?? null,
              deliveredByExecutionId:
                dispositions.get(element.id)?.deliveredByExecutionId ?? null,
              accountabilitySourceIds: owners.get(element.id) ?? [],
            },
          ],
    ),
    comments: input.comments.map((comment) => ({
      ...comment,
      orphaned: !sourceIds.has(comment.contextId),
    })),
  };
}
